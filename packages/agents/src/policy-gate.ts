/**
 * The policy gate.
 *
 * Every agent tool call that spends money, contacts a third party, publishes to
 * the public internet or touches a customer passes through here first. The gate
 * does four things in one place, so no caller can do three of them and forget
 * the fourth:
 *
 *   1. Evaluates the pure policy rules (authority, kill switches, budgets,
 *      approval thresholds) from `@foundry/core`.
 *   2. Reserves budget atomically when the action is allowed and costs money.
 *   3. Records the decision and writes an audit event.
 *   4. Opens an approval request when a human must sign off.
 *
 * A denial is returned as a value rather than thrown, because "you may not do
 * that" is information the agent should reason about and report — not an
 * exception that aborts the run.
 */

import {
  evaluatePolicy,
  capabilityAvailableForAuthority,
  toActor,
  type Authority,
  type BudgetScope,
  type Capability,
  type PolicyEvaluation,
} from './deps.js';
import type { Repositories } from '@foundry/db';
import type { ProviderRegistry } from '@foundry/providers';
import { getLogger } from '@foundry/obs';

export interface GateRequest {
  readonly companyId: string;
  /** Agent handle, e.g. `growth_manager`. Resolved to an actor row. */
  readonly actorHandle: string;
  readonly authority: Authority;
  /** Human-readable, appears in the approval request and the audit log. */
  readonly action: string;
  readonly subjectRefId?: string | null;
  readonly amountMinor?: number;
  readonly currency?: string;
  readonly budgetScope?: BudgetScope;
  /** Capability this action needs; checked against the provider registry. */
  readonly capability?: Capability;
  /** Evidence the human approver should read. */
  readonly evidenceRefs?: readonly string[];
  readonly riskNotes?: readonly string[];
}

export type GateResult =
  /** Proceed. If money was involved it is now reserved. */
  | {
      readonly outcome: 'allow';
      readonly decisionId: string;
      /** Call exactly one of these once the action completes. */
      readonly settle: (actualMinor: number) => Promise<void>;
      readonly release: () => Promise<void>;
      readonly reasons: PolicyEvaluation['reasons'];
    }
  /** A human must approve. The approval row is already open. */
  | {
      readonly outcome: 'require_approval';
      readonly decisionId: string;
      readonly approvalId: string;
      readonly reasons: PolicyEvaluation['reasons'];
      readonly explanation: string;
    }
  /** Refused. The explanation is written for the agent to act on. */
  | {
      readonly outcome: 'deny';
      readonly decisionId: string;
      readonly reasons: PolicyEvaluation['reasons'];
      readonly explanation: string;
    };

export interface PolicyGateOptions {
  /** Per-authority amount above which a human must approve, in minor units. */
  readonly approvalThresholdsMinor: Partial<Record<Authority, number>>;
  readonly approvalExpiryMs?: number;
}

/**
 * Defaults chosen so that anything irreversible or outward-facing needs a human
 * the first time it exceeds a trivial amount. These are the numbers an operator
 * will actually tune, so they are named rather than scattered through the code.
 */
export const DEFAULT_APPROVAL_THRESHOLDS: Partial<Record<Authority, number>> = {
  'expert.engage_paid': 100_00,
  'supplier.contact': 0, // any outbound supplier contact needs approval
  'supplier.purchase_sample': 200_00,
  'supplier.purchase_production': 0, // always
  'ads.create_campaign': 100_00,
  'ads.increase_budget': 200_00,
  'payments.refund': 100_00,
  // A carrier label on a paid order is routine and low-value; approving each
  // one would stall fulfilment. The ceiling catches an anomalous rate.
  'fulfilment.purchase_label': 50_00,
  'site.deploy_production': 0, // always
  'legal.publish_policy': 0, // always
  'infrastructure.provision': 100_00,
  'messaging.send_marketing': 0, // always
};

export class PolicyGate {
  constructor(
    private readonly repos: Repositories,
    private readonly providers: ProviderRegistry,
    private readonly options: PolicyGateOptions = { approvalThresholdsMinor: DEFAULT_APPROVAL_THRESHOLDS },
  ) {}

  async evaluate(request: GateRequest): Promise<GateResult> {
    const log = getLogger();
    const actorRow = await this.repos.governance.actors.requireByHandle(request.companyId, request.actorHandle);
    const actor = toActor(actorRow);

    const [engagedKillSwitches, budgets, existingApproval] = await Promise.all([
      this.repos.governance.killSwitches.engagedScopes(request.companyId),
      request.budgetScope
        ? this.repos.governance.budgets.forScope(request.companyId, request.budgetScope)
        : Promise.resolve([]),
      this.repos.governance.approvals.findValidFor(
        request.companyId,
        request.authority,
        request.subjectRefId ?? null,
        request.amountMinor ?? null,
      ),
    ]);

    // Spend, contact and publish require live_verified. Read-only probes may
    // still proceed when the capability is merely usable (configured_unverified).
    const capabilityAvailable = request.capability
      ? capabilityAvailableForAuthority(
          request.authority,
          this.providers.capabilities.resolveCapability(request.capability),
        )
      : true;

    const evaluation = evaluatePolicy({
      actor,
      authority: request.authority,
      action: request.action,
      ...(request.amountMinor !== undefined ? { amountMinor: request.amountMinor } : {}),
      ...(request.currency ? { currency: request.currency } : {}),
      budgets: budgets.map((b) => ({
        id: b.id,
        companyId: b.company_id,
        scope: b.scope as BudgetScope,
        window: b.window_kind as 'daily' | 'weekly' | 'monthly' | 'lifetime',
        limitMinor: b.limit_minor,
        currency: b.currency,
        reservedMinor: b.reserved_minor,
        spentMinor: b.spent_minor,
        windowStartedAt: b.window_started_at.toISOString(),
        warnAtRatio: b.warn_at_ratio,
        hardStop: b.hard_stop,
        updatedAt: b.updated_at.toISOString(),
      })),
      ...(request.budgetScope ? { budgetScope: request.budgetScope } : {}),
      engagedKillSwitches,
      approvalThresholdsMinor: this.options.approvalThresholdsMinor,
      ...(existingApproval
        ? {
            existingApproval: {
              id: existingApproval.id,
              status: existingApproval.status,
              expiresAt: existingApproval.expires_at.toISOString(),
              amountMinor: existingApproval.amount_minor,
            },
          }
        : {}),
      now: new Date(),
      capabilityAvailable,
    });

    /* ---------------------------------------------------------------- */
    /* Deny                                                              */
    /* ---------------------------------------------------------------- */
    if (evaluation.outcome === 'deny') {
      const decisionId = await this.repos.governance.decisions.record({
        companyId: request.companyId,
        actorId: actorRow.id,
        authority: request.authority,
        action: request.action,
        subjectRefId: request.subjectRefId ?? null,
        amountMinor: request.amountMinor ?? null,
        currency: request.currency ?? null,
        evaluation,
      });
      await this.repos.audit.append({
        companyId: request.companyId,
        kind: 'policy_decision',
        actorId: actorRow.id,
        actorKind: actorRow.kind,
        action: request.action,
        subjectType: 'policy',
        subjectRefId: request.subjectRefId ?? null,
        outcome: 'denied',
        detail: { authority: request.authority, reasons: evaluation.reasons },
        amountMinor: request.amountMinor ?? null,
        currency: request.currency ?? null,
      });

      const explanation = this.#explain(request, evaluation, capabilityAvailable);
      log.warn({ action: request.action, authority: request.authority }, 'policy denied action');
      return { outcome: 'deny', decisionId, reasons: evaluation.reasons, explanation };
    }

    /* ---------------------------------------------------------------- */
    /* Require approval                                                  */
    /* ---------------------------------------------------------------- */
    if (evaluation.outcome === 'require_approval') {
      const approval = await this.repos.governance.approvals.create({
        companyId: request.companyId,
        request: request.action,
        authority: request.authority,
        requestedByActorId: actorRow.id,
        subjectRefId: request.subjectRefId ?? null,
        amountMinor: request.amountMinor ?? null,
        currency: request.currency ?? null,
        evidenceRefs: request.evidenceRefs ?? [],
        riskNotes: request.riskNotes ?? [],
        ...(this.options.approvalExpiryMs ? { expiresInMs: this.options.approvalExpiryMs } : {}),
      });
      const decisionId = await this.repos.governance.decisions.record({
        companyId: request.companyId,
        actorId: actorRow.id,
        authority: request.authority,
        action: request.action,
        subjectRefId: request.subjectRefId ?? null,
        amountMinor: request.amountMinor ?? null,
        currency: request.currency ?? null,
        evaluation,
        approvalId: approval.id,
      });
      await this.repos.audit.append({
        companyId: request.companyId,
        kind: 'approval_requested',
        actorId: actorRow.id,
        actorKind: actorRow.kind,
        action: request.action,
        subjectType: 'approval',
        subjectRefId: approval.id,
        outcome: 'pending',
        detail: { authority: request.authority, reasons: evaluation.reasons },
        amountMinor: request.amountMinor ?? null,
        currency: request.currency ?? null,
      });

      return {
        outcome: 'require_approval',
        decisionId,
        approvalId: approval.id,
        reasons: evaluation.reasons,
        explanation:
          `This action needs human approval before it can run. Approval ${approval.id} is open and expires at ` +
          `${approval.expires_at.toISOString()}. Reasons: ${evaluation.reasons.map((r) => r.detail).join('; ')}. ` +
          `Do not attempt to work around this — report it and continue with work that does not depend on it.`,
      };
    }

    /* ---------------------------------------------------------------- */
    /* Allow — reserve the money before returning                        */
    /* ---------------------------------------------------------------- */
    let reservedScope: BudgetScope | undefined;
    let reservedAmount = 0;

    if (request.amountMinor && request.amountMinor > 0 && request.budgetScope) {
      const reservation = await this.repos.governance.budgets.reserve(
        request.companyId,
        request.budgetScope,
        request.amountMinor,
        request.currency ?? 'USD',
      );
      if (!reservation.reserved) {
        // The pure evaluation said yes but the atomic reservation lost a race
        // with a concurrent worker. The reservation is authoritative.
        const raceEvaluation: PolicyEvaluation = {
          outcome: 'deny',
          reasons: [
            {
              code: 'budget_exhausted',
              detail: `budget reservation failed: ${reservation.reason ?? 'insufficient remaining budget'}`,
            },
          ],
          requiresApprovalFor: null,
        };
        const decisionId = await this.repos.governance.decisions.record({
          companyId: request.companyId,
          actorId: actorRow.id,
          authority: request.authority,
          action: request.action,
          subjectRefId: request.subjectRefId ?? null,
          amountMinor: request.amountMinor,
          currency: request.currency ?? null,
          evaluation: raceEvaluation,
        });
        log.warn(
          { action: request.action, scope: request.budgetScope, reason: reservation.reason },
          'budget reservation lost a race; denying',
        );
        return {
          outcome: 'deny',
          decisionId,
          reasons: raceEvaluation.reasons,
          explanation: `Budget was exhausted by a concurrent action: ${reservation.reason}`,
        };
      }
      reservedScope = request.budgetScope;
      reservedAmount = request.amountMinor;
    }

    const decisionId = await this.repos.governance.decisions.record({
      companyId: request.companyId,
      actorId: actorRow.id,
      authority: request.authority,
      action: request.action,
      subjectRefId: request.subjectRefId ?? null,
      amountMinor: request.amountMinor ?? null,
      currency: request.currency ?? null,
      evaluation,
      approvalId: existingApproval?.id ?? null,
    });

    await this.repos.audit.append({
      companyId: request.companyId,
      kind: 'policy_decision',
      actorId: actorRow.id,
      actorKind: actorRow.kind,
      action: request.action,
      subjectType: 'policy',
      subjectRefId: request.subjectRefId ?? null,
      outcome: 'success',
      detail: { authority: request.authority, reasons: evaluation.reasons, reserved: reservedAmount },
      amountMinor: request.amountMinor ?? null,
      currency: request.currency ?? null,
    });

    const repos = this.repos;
    const companyId = request.companyId;

    return {
      outcome: 'allow',
      decisionId,
      reasons: evaluation.reasons,
      settle: async (actualMinor: number) => {
        if (!reservedScope) return;
        await repos.governance.budgets.settle(companyId, reservedScope, reservedAmount, actualMinor);
        await repos.audit.append({
          companyId,
          kind: 'purchase_committed',
          actorId: actorRow.id,
          actorKind: actorRow.kind,
          action: `${request.action} settled`,
          subjectType: 'budget',
          subjectRefId: request.subjectRefId ?? null,
          outcome: 'success',
          detail: { scope: reservedScope, reserved: reservedAmount, actual: actualMinor },
          amountMinor: actualMinor,
          currency: request.currency ?? null,
        });
      },
      release: async () => {
        if (!reservedScope) return;
        await repos.governance.budgets.release(companyId, reservedScope, reservedAmount);
      },
    };
  }

  /**
   * Runs `fn` behind the gate, settling or releasing the reservation
   * automatically. This is the form almost every caller should use — the
   * manual `settle`/`release` pair exists only for multi-step operations that
   * cannot be expressed as a single function.
   */
  async guard<T>(
    request: GateRequest,
    fn: () => Promise<{ result: T; actualMinor?: number }>,
  ): Promise<{ ok: true; result: T } | { ok: false; gate: Exclude<GateResult, { outcome: 'allow' }> }> {
    const gate = await this.evaluate(request);
    if (gate.outcome !== 'allow') return { ok: false, gate };

    try {
      const { result, actualMinor } = await fn();
      await gate.settle(actualMinor ?? request.amountMinor ?? 0);
      return { ok: true, result };
    } catch (error) {
      // The action did not happen, so the money must go back. Doing this in a
      // finally-style path is what stops a failing provider from silently
      // eating the day's budget.
      await gate.release();
      throw error;
    }
  }

  #explain(request: GateRequest, evaluation: PolicyEvaluation, capabilityAvailable: boolean): string {
    const reasons = evaluation.reasons.map((r) => r.detail).join('; ');
    if (!capabilityAvailable && request.capability) {
      const status = this.providers.capabilities.resolveCapability(request.capability);
      return (
        `Blocked: the "${request.capability}" capability is not available (${status.state}). ` +
        `${status.remediation ?? ''} Report this as a blocked dependency; do not fabricate a result.`
      );
    }
    return `Refused: ${reasons}. Report this and continue with work that does not depend on it.`;
  }
}
