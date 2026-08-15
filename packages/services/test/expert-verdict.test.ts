import { describe, expect, it } from 'vitest';
import { expertVerdictOverrides } from '../src/research/expert.js';

describe('expertVerdictOverrides', () => {
  const before = [
    { dimension: 'willingness_to_pay', raw: 40 },
    { dimension: 'pain_severity', raw: 55 },
    { dimension: 'safety_regulatory_risk', raw: 10 },
    { dimension: 'frequency', raw: 70 },
  ];

  it('writes grounded human overrides that change ranking dimensions', () => {
    const overrides = expertVerdictOverrides({
      verdict: 'approved',
      engagementId: 'ui73krvjvlip4x5vkruh7xkf',
      expertRef: 'gp-1',
      before,
      recordedAt: '2026-08-15T18:45:00.000Z',
    });
    expect(overrides.map((o) => o.dimension).sort()).toEqual(
      ['pain_severity', 'safety_regulatory_risk', 'willingness_to_pay'].sort(),
    );
    expect(overrides.find((o) => o.dimension === 'willingness_to_pay')?.newRaw).toBe(85);
    expect(overrides.find((o) => o.dimension === 'willingness_to_pay')?.previousRaw).toBe(40);
    expect(overrides.some((o) => o.dimension === 'frequency')).toBe(false);
  });

  it('raises safety_regulatory_risk on reject so inverted ranking falls', () => {
    const overrides = expertVerdictOverrides({
      verdict: 'rejected',
      engagementId: 'eng_1',
      expertRef: 'gp-2',
      before,
      recordedAt: '2026-08-15T18:45:00.000Z',
    });
    expect(overrides.find((o) => o.dimension === 'safety_regulatory_risk')?.newRaw).toBe(85);
    expect(overrides.find((o) => o.dimension === 'willingness_to_pay')?.newRaw).toBe(15);
  });
});
