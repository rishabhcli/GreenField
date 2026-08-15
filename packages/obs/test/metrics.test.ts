/**
 * Prometheus text exposition: identity labels, escaping, histogram +Inf.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Counter, Histogram, configureMetricIdentity, escapeLabelValue } from '@foundry/obs';

beforeEach(() => {
  configureMetricIdentity({});
});
afterEach(() => {
  configureMetricIdentity({});
});

describe('escapeLabelValue', () => {
  it('escapes backslash, newline and quote so the exposition stays valid', () => {
    expect(escapeLabelValue('plain')).toBe('plain');
    expect(escapeLabelValue('a"b')).toBe('a\\"b');
    expect(escapeLabelValue('a\\b')).toBe('a\\\\b');
    expect(escapeLabelValue('a\nb')).toBe('a\\nb');
  });
});

describe('metric identity', () => {
  it('merges identity labels at render time, not at inc time', () => {
    const counter = new Counter('foundry_test_identity_total', 'identity merge');
    counter.inc({ route: '/x' });
    configureMetricIdentity({ service: 'foundry-api', instance: 'abc' });
    const text = counter.render();
    expect(text).toContain('foundry_test_identity_total{instance="abc",route="/x",service="foundry-api"} 1');
  });

  it('still emits identity labels on an empty counter', () => {
    configureMetricIdentity({ service: 'foundry-worker', instance: 'i1' });
    const counter = new Counter('foundry_test_empty_total', 'empty series');
    expect(counter.render()).toContain(
      'foundry_test_empty_total{instance="i1",service="foundry-worker"} 0',
    );
  });
});

describe('Histogram', () => {
  it('emits a +Inf bucket equal to the observation count', () => {
    const histogram = new Histogram('foundry_test_duration_seconds', 'durations', [0.1, 1]);
    histogram.observe(0.05);
    histogram.observe(2);
    const text = histogram.render();
    expect(text).toContain('le="0.1"');
    expect(text).toContain('le="1"');
    expect(text).toContain('le="+Inf"');
    expect(text).toMatch(/foundry_test_duration_seconds_bucket\{le="\+Inf"\} 2/);
    expect(text).toMatch(/foundry_test_duration_seconds_count 2/);
  });
});
