/**
 * BAND key prefixes: live dashboard keys are band_u_/band_a_; legacy Thenvoi
 * keys are thnv_u_/thnv_a_. Hyphens appear in issued keys.
 */

import { describe, expect, it } from 'vitest';
import { SecretStore, ValidationError } from '@foundry/core';
import { SECRETS } from '../src/manifests.js';

describe('BAND secret shapes', () => {
  it('accepts a live dashboard human key with band_u_ prefix and hyphens', () => {
    const store = new SecretStore({
      get: (name) => (name === 'BAND_USER_API_KEY' ? 'band_u_1786812389_example-key' : undefined),
    });
    expect(store.tryGet(SECRETS.bandUserApiKey)?.env).toBe('BAND_USER_API_KEY');
  });

  it('accepts a legacy Thenvoi agent key', () => {
    const store = new SecretStore({
      get: (name) => (name === 'BAND_AGENT_API_KEY' ? 'thnv_a_abc123XYZ' : undefined),
    });
    expect(store.tryGet(SECRETS.bandAgentApiKey)?.env).toBe('BAND_AGENT_API_KEY');
  });

  it('rejects a key that matches neither prefix', () => {
    const store = new SecretStore({
      get: (name) => (name === 'BAND_AGENT_API_KEY' ? 'not-a-band-key' : undefined),
    });
    expect(() => store.tryGet(SECRETS.bandAgentApiKey)).toThrow(ValidationError);
  });
});
