/**
 * Governance: authority, spend limits, approvals, kill switches and audit.
 *
 * The CEO agent decides; this module is what makes execution stay inside the
 * permissions a real human business owner actually granted. Every action that
 * spends money, contacts a third party, publishes to the public internet or
 * touches a customer passes through `PolicyDecision` first, and every decision
 * is written to an append-only audit log.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Authority                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Named authorities an actor may hold. Deliberately coarse and business-shaped
 * so an operator can reason about what they are granting.
 */
export const AUTHORITIES = [
  'research.collect',
  'expert.engage_paid',
  'supplier.contact',
  'supplier.purchase_sample',
  'supplier.purchase_production',
  'brand.publish',
  'site.deploy_preview',
  'site.deploy_production',
  'payments.configure',
  'payments.refund',
  // Buying a carrier label spends real money on a per-order basis, which is a
  // different risk shape from a supplier purchase order and is delegated
  // separately by the owner.
  'fulfilment.purchase_label',
  'ads.create_campaign',
  'ads.increase_budget',
  'messaging.send_customer',
  'messaging.send_marketing',
  'legal.publish_policy',
  'legal.sign_agreement',
  'finance.move_funds',
  'infrastructure.provision',
  'governance.override',
] as const;
export const Authority = z.enum(AUTHORITIES);
export type Authority = z.infer<typeof Authority>;

/**
 * Authorities that a software agent may never hold, regardless of
 * configuration. Signing a contract and moving funds bind a legal person; an
 * autonomous system must not do either on its own account.
 */
export const HUMAN_ONLY_AUTHORITIES: ReadonlySet<Authority> = new Set<Authority>([
  'legal.sign_agreement',
  'finance.move_funds',
  'governance.override',
]);

export const ActorKind = z.enum(['ceo_agent', 'manager_agent', 'specialist_agent', 'human_operator', 'system_job']);
export type ActorKind = z.infer<typeof ActorKind>;

export const Actor = z.object({
  id: z.string().min(1),
  kind: ActorKind,
  /** Agent role key or human identifier. */
  handle: z.string().min(1),
  authorities: z.array(Authority).default([]),
  /** Per-action spend ceiling in minor units; null means no independent spend. */
  spendCeilingMinor: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3),
});
export type Actor = z.infer<typeof Actor>;

/* -------------------------------------------------------------------------- */
/* Budgets & spend                                                             */
/* -------------------------------------------------------------------------- */

export const BudgetScope = z.enum([
  'company_total',
  'research',
  'expert_review',
  'sampling',
  'inventory',
  'advertising',
  'infrastructure',
  'messaging',
  'llm_inference',
]);
export type BudgetScope = z.infer<typeof BudgetScope>;

export const BudgetWindow = z.enum(['daily', 'weekly', 'monthly', 'lifetime']);
export type BudgetWindow = z.infer<typeof BudgetWindow>;

export const Budget = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  scope: BudgetScope,
  window: BudgetWindow,
  limitMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  /** Committed but not yet settled (e.g. an ad set that is live right now). */
  reservedMinor: z.number().int().nonnegative().default(0),
  /** Actually settled spend within the current window. */
  spentMinor: z.number().int().nonnegative().default(0),
  windowStartedAt: z.string().datetime(),
  /** Fraction of the limit at which the CEO is warned rather than blocked. */
  warnAtRatio: z.number().min(0).max(1).default(0.8),
  hardStop: z.boolean().default(true),
  updatedAt: z.string().datetime(),
});
export type Budget = z.infer<typeof Budget>;

export function budgetRemainingMinor(b: Pick<Budget, 'limitMinor' | 'reservedMinor' | 'spentMinor'>): number {
  return Math.max(0, b.limitMinor - b.reservedMinor - b.spentMinor);
}

export function budgetUtilisation(b: Pick<Budget, 'limitMinor' | 'reservedMinor' | 'spentMinor'>): number {
  if (b.limitMinor === 0) return 1;
  return (b.reservedMinor + b.spentMinor) / b.limitMinor;
}

/* -------------------------------------------------------------------------- */
/* Approvals                                                                   */
/* -------------------------------------------------------------------------- */

export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'expired', 'auto_approved']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const Approval = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  /** What is being asked for, in plain language, for the human reviewer. */
  request: z.string().min(1),
  authority: Authority,
  requestedByActorId: z.string().min(1),
  /** Resource this approval unlocks, e.g. an RFQ id or experiment id. */
  subjectRefId: z.string().nullable(),
  amountMinor: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  /** Evidence the approver should read before deciding. */
  evidenceRefs: z.array(z.string()).default([]),
  riskNotes: z.array(z.string()).default([]),
  status: ApprovalStatus,
  decidedBy: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
  decisionRationale: z.string().nullable(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type Approval = z.infer<typeof Approval>;

/* -------------------------------------------------------------------------- */
/* Kill switches                                                               */
/* -------------------------------------------------------------------------- */

export const KILL_SWITCH_SCOPES = [
  'all',
  'outbound_spend',
  'supplier_contact',
  'customer_messaging',
  'marketing_messaging',
  'ad_spend',
  'site_publishing',
  'payments_capture',
  'fulfilment',
  'agent_execution',
  'external_browsing',
] as const;
export const KillSwitchScope = z.enum(KILL_SWITCH_SCOPES);
export type KillSwitchScope = z.infer<typeof KillSwitchScope>;

export const KillSwitch = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  scope: KillSwitchScope,
  engaged: z.boolean(),
  reason: z.string().min(1),
  engagedBy: z.string().min(1),
  engagedAt: z.string().datetime(),
  releasedBy: z.string().nullable(),
  releasedAt: z.string().datetime().nullable(),
});
export type KillSwitch = z.infer<typeof KillSwitch>;

/** Which kill switches block which authorities. */
export const AUTHORITY_KILL_SCOPES: Readonly<Record<Authority, readonly KillSwitchScope[]>> = {
  'research.collect': ['all', 'agent_execution', 'external_browsing'],
  'expert.engage_paid': ['all', 'outbound_spend', 'agent_execution'],
  'supplier.contact': ['all', 'supplier_contact', 'agent_execution'],
  'supplier.purchase_sample': ['all', 'outbound_spend', 'supplier_contact'],
  'supplier.purchase_production': ['all', 'outbound_spend', 'supplier_contact'],
  'brand.publish': ['all', 'site_publishing'],
  'site.deploy_preview': ['all', 'site_publishing'],
  'site.deploy_production': ['all', 'site_publishing'],
  'payments.configure': ['all', 'payments_capture'],
  'payments.refund': ['all'],
  'fulfilment.purchase_label': ['all', 'outbound_spend', 'fulfilment'],
  'ads.create_campaign': ['all', 'ad_spend', 'outbound_spend'],
  'ads.increase_budget': ['all', 'ad_spend', 'outbound_spend'],
  'messaging.send_customer': ['all', 'customer_messaging'],
  'messaging.send_marketing': ['all', 'customer_messaging', 'marketing_messaging'],
  'legal.publish_policy': ['all', 'site_publishing'],
  'legal.sign_agreement': ['all'],
  'finance.move_funds': ['all', 'outbound_spend'],
  'infrastructure.provision': ['all', 'outbound_spend'],
  'governance.override': [],
};

/* -------------------------------------------------------------------------- */
/* Policy decisions                                                            */
/* -------------------------------------------------------------------------- */

export const PolicyOutcome = z.enum(['allow', 'require_approval', 'deny']);
export type PolicyOutcome = z.infer<typeof PolicyOutcome>;

export const PolicyReasonCode = z.enum([
  'authority_granted',
  'within_actor_ceiling',
  'within_budget',
  'authority_not_held',
  'human_only_authority',
  'actor_ceiling_exceeded',
  'budget_exhausted',
  'budget_warning_threshold',
  'kill_switch_engaged',
  'capability_unavailable',
  'approval_threshold_exceeded',
  'existing_approval_valid',
  'rate_limit_exceeded',
  'compliance_gate_failed',
]);
export type PolicyReasonCode = z.infer<typeof PolicyReasonCode>;

export const PolicyDecision = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  actorId: z.string().min(1),
  authority: Authority,
  action: z.string().min(1),
  subjectRefId: z.string().nullable(),
  amountMinor: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  outcome: PolicyOutcome,
  reasons: z.array(z.object({ code: PolicyReasonCode, detail: z.string() })).min(1),
  /** Approval created when the outcome is `require_approval`. */
  approvalId: z.string().nullable(),
  decidedAt: z.string().datetime(),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export interface PolicyEvaluationInput {
  readonly actor: Actor;
  readonly authority: Authority;
  readonly action: string;
  readonly amountMinor?: number;
  readonly currency?: string;
  readonly budgets: readonly Budget[];
  readonly budgetScope?: BudgetScope;
  readonly engagedKillSwitches: readonly KillSwitchScope[];
  /** Approval threshold above which a human must sign off, per authority. */
  readonly approvalThresholdsMinor: Partial<Record<Authority, number>>;
  /** An existing, still-valid approval for this exact action. */
  readonly existingApproval?: { id: string; status: ApprovalStatus; expiresAt: string; amountMinor: number | null };
  readonly now: Date;
  /** False when the capability registry says the provider is not usable. */
  readonly capabilityAvailable: boolean;
}

export interface PolicyEvaluation {
  readonly outcome: PolicyOutcome;
  readonly reasons: readonly { code: PolicyReasonCode; detail: string }[];
  readonly requiresApprovalFor: number | null;
}

/**
 * Pure policy evaluation. No I/O, so the exact rules that gate money are
 * exhaustively unit-testable and reviewable in one place.
 *
 * Order matters: hard denials first (kill switch, human-only authority,
 * missing authority, unavailable capability), then budget, then approval
 * thresholds. A denial short-circuits — we never report "approved but blocked".
 */
export function evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluation {
  const reasons: { code: PolicyReasonCode; detail: string }[] = [];

  // 1. Kill switches.
  const blockingScopes = AUTHORITY_KILL_SCOPES[input.authority] ?? [];
  const engaged = blockingScopes.filter((s) => input.engagedKillSwitches.includes(s));
  if (engaged.length > 0) {
    return {
      outcome: 'deny',
      reasons: [
        {
          code: 'kill_switch_engaged',
          detail: `kill switch(es) engaged: ${engaged.join(', ')}. Release them before "${input.action}" can run.`,
        },
      ],
      requiresApprovalFor: null,
    };
  }

  // 2. Authorities a software agent may never hold.
  if (HUMAN_ONLY_AUTHORITIES.has(input.authority) && input.actor.kind !== 'human_operator') {
    return {
      outcome: 'deny',
      reasons: [
        {
          code: 'human_only_authority',
          detail:
            `"${input.authority}" binds a legal person and can only be exercised by an authorised human. ` +
            `Actor ${input.actor.handle} is a ${input.actor.kind}.`,
        },
      ],
      requiresApprovalFor: null,
    };
  }

  // 3. Authority actually granted to this actor.
  if (!input.actor.authorities.includes(input.authority)) {
    return {
      outcome: 'deny',
      reasons: [
        {
          code: 'authority_not_held',
          detail: `Actor ${input.actor.handle} does not hold "${input.authority}". Held: ${
            input.actor.authorities.join(', ') || 'none'
          }.`,
        },
      ],
      requiresApprovalFor: null,
    };
  }
  reasons.push({ code: 'authority_granted', detail: `${input.actor.handle} holds ${input.authority}` });

  // 4. Is the underlying capability usable at all?
  if (!input.capabilityAvailable) {
    return {
      outcome: 'deny',
      reasons: [
        {
          code: 'capability_unavailable',
          detail: `The provider capability required for "${input.action}" is not activated. See the readiness report for setup steps.`,
        },
      ],
      requiresApprovalFor: null,
    };
  }

  const amount = input.amountMinor ?? 0;

  // 5. Budget.
  if (amount > 0 && input.budgetScope) {
    const relevant = input.budgets.filter(
      (b) => b.scope === input.budgetScope || b.scope === 'company_total',
    );
    for (const budget of relevant) {
      const remaining = budgetRemainingMinor(budget);
      if (amount > remaining) {
        if (budget.hardStop) {
          return {
            outcome: 'deny',
            reasons: [
              {
                code: 'budget_exhausted',
                detail:
                  `${budget.scope}/${budget.window} budget has ${remaining} of ${budget.limitMinor} ` +
                  `${budget.currency} minor units remaining; this action needs ${amount}.`,
              },
            ],
            requiresApprovalFor: null,
          };
        }
        reasons.push({
          code: 'budget_exhausted',
          detail: `${budget.scope} budget exceeded but not a hard stop; escalating for approval.`,
        });
      } else if (budgetUtilisation(budget) >= budget.warnAtRatio) {
        reasons.push({
          code: 'budget_warning_threshold',
          detail: `${budget.scope}/${budget.window} budget is at ${(budgetUtilisation(budget) * 100).toFixed(0)}% utilisation.`,
        });
      }
    }
    if (!reasons.some((r) => r.code === 'budget_exhausted')) {
      reasons.push({ code: 'within_budget', detail: `${amount} fits remaining budget` });
    }
  }

  // 6. Per-actor spend ceiling.
  if (amount > 0) {
    const ceiling = input.actor.spendCeilingMinor;
    if (ceiling === null) {
      reasons.push({
        code: 'actor_ceiling_exceeded',
        detail: `${input.actor.handle} has no independent spend authority; every spend needs approval.`,
      });
    } else if (amount > ceiling) {
      reasons.push({
        code: 'actor_ceiling_exceeded',
        detail: `${amount} exceeds ${input.actor.handle}'s per-action ceiling of ${ceiling}.`,
      });
    } else {
      reasons.push({ code: 'within_actor_ceiling', detail: `${amount} <= ceiling ${ceiling}` });
    }
  }

  // 7. Approval threshold for this authority.
  //
  // A threshold of 0 means "a human signs off on every one of these", not
  // "anything above zero". Actions like contacting a real supplier or
  // publishing a legal policy carry no amount at all, so an `amount > 0` test
  // would let them through unapproved — which is the opposite of the intent.
  const threshold = input.approvalThresholdsMinor[input.authority];
  const overThreshold = threshold !== undefined && (threshold === 0 || amount > threshold);
  if (overThreshold) {
    reasons.push({
      code: 'approval_threshold_exceeded',
      detail:
        threshold === 0
          ? `"${input.authority}" always requires human approval.`
          : `${amount} exceeds the human-approval threshold of ${threshold} for ${input.authority}.`,
    });
  }

  const needsApproval = overThreshold || reasons.some((r) => r.code === 'actor_ceiling_exceeded' || r.code === 'budget_exhausted');

  if (needsApproval) {
    const approval = input.existingApproval;
    if (
      approval &&
      approval.status === 'approved' &&
      new Date(approval.expiresAt).getTime() > input.now.getTime() &&
      (approval.amountMinor === null || amount <= approval.amountMinor)
    ) {
      reasons.push({ code: 'existing_approval_valid', detail: `covered by approval ${approval.id}` });
      return { outcome: 'allow', reasons, requiresApprovalFor: null };
    }
    return { outcome: 'require_approval', reasons, requiresApprovalFor: amount };
  }

  return { outcome: 'allow', reasons, requiresApprovalFor: null };
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

export const AuditEventKind = z.enum([
  'policy_decision',
  'approval_requested',
  'approval_granted',
  'approval_rejected',
  'kill_switch_engaged',
  'kill_switch_released',
  'budget_changed',
  'secret_accessed',
  'provider_call',
  'webhook_received',
  'order_state_changed',
  'refund_issued',
  'supplier_contacted',
  'purchase_committed',
  'ad_spend_changed',
  'site_published',
  'deployment',
  'rollback',
  'agent_run_started',
  'agent_run_finished',
  'agent_decision',
  'human_intervention',
  'compliance_check',
  'verification_probe',
  'data_retention_action',
]);
export type AuditEventKind = z.infer<typeof AuditEventKind>;

/**
 * Append-only. Rows are never updated or deleted; retention is enforced by
 * partition drop, and the hash chain makes silent tampering detectable.
 */
export const AuditEvent = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  kind: AuditEventKind,
  actorId: z.string().min(1),
  actorKind: ActorKind,
  action: z.string().min(1),
  subjectType: z.string().nullable(),
  subjectRefId: z.string().nullable(),
  outcome: z.enum(['success', 'failure', 'denied', 'pending']),
  /** Log-safe detail. Secrets are never permitted here. */
  detail: z.record(z.string(), z.unknown()).default({}),
  amountMinor: z.number().int().nullable(),
  currency: z.string().length(3).nullable(),
  /** SHA-256 over (previousHash || canonical row). Detects silent edits. */
  previousHash: z.string().nullable(),
  hash: z.string().min(1),
  occurredAt: z.string().datetime(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

/** Canonical serialisation used for the hash chain — key order is fixed. */
export function canonicalAuditPayload(
  event: Omit<AuditEvent, 'hash' | 'id'> & { id: string },
): string {
  return JSON.stringify([
    event.id,
    event.companyId,
    event.kind,
    event.actorId,
    event.actorKind,
    event.action,
    event.subjectType,
    event.subjectRefId,
    event.outcome,
    stableStringify(event.detail),
    event.amountMinor,
    event.currency,
    event.previousHash,
    event.occurredAt,
  ]);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
