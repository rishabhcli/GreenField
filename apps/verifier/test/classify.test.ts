/**
 * Probe classification: missing credentials are blocked, not failed.
 */

import { describe, expect, it } from 'vitest';
import { classifyProbe } from '../src/classify.js';

describe('classifyProbe', () => {
  it('classifies missing/malformed credentials and vendor approval as blocked', () => {
    expect(classifyProbe('blocked_missing_credentials', false)).toBe('blocked');
    expect(classifyProbe('blocked_malformed_credentials', false)).toBe('blocked');
    expect(classifyProbe('blocked_vendor_approval', false)).toBe('blocked');
    expect(classifyProbe('disabled_by_policy', false)).toBe('blocked');
    expect(classifyProbe('unsupported_by_provider', false)).toBe('blocked');
  });

  it('classifies a probe that ran and failed as failed', () => {
    expect(classifyProbe('degraded', false)).toBe('failed');
    expect(classifyProbe('configured_unverified', false)).toBe('failed');
  });

  it('classifies a successful probe as probe_ok, never as a prize-method pass', () => {
    expect(classifyProbe('live_verified', true)).toBe('probe_ok');
    expect(classifyProbe('configured_unverified', true)).toBe('probe_ok');
  });
});
