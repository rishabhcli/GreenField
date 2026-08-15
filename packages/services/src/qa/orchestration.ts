/**
 * QA orchestration and the production release gate.
 *
 * Replay's documented loop is: create a project (that starts exploration),
 * poll timing until idle, then read bugs. Do not POST a second exploration.
 * If Replay is unavailable the run is recorded as `provider_unavailable` —
 * never as passed. A timeout is `failed`, not completed. Unexecuted QA is
 * not a pass.
 */

import {
  CapabilityUnsupportedError,
  CredentialsMissingError,
  CRITICAL_FLOWS,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  PRODUCTION_REQUIRED_RUN_KINDS,
  ProviderAuthError,
  ProviderUnavailableError,
  TimeoutError,
  assertTransition,
  canTransition,
  evaluateReleaseGate,
  type Capability,
  type CriticalFlow,
  type OrderStatus,
  type QaRunKind,
  type ReleaseGateResult,
} from '@foundry/core';
import {
  ReplayAdapter,
  isLocalTargetUrl,
  toQaRunFromProject,
  REPLAY_CRITICAL_FLOW_INSTRUCTIONS,
} from '@foundry/providers';
import { optionalCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';

export interface QaRunInput {
  readonly companyId: string;
  readonly siteId: string;
  readonly deploymentId: string;
  readonly targetUrl: string;
  readonly kinds: readonly QaRunKind[];
  readonly blockingForRelease: boolean;
}

export interface QaRunResult {
  readonly gate: ReleaseGateResult;
  readonly runIds: readonly string[];
}

export class QaOrchestrationService {
  constructor(private readonly deps: ServiceDeps) {}

  async run(input: QaRunInput): Promise<ServiceOutcome<QaRunResult>> {
    const runIds: string[] = [];
    let blockedOn: ServiceOutcome<QaRunResult>['blockedOn'];

    for (const kind of input.kinds) {
      if (kind === 'autonomous_exploration') {
        const exploration = await this.#runReplay(input);
        runIds.push(exploration.runId);
        if (exploration.blockedOn) blockedOn = exploration.blockedOn;
        continue;
      }
      if (kind === 'payment_state') {
        runIds.push(await this.#runPaymentState(input));
        continue;
      }
      if (kind === 'data_integrity') {
        runIds.push(await this.#runDataIntegrity(input));
        continue;
      }
      const unavailable = await this.deps.repos.build.qa.markProviderUnavailable({
        companyId: input.companyId,
        siteId: input.siteId,
        deploymentId: input.deploymentId,
        kind,
        provider: 'none',
        targetUrl: input.targetUrl,
        reason: `No in-process runner for QA kind "${kind}" in this service; not recorded as passed.`,
      });
      runIds.push(unavailable.id);
    }

    const runs = await this.deps.repos.build.qa.runsForDeployment(input.deploymentId);
    const defects = await this.deps.repos.build.qa.openDefects(input.companyId, input.siteId);
    const environment = input.blockingForRelease ? 'production' : 'preview';
    const gate = evaluateReleaseGate({
      environment,
      runs: runs.map((r) => ({
        kind: r.kind as QaRunKind,
        status: r.status as 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'provider_unavailable',
        flowsCovered: r.flows_covered as CriticalFlow[],
        unavailableReason: r.unavailable_reason,
      })),
      openDefects: defects.map((d) => ({
        severity: d.severity as 'critical' | 'high' | 'medium' | 'low' | 'info',
        affectedFlow: (d.affected_flow as CriticalFlow | null) ?? null,
        status: d.status as 'open' | 'assigned' | 'fixed' | 'wontfix' | 'invalid' | 'reopened',
      })),
      requiredFlows: environment === 'production' ? [...CRITICAL_FLOWS] : (['homepage_loads', 'product_page_loads'] as const),
      requiredRunKinds: environment === 'production' ? PRODUCTION_REQUIRED_RUN_KINDS : (['autonomous_exploration'] as const),
    });

    if (input.blockingForRelease && gate.verdict === 'block') {
      await this.deps.repos.build.sites.setStatus(input.siteId, 'release_blocked');
    } else if (gate.verdict === 'pass') {
      await this.deps.repos.build.sites.setStatus(input.siteId, 'qa_passed');
    } else {
      await this.deps.repos.build.sites.setStatus(input.siteId, 'qa_failed');
    }

    return {
      ok: blockedOn === undefined,
      data: { gate, runIds },
      blockedOn,
    };
  }

  async blockRelease(input: { siteId: string; reason: string }): Promise<ServiceOutcome<{ siteId: string }>> {
    await this.deps.repos.build.sites.setStatus(input.siteId, 'release_blocked');
    return { ok: true, data: { siteId: input.siteId } };
  }

  /**
   * Records an intent to approve. Production still requires `evaluateGate` to
   * pass inside `promoteToProduction`; this method will not skip that write.
   */
  async approveRelease(input: {
    companyId: string;
    siteId: string;
    deploymentId: string;
    actorId: string;
  }): Promise<ServiceOutcome<{ approved: boolean; gate: ReleaseGateResult }>> {
    const gate = await this.deps.repos.build.qa.evaluateGate(
      input.companyId,
      input.siteId,
      input.deploymentId,
      'production',
    );
    if (gate.verdict === 'block') {
      await this.deps.repos.build.sites.setStatus(input.siteId, 'release_blocked');
      return { ok: false, data: { approved: false, gate } };
    }
    await this.deps.repos.governance.approvals.create({
      companyId: input.companyId,
      request: `approve production release for site ${input.siteId}`,
      authority: 'site.deploy_production',
      requestedByActorId: input.actorId,
      subjectRefId: input.deploymentId,
      riskNotes: ['QA gate passed at approval time; promoteToProduction will re-evaluate before going live.'],
    });
    return { ok: true, data: { approved: true, gate } };
  }

  async #runReplay(input: QaRunInput): Promise<{ runId: string; blockedOn?: { capability: Capability; reason: string } }> {
    const adapter = optionalCapability<ReplayAdapter>(this.deps, 'qa.autonomous_exploration');
    if (!adapter || typeof adapter.createProject !== 'function') {
      return this.#markReplayUnavailable(input, this.#reason('qa.autonomous_exploration'));
    }

    try {
      const open = typeof adapter.ensureProjectForTarget === 'function' ? adapter.ensureProjectForTarget.bind(adapter) : adapter.createProject.bind(adapter);
      const project = await open({
        name: `qa:${input.siteId}`,
        targetUrl: input.targetUrl,
        instructions: REPLAY_CRITICAL_FLOW_INSTRUCTIONS,
        useReverseProxy: isLocalTargetUrl(input.targetUrl),
        webhookUrl: replayWebhookUrl(this.deps.publicBaseUrl),
      });
      const started = await this.deps.repos.build.qa.startRun({
        companyId: input.companyId,
        siteId: input.siteId,
        deploymentId: input.deploymentId,
        kind: 'autonomous_exploration',
        provider: 'replay',
        targetUrl: input.targetUrl,
        externalProjectId: project.id,
      });

      try {
        if (typeof adapter.waitForProjectIdle !== 'function') {
          throw new CapabilityUnsupportedError(
            'replay',
            'qa.autonomous_exploration',
            'waitForProjectIdle is required; Replay starts QA on create and must be polled via project timing',
          );
        }
        const timing = await adapter.waitForProjectIdle(project.id, {
          timeoutMs: 8 * 60_000,
          pollIntervalMs: 5_000,
        });
        const bugs = await adapter.listBugs(project.id, { pageSize: 100 });
        const journeys =
          typeof adapter.listJourneys === 'function'
            ? await adapter.listJourneys(project.id, { pageSize: 100 })
            : { items: [] as const };
        let exploration =
          project.exploration_id && typeof adapter.getExploration === 'function'
            ? await adapter.getExploration(project.exploration_id).catch(() => null)
            : null;
        if (!exploration && typeof adapter.listExplorations === 'function') {
          const listed = await adapter.listExplorations(project.id, { pageSize: 100 });
          exploration = listed.items[0] ?? null;
        }
        const bridged = toQaRunFromProject(project, timing, bugs.items, [...journeys.items], exploration);
        for (const defect of bridged.defects) {
          await this.deps.repos.build.qa.recordDefect({
            companyId: input.companyId,
            qaRunId: started.id,
            provider: 'replay',
            externalId: defect.externalId,
            title: defect.title,
            description: defect.description,
            severity: defect.severity,
            affectedFlow: defect.affectedFlow,
            reproductionSteps: defect.reproductionSteps,
            rootCause: defect.rootCause,
            suggestedFix: defect.suggestedFix,
            evidenceUrl: defect.evidenceUrl,
          });
        }
        const status =
          bridged.run.status === 'completed' || bridged.run.status === 'failed' || bridged.run.status === 'cancelled'
            ? bridged.run.status
            : 'failed';
        await this.deps.repos.build.qa.finishRun(started.id, {
          status,
          flowsCovered: [...bridged.run.flowsCovered],
          externalRunId: exploration?.id ?? project.exploration_id ?? null,
          evidenceUrl: bridged.run.evidenceUrl,
        });
        return { runId: started.id };
      } catch (error) {
        if (error instanceof TimeoutError) {
          await this.deps.repos.build.qa.finishRun(started.id, {
            status: 'failed',
            flowsCovered: [],
            externalRunId: project.exploration_id ?? null,
          });
          return { runId: started.id };
        }
        throw error;
      }
    } catch (error) {
      if (
        error instanceof CredentialsMissingError ||
        error instanceof CapabilityUnsupportedError ||
        error instanceof ProviderUnavailableError ||
        error instanceof ProviderAuthError
      ) {
        return this.#markReplayUnavailable(input, error.message);
      }
      throw error;
    }
  }

  async #markReplayUnavailable(
    input: QaRunInput,
    reason: string,
  ): Promise<{ runId: string; blockedOn: { capability: Capability; reason: string } }> {
    const row = await this.deps.repos.build.qa.markProviderUnavailable({
      companyId: input.companyId,
      siteId: input.siteId,
      deploymentId: input.deploymentId,
      kind: 'autonomous_exploration',
      provider: 'replay',
      targetUrl: input.targetUrl,
      reason,
    });
    return { runId: row.id, blockedOn: { capability: 'qa.autonomous_exploration', reason } };
  }

  /**
   * In-process tests of the order state machine. These are real domain
   * assertions (`canTransition` / `assertTransition`), not a fabricated QA pass.
   */
  async #runPaymentState(input: QaRunInput): Promise<string> {
    const started = await this.deps.repos.build.qa.startRun({
      companyId: input.companyId,
      siteId: input.siteId,
      deploymentId: input.deploymentId,
      kind: 'payment_state',
      provider: 'in_process',
      targetUrl: input.targetUrl,
    });

    const failures: string[] = [];
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_TRANSITIONS[from]) {
        if (!canTransition(from, to as OrderStatus)) {
          failures.push(`allowed edge ${from} -> ${to} was rejected by canTransition`);
        }
      }
    }
    if (canTransition('REFUNDED', 'SHIPPED')) {
      failures.push('illegal transition REFUNDED -> SHIPPED was allowed');
    }
    try {
      assertTransition('REFUNDED', 'SHIPPED', 'qa-payment-state');
      failures.push('assertTransition did not throw for REFUNDED -> SHIPPED');
    } catch {
      // expected
    }

    if (failures.length > 0) {
      await this.deps.repos.build.qa.recordDefect({
        companyId: input.companyId,
        qaRunId: started.id,
        provider: 'in_process',
        title: 'Order state machine invariant failed',
        description: failures.join('\n'),
        severity: 'critical',
        affectedFlow: 'payment_success_path',
      });
      await this.deps.repos.build.qa.finishRun(started.id, {
        status: 'failed',
        flowsCovered: ['checkout_initiation', 'payment_success_path', 'payment_failure_path'],
      });
      return started.id;
    }

    await this.deps.repos.build.qa.finishRun(started.id, {
      status: 'completed',
      flowsCovered: ['checkout_initiation', 'payment_success_path', 'payment_failure_path'],
    });
    return started.id;
  }

  async #runDataIntegrity(input: QaRunInput): Promise<string> {
    const ledger = this.deps.repos.ledger;
    if (!ledger || typeof ledger.findUnbalancedTransactions !== 'function') {
      const row = await this.deps.repos.build.qa.markProviderUnavailable({
        companyId: input.companyId,
        siteId: input.siteId,
        deploymentId: input.deploymentId,
        kind: 'data_integrity',
        provider: 'ledger',
        targetUrl: input.targetUrl,
        reason: 'LedgerRepository.findUnbalancedTransactions is not available; data-integrity is incomplete, not a pass.',
      });
      return row.id;
    }

    const started = await this.deps.repos.build.qa.startRun({
      companyId: input.companyId,
      siteId: input.siteId,
      deploymentId: input.deploymentId,
      kind: 'data_integrity',
      provider: 'ledger',
      targetUrl: input.targetUrl,
    });
    const unbalanced = await ledger.findUnbalancedTransactions(input.companyId);
    if (unbalanced.length > 0) {
      await this.deps.repos.build.qa.recordDefect({
        companyId: input.companyId,
        qaRunId: started.id,
        provider: 'ledger',
        title: 'Unbalanced ledger transactions',
        description: unbalanced.map((u) => `${u.transactionId} net ${u.netMinor}`).join('\n'),
        severity: 'critical',
      });
      await this.deps.repos.build.qa.finishRun(started.id, { status: 'failed', flowsCovered: [] });
      return started.id;
    }
    await this.deps.repos.build.qa.finishRun(started.id, { status: 'completed', flowsCovered: [] });
    return started.id;
  }

  #reason(capability: Capability): string {
    const status = this.deps.providers.forCapability(capability).status;
    return status.remediation ?? `capability state is ${status.state}`;
  }
}

function replayWebhookUrl(publicBaseUrl: string | undefined): string | undefined {
  if (!publicBaseUrl) return undefined;
  try {
    const host = new URL(publicBaseUrl).hostname;
    if (host === 'example.test' || host.includes('personal-ydgn') || host === 'localhost') return undefined;
    return new URL('/webhooks/replay', publicBaseUrl).toString();
  } catch {
    return undefined;
  }
}
