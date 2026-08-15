/**
 * Audience segments must be traceable to evidence this company collected.
 *
 * The point of the segment table is that ad spend is aimed at an audience
 * somebody observed. These tests pin the two ways that can be faked: citing
 * nothing, and citing evidence that belongs to someone else or does not exist.
 */

import { describe, expect, it } from 'vitest';
import { ValidationError } from '@foundry/core';
import type { ServiceDeps } from '../src/deps.js';
import { AudienceSegmentService } from '../src/marketing/audience.js';

const COMPANY = 'co_01M03F7RQW2M6540BY2GZHCFBW';
const OTHER_COMPANY = 'co_99OTHER';

interface EvidenceStub {
  id: string;
  company_id: string;
  provenance: Record<string, unknown>;
}

function deps(evidence: readonly EvidenceStub[], created: { last?: unknown } = {}): ServiceDeps {
  return {
    repos: {
      research: {
        evidence: {
          byIds: async (ids: readonly string[]) => evidence.filter((e) => ids.includes(e.id)),
        },
      },
      growth: {
        audience: {
          create: async (input: unknown) => {
            created.last = input;
            return { id: 'aud_created' };
          },
        },
      },
    },
  } as unknown as ServiceDeps;
}

const base = {
  companyId: COMPANY,
  name: 'Home baristas',
  description: 'Grind their own beans, complain about static cling.',
  countries: ['US'],
  ageMin: 25,
  ageMax: 44,
};

describe('AudienceSegmentService.defineSegment', () => {
  it('refuses a segment that cites no evidence', async () => {
    const service = new AudienceSegmentService(deps([]));
    await expect(service.defineSegment({ ...base, evidenceIds: [] })).rejects.toThrow(ValidationError);
  });

  it('names the evidence ids that do not resolve', async () => {
    const service = new AudienceSegmentService(deps([]));
    await expect(service.defineSegment({ ...base, evidenceIds: ['evd_missing'] })).rejects.toThrow(
      /evd_missing/,
    );
  });

  it('refuses evidence belonging to another company', async () => {
    // Otherwise a segment looks grounded while being derived from research this
    // company never did.
    const service = new AudienceSegmentService(
      deps([{ id: 'evd_1', company_id: OTHER_COMPANY, provenance: { method: 'http_fetch' } }]),
    );
    await expect(service.defineSegment({ ...base, evidenceIds: ['evd_1'] })).rejects.toThrow(/evd_1/);
  });

  it('marks the segment grounded when every cited item was fetched', async () => {
    const created: { last?: unknown } = {};
    const service = new AudienceSegmentService(
      deps(
        [
          { id: 'evd_1', company_id: COMPANY, provenance: { method: 'http_fetch' } },
          { id: 'evd_2', company_id: COMPANY, provenance: { method: 'browser_session' } },
        ],
        created,
      ),
    );
    const result = await service.defineSegment({ ...base, evidenceIds: ['evd_1', 'evd_2'] });
    expect(result.grounded).toBe(true);
    expect(result.evidenceCount).toBe(2);
    expect((created.last as { grounded: boolean }).grounded).toBe(true);
  });

  it('is not grounded when any cited item was first-party rather than fetched', async () => {
    const service = new AudienceSegmentService(
      deps([
        { id: 'evd_1', company_id: COMPANY, provenance: { method: 'http_fetch' } },
        { id: 'evd_2', company_id: COMPANY, provenance: { method: 'first_party' } },
      ]),
    );
    const result = await service.defineSegment({ ...base, evidenceIds: ['evd_1', 'evd_2'] });
    expect(result.grounded).toBe(false);
  });

  it('does not let the caller assert grounding for itself', async () => {
    // grounded is derived from provenance, never accepted as input.
    const created: { last?: unknown } = {};
    const service = new AudienceSegmentService(
      deps([{ id: 'evd_1', company_id: COMPANY, provenance: { method: 'unknown_method' } }], created),
    );
    await service.defineSegment({
      ...base,
      evidenceIds: ['evd_1'],
      ...({ grounded: true } as Record<string, never>),
    });
    expect((created.last as { grounded: boolean }).grounded).toBe(false);
  });

  it('deduplicates repeated evidence ids before counting them', async () => {
    const service = new AudienceSegmentService(
      deps([{ id: 'evd_1', company_id: COMPANY, provenance: { method: 'public_api' } }]),
    );
    const result = await service.defineSegment({ ...base, evidenceIds: ['evd_1', 'evd_1', 'evd_1'] });
    expect(result.evidenceCount).toBe(1);
  });

  it('normalises country codes to uppercase for the platforms', async () => {
    const created: { last?: unknown } = {};
    const service = new AudienceSegmentService(
      deps([{ id: 'evd_1', company_id: COMPANY, provenance: { method: 'public_api' } }], created),
    );
    await service.defineSegment({ ...base, countries: ['us', 'ca'], evidenceIds: ['evd_1'] });
    expect((created.last as { geo: { countries: string[] } }).geo.countries).toEqual(['US', 'CA']);
  });
});
