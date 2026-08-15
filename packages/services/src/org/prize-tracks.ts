/**
 * Prize-track capabilities the operating company must report honestly.
 *
 * Adapter `probe()` (GET /projects, catalog, GET /v1/services, …) is
 * `probeLive`. `liveVerified` is true only when the prize-relevant method
 * succeeded — not merely that the provider answered a listing call. Missing
 * keys and known prize-method failures are `blockedOn`, never a fabricated pass.
 */

import type { ActivationState, Capability, CapabilityRegistry } from '@foundry/core';

/** Exact live Linq POST /v3/payment_requests 2011 body, classified in the adapter. */
export const LINQ_AGENT_PAY_BLOCKER =
  'Linq Agent Pay is not usable: no connected payment account on file (error 2011). Connect a Stripe account in the Linq dashboard before POST /v3/payment_requests.';

/** Exact live Pioneer POST /inference 403 body. Catalog GET /base-models is not a GLiNER/GLiGuard run. */
export const PIONEER_INFERENCE_BLOCKER =
  'To run inference on Pioneer, subscribe to the Hobby or Pro plan at https://agent.pioneer.ai/billing.';

/**
 * Exact Terac launch refusals. MCP rejected sub-$5 drafts; funded launch is
 * still $0 org credit (HTTP 412 PRECONDITION_FAILED on launchOpportunity).
 */
export const TERAC_STUDY_BLOCKER =
  'Study budget ($3.00–$4.00) is below the $5.00 minimum. Insufficient balance. Required: $200.00, Available: $0.00. The organization has to add credit before this launch can go through: https://terac.com/rishabh-bansal/settings/finance. Give that link to someone on the team with billing access instead of retrying - a member without it gets a 404 on that page.';

/** Replay exploration was `running`, not a completed pass. Unexecuted QA is not a pass. */
export const REPLAY_QA_BLOCKER =
  'autonomous_exploration finished with status "running". An unexecuted check is not a passing check.';

/** POST /v1/task-runs 202 is not a successful workflow tick. */
export const RENDER_WORKFLOW_BLOCKER = 'Queue name cannot contain :';

/**
 * How this track may claim `liveVerified`.
 *
 * - `probe`: the documented adapter.probe() *is* the prize-relevant evidence
 *   (Band GET /agent/me, Stripe Payment Link retrieve, Linq link/open).
 * - `prize_method`: a successful listing/catalog probe is not enough; the
 *   named prize method must have succeeded. We have no such success on record.
 */
export type PrizeVerificationBasis = 'probe' | 'prize_method';

export const PRIZE_TRACKS = [
  {
    track: 'Terac (required)',
    capability: 'expert.structured_review' as const,
    probe: 'GET /projects',
    prizeMethod: 'MCP terac_launch_draft_opportunity / REST POST /opportunities/{id}/launch',
    verifiedBy: 'prize_method' as const,
    prizeMethodBlocker: TERAC_STUDY_BLOCKER,
  },
  {
    track: 'Best Overall Agent-Run Company / Stripe',
    capability: 'payments.checkout.physical' as const,
    probe: 'GET /v1/balance',
    prizeMethod: 'GET /v1/balance (live mode)',
    verifiedBy: 'probe' as const,
    prizeMethodBlocker: null,
  },
  {
    track: 'Stripe Payment Link (hackathon revenue)',
    capability: 'payments.payment_link' as const,
    probe: 'GET /v1/balance',
    prizeMethod: 'GET /v1/payment_links/plink_1U4lK242nB81EBguRPuIHrxS',
    verifiedBy: 'probe' as const,
    prizeMethodBlocker: null,
  },
  {
    track: 'Linq Agent Pay / iMessage',
    capability: 'payments.imessage_checkout' as const,
    probe: 'GET /v3/phone_numbers',
    prizeMethod: 'POST /v3/payment_requests',
    verifiedBy: 'prize_method' as const,
    prizeMethodBlocker: LINQ_AGENT_PAY_BLOCKER,
  },
  {
    track: 'Linq link experience',
    capability: 'messaging.imessage_app' as const,
    probe: 'GET /v3/phone_numbers',
    prizeMethod: 'Linq-hosted link/open iMessage Apps',
    verifiedBy: 'probe' as const,
    prizeMethodBlocker: null,
  },
  {
    track: 'Best use of Replay',
    capability: 'qa.autonomous_exploration' as const,
    probe: 'GET /projects',
    prizeMethod: 'Replay QA exploration completed (not running)',
    verifiedBy: 'prize_method' as const,
    prizeMethodBlocker: REPLAY_QA_BLOCKER,
  },
  {
    track: 'Best use of Superserve',
    capability: 'compute.persistent_sandbox' as const,
    probe: 'GET /sandboxes',
    prizeMethod: 'create + pause + delete sandbox',
    verifiedBy: 'probe' as const,
    prizeMethodBlocker: null,
  },
  {
    track: 'Best use of Pioneer (PII)',
    capability: 'compliance.pii_scan' as const,
    probe: 'GET /base-models?supports_inference=true',
    prizeMethod: 'POST /inference GLiNER2-PII',
    verifiedBy: 'prize_method' as const,
    prizeMethodBlocker: PIONEER_INFERENCE_BLOCKER,
  },
  {
    track: 'Best use of Pioneer (GLiGuard)',
    capability: 'compliance.prompt_guard' as const,
    probe: 'GET /base-models?supports_inference=true',
    prizeMethod: 'POST /inference GLiGuard',
    verifiedBy: 'prize_method' as const,
    prizeMethodBlocker: PIONEER_INFERENCE_BLOCKER,
  },
  {
    track: 'Best use of Band',
    capability: 'coordination.agent_mesh' as const,
    probe: 'GET /agent/me',
    prizeMethod: 'GET /agent/me',
    verifiedBy: 'probe' as const,
    prizeMethodBlocker: null,
  },
  {
    track: 'Best use of Render (Workflows)',
    capability: 'platform.workflows' as const,
    probe: 'GET /v1/services',
    prizeMethod: 'POST /v1/task-runs tickCompanyLoop completed',
    verifiedBy: 'prize_method' as const,
    prizeMethodBlocker: RENDER_WORKFLOW_BLOCKER,
  },
  {
    track: 'Render deploys',
    capability: 'platform.deploy_control' as const,
    probe: 'GET /v1/services',
    prizeMethod: 'GET /v1/services',
    verifiedBy: 'probe' as const,
    prizeMethodBlocker: null,
  },
  {
    track: 'Lovable storefront generate',
    capability: 'site.generate' as const,
    probe: 'MCP tools/call get_me',
    prizeMethod: 'Lovable MCP site.generate',
    verifiedBy: 'probe' as const,
    prizeMethodBlocker: null,
  },
  {
    track: 'Solari browser',
    capability: 'research.browser_session' as const,
    probe: 'GET /health',
    prizeMethod: 'GET /health + sandboxes',
    verifiedBy: 'probe' as const,
    prizeMethodBlocker: null,
  },
] as const;

export type PrizeTrackCapability = (typeof PRIZE_TRACKS)[number]['capability'];

export interface PrizeTrackStatus {
  readonly track: string;
  readonly capability: Capability;
  readonly probe: string;
  readonly prizeMethod: string;
  readonly verifiedBy: PrizeVerificationBasis;
  readonly state: string;
  readonly usable: boolean;
  /** True when the provider's non-destructive adapter.probe() succeeded. */
  readonly probeLive: boolean;
  /** True only when the prize-relevant method succeeded — never catalog/list alone. */
  readonly prizeMethodSucceeded: boolean;
  readonly liveVerified: boolean;
  readonly missingSecrets: readonly string[];
  readonly blockedOn: string | null;
  readonly remediation: string | null;
}

export function prizeTrackSnapshot(capabilities: CapabilityRegistry): readonly PrizeTrackStatus[] {
  return PRIZE_TRACKS.map((item) => {
    const status = capabilities.resolveCapability(item.capability);
    const probeLive = status.state === 'live_verified';
    const prizeMethodSucceeded = item.verifiedBy === 'probe' && probeLive;
    const liveVerified = prizeMethodSucceeded;
    const blockedOn = blockedOnFor(item.prizeMethodBlocker, liveVerified, status.usable, status.remediation);
    return {
      track: item.track,
      capability: item.capability,
      probe: item.probe,
      prizeMethod: item.prizeMethod,
      verifiedBy: item.verifiedBy,
      state: prizeTrackState(liveVerified, probeLive, status.state),
      usable: status.usable,
      probeLive,
      prizeMethodSucceeded,
      liveVerified,
      missingSecrets: status.missingSecrets,
      blockedOn,
      remediation: blockedOn ?? status.remediation ?? null,
    };
  });
}

export function prizeTrackBlockers(capabilities: CapabilityRegistry): readonly PrizeTrackStatus[] {
  return prizeTrackSnapshot(capabilities).filter((row) => !row.liveVerified);
}

function prizeTrackState(
  liveVerified: boolean,
  probeLive: boolean,
  registryState: ActivationState,
): ActivationState {
  if (liveVerified) return 'live_verified';
  if (probeLive) return 'configured_unverified';
  return registryState;
}

function blockedOnFor(
  prizeMethodBlocker: string | null,
  liveVerified: boolean,
  usable: boolean,
  remediation: string | null,
): string | null {
  if (liveVerified) return null;
  if (!usable) return remediation;
  return prizeMethodBlocker ?? remediation;
}
