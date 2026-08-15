/**
 * Prize-track snapshot must not treat adapter.probe() (catalog / GET /projects)
 * as a prize-method pass.
 */

import { describe, expect, it } from 'vitest';
import {
  CapabilityRegistry,
  SecretStore,
  type Capability,
  type ProviderId,
  type ProviderManifest,
  type VerificationRecord,
} from '@foundry/core';
import {
  LINQ_AGENT_PAY_BLOCKER,
  PIONEER_INFERENCE_BLOCKER,
  PRIZE_TRACKS,
  RENDER_WORKFLOW_BLOCKER,
  REPLAY_QA_BLOCKER,
  TERAC_STUDY_BLOCKER,
  prizeTrackSnapshot,
} from '../src/org/prize-tracks.js';

function stub(
  id: ProviderId,
  capabilities: readonly Capability[],
  probe: string,
  env: string,
): ProviderManifest {
  return {
    id,
    displayName: id,
    tier: 'sponsor',
    summary: id,
    docs: [{ url: 'https://example.test', verifiedOn: '2026-08-15' }],
    authMethod: 'api_key_header',
    secrets: [{ env, description: 'test key', required: true, obtainFrom: 'test' }],
    baseUrls: { production: 'https://example.test' },
    capabilities: capabilities.map((capability) => ({
      capability,
      priority: 1,
      evidence: { kind: 'documented_api', detail: probe },
    })),
    liveProbe: { description: probe, mutatesState: false },
    failureBehaviour: 'x',
    retryStrategy: 'x',
    idempotency: 'x',
  };
}

const MANIFESTS: readonly ProviderManifest[] = [
  stub('terac', ['expert.structured_review'], 'GET /projects', 'TERAC_API_KEY'),
  stub('stripe', ['payments.checkout.physical', 'payments.payment_link'], 'GET /v1/balance', 'STRIPE_SECRET_KEY'),
  stub('linq', ['payments.imessage_checkout', 'messaging.imessage_app'], 'GET /v3/phone_numbers', 'LINQ_API_V3_API_KEY'),
  stub('replay', ['qa.autonomous_exploration'], 'GET /projects', 'REPLAY_API_KEY'),
  stub('superserve', ['compute.persistent_sandbox'], 'GET /sandboxes', 'SUPERSERVE_API_KEY'),
  stub('pioneer', ['compliance.pii_scan', 'compliance.prompt_guard'], 'GET /base-models', 'PIONEER_API_KEY'),
  stub('band', ['coordination.agent_mesh'], 'GET /agent/me', 'BAND_AGENT_API_KEY'),
  stub('render', ['platform.workflows', 'platform.deploy_control'], 'GET /v1/services', 'RENDER_API_KEY'),
  stub('lovable', ['site.generate'], 'MCP tools/call get_me', 'LOVABLE_OAUTH_ACCESS_TOKEN'),
  stub('solari', ['research.browser_session'], 'GET /health', 'SOLARI_API_KEY'),
];

const PROBE_LIVE: readonly ProviderId[] = [
  'terac',
  'stripe',
  'linq',
  'replay',
  'superserve',
  'pioneer',
  'band',
  'render',
  'solari',
];

function registry(verified: readonly ProviderId[] = PROBE_LIVE): CapabilityRegistry {
  const present = new Set(verified);
  const envByProvider = new Map(MANIFESTS.map((m) => [m.id, m.secrets[0]!.env] as const));
  return new CapabilityRegistry({
    manifests: MANIFESTS,
    secrets: new SecretStore({
      get: (name) => {
        for (const [provider, env] of envByProvider) {
          if (present.has(provider) && env === name) return 'present';
        }
        return undefined;
      },
    }),
    verifications: {
      latest: (provider): VerificationRecord | undefined =>
        present.has(provider)
          ? {
              provider,
              capability: null,
              succeeded: true,
              checkedAt: new Date('2026-08-15T18:40:37Z'),
              detail: 'probe',
              evidence: {},
            }
          : undefined,
    },
  });
}

function row(
  tracks: readonly ReturnType<typeof prizeTrackSnapshot>[number],
  capability: (typeof PRIZE_TRACKS)[number]['capability'],
) {
  const found = tracks.find((t) => t.capability === capability);
  if (!found) throw new Error(`missing track ${capability}`);
  return found;
}

describe('prizeTrackSnapshot', () => {
  it('does not mark prize-method tracks live_verified from catalog/list probes', () => {
    const tracks = prizeTrackSnapshot(registry());

    const agentPay = row(tracks, 'payments.imessage_checkout');
    expect(agentPay.probeLive).toBe(true);
    expect(agentPay.liveVerified).toBe(false);
    expect(agentPay.prizeMethodSucceeded).toBe(false);
    expect(agentPay.state).toBe('configured_unverified');
    expect(agentPay.blockedOn).toBe(LINQ_AGENT_PAY_BLOCKER);

    const pii = row(tracks, 'compliance.pii_scan');
    expect(pii.probeLive).toBe(true);
    expect(pii.liveVerified).toBe(false);
    expect(pii.blockedOn).toBe(PIONEER_INFERENCE_BLOCKER);

    const guard = row(tracks, 'compliance.prompt_guard');
    expect(guard.probeLive).toBe(true);
    expect(guard.liveVerified).toBe(false);
    expect(guard.blockedOn).toBe(PIONEER_INFERENCE_BLOCKER);

    const workflows = row(tracks, 'platform.workflows');
    expect(workflows.probeLive).toBe(true);
    expect(workflows.liveVerified).toBe(false);
    expect(workflows.blockedOn).toBe(RENDER_WORKFLOW_BLOCKER);

    const terac = row(tracks, 'expert.structured_review');
    expect(terac.probeLive).toBe(true);
    expect(terac.liveVerified).toBe(false);
    expect(terac.blockedOn).toBe(TERAC_STUDY_BLOCKER);
    expect(terac.blockedOn).toContain('$5.00 minimum');
    expect(terac.blockedOn).toContain('Available: $0.00');

    const replay = row(tracks, 'qa.autonomous_exploration');
    expect(replay.probeLive).toBe(true);
    expect(replay.liveVerified).toBe(false);
    expect(replay.blockedOn).toBe(REPLAY_QA_BLOCKER);
    expect(replay.blockedOn).toContain('"running"');
  });

  it('keeps Band, Stripe payment-link, Linq link, and Render deploys live when those probes succeeded', () => {
    const tracks = prizeTrackSnapshot(registry());

    expect(row(tracks, 'coordination.agent_mesh').liveVerified).toBe(true);
    expect(row(tracks, 'coordination.agent_mesh').blockedOn).toBeNull();

    expect(row(tracks, 'payments.payment_link').liveVerified).toBe(true);
    expect(row(tracks, 'payments.checkout.physical').liveVerified).toBe(true);

    const link = row(tracks, 'messaging.imessage_app');
    expect(link.probeLive).toBe(true);
    expect(link.liveVerified).toBe(true);
    expect(link.blockedOn).toBeNull();

    expect(row(tracks, 'platform.deploy_control').liveVerified).toBe(true);
    expect(row(tracks, 'compute.persistent_sandbox').liveVerified).toBe(true);
    expect(row(tracks, 'research.browser_session').liveVerified).toBe(true);
  });

  it('leaves Lovable blocked on missing OAuth rather than a fake pass', () => {
    const lovable = row(prizeTrackSnapshot(registry()), 'site.generate');
    expect(lovable.probeLive).toBe(false);
    expect(lovable.liveVerified).toBe(false);
    expect(lovable.missingSecrets).toContain('LOVABLE_OAUTH_ACCESS_TOKEN');
    expect(lovable.blockedOn).toMatch(/LOVABLE_OAUTH_ACCESS_TOKEN/);
  });
});
