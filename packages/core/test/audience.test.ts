/**
 * Audience segment projection.
 *
 * These pin the shape handed to the ad platforms. The Meta launch path passes
 * `audience_spec.targeting` straight into `POST /adsets`, so a wrong key name
 * here is not a type error — it is money spent on broader targeting than asked
 * for, discovered only from the invoice.
 */

import { describe, expect, it } from 'vitest';
import {
  AudienceSegment,
  audienceSpecFor,
  toGoogleTargeting,
  toMetaTargeting,
} from '../src/domain/marketing.js';

function segment(overrides: Record<string, unknown> = {}): AudienceSegment {
  return AudienceSegment.parse({
    id: 'aud_01',
    companyId: 'co_01',
    opportunityId: null,
    name: 'Home baristas',
    description: 'People who grind their own beans and complain about static.',
    geo: { countries: ['US', 'CA'], regions: [], cities: [] },
    ageRange: { min: 25, max: 44 },
    gender: 'all',
    interests: ['espresso'],
    languages: ['en'],
    evidenceIds: ['evd_01'],
    grounded: true,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  });
}

describe('AudienceSegment schema', () => {
  it('refuses a segment that cites no evidence', () => {
    expect(() => segment({ evidenceIds: [] })).toThrow();
  });

  it('refuses a segment with no country to target', () => {
    expect(() => segment({ geo: { countries: [], regions: [], cities: [] } })).toThrow();
  });

  it('refuses an inverted age range', () => {
    expect(() => segment({ ageRange: { min: 44, max: 25 } })).toThrow();
  });

  it('refuses ages outside the range Meta accepts', () => {
    expect(() => segment({ ageRange: { min: 12, max: 40 } })).toThrow();
    expect(() => segment({ ageRange: { min: 25, max: 66 } })).toThrow();
  });

  it('refuses a lowercase or malformed country code', () => {
    expect(() => segment({ geo: { countries: ['us'], regions: [], cities: [] } })).toThrow();
    expect(() => segment({ geo: { countries: ['USA'], regions: [], cities: [] } })).toThrow();
  });
});

describe('toMetaTargeting', () => {
  it('emits geo_locations, age bounds and locales in Meta field names', () => {
    const t = toMetaTargeting(segment());
    expect(t['geo_locations']).toEqual({ countries: ['US', 'CA'] });
    expect(t['age_min']).toBe(25);
    expect(t['age_max']).toBe(44);
    expect(t['locales']).toEqual(['en']);
  });

  it('omits genders entirely when the segment targets everyone', () => {
    expect(toMetaTargeting(segment())).not.toHaveProperty('genders');
  });

  it('encodes gender as Meta numeric codes', () => {
    expect(toMetaTargeting(segment({ gender: 'male' }))['genders']).toEqual([1]);
    expect(toMetaTargeting(segment({ gender: 'female' }))['genders']).toEqual([2]);
  });

  it('sends interest names under interests_by_name, never interests', () => {
    // Meta's `interests` takes numeric ids from its own taxonomy. A name posted
    // there is dropped silently and the ad set runs untargeted.
    const t = toMetaTargeting(segment());
    expect(t['interests_by_name']).toEqual(['espresso']);
    expect(t).not.toHaveProperty('interests');
  });

  it('omits empty optional blocks rather than sending empty arrays', () => {
    const t = toMetaTargeting(segment({ interests: [], languages: [] }));
    expect(t).not.toHaveProperty('interests_by_name');
    expect(t).not.toHaveProperty('locales');
  });

  it('wraps regions and cities as keyed objects', () => {
    const t = toMetaTargeting(segment({ geo: { countries: ['US'], regions: ['3847'], cities: ['2418779'] } }));
    expect(t['geo_locations']).toEqual({
      countries: ['US'],
      regions: [{ key: '3847' }],
      cities: [{ key: '2418779' }],
    });
  });
});

describe('audienceSpecFor', () => {
  it('produces the targeting key the Meta ad-set builder requires', () => {
    // experiments.ts blocks launch unless audience_spec.targeting is an object.
    const spec = audienceSpecFor(segment(), 'meta');
    expect(typeof spec['targeting']).toBe('object');
    expect(spec['targeting']).not.toBeNull();
  });

  it('keeps the segment id and evidence on the experiment for traceability', () => {
    const spec = audienceSpecFor(segment(), 'meta');
    expect(spec['segmentId']).toBe('aud_01');
    expect(spec['evidenceIds']).toEqual(['evd_01']);
  });

  it('projects Google targeting for a google experiment', () => {
    const spec = audienceSpecFor(segment(), 'google');
    expect(spec['targeting']).toEqual(toGoogleTargeting(segment()));
    expect(spec['targeting']).not.toHaveProperty('geo_locations');
  });
});
