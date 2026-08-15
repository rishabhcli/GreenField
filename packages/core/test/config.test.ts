/**
 * Runtime config: WORKER_ROLE must not silently become `general`, and CORS
 * always includes the public origin.
 */

import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  loadRuntimeConfig,
  loadWorkerRole,
  parseWorkerRole,
  type EnvSource,
} from '@foundry/core';

function env(overrides: Record<string, string | undefined> = {}): EnvSource {
  const base: Record<string, string> = {
    APP_ENVIRONMENT: 'preview',
    PUBLIC_BASE_URL: 'https://api.example.test',
    DATABASE_URL: 'postgres://db.example.test:5432/foundry',
    REDIS_URL: 'redis://kv.example.test:6379',
  };
  return {
    get(name) {
      if (Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name];
      return base[name];
    },
  };
}

describe('parseWorkerRole', () => {
  it('accepts the two real roles', () => {
    expect(parseWorkerRole('general')).toBe('general');
    expect(parseWorkerRole('agents')).toBe('agents');
  });

  it('treats unset as undefined when not required, and general when required', () => {
    expect(parseWorkerRole(undefined)).toBeUndefined();
    expect(parseWorkerRole('')).toBeUndefined();
    expect(parseWorkerRole(undefined, { required: true })).toBe('general');
    expect(loadWorkerRole({ get: () => undefined })).toBe('general');
  });

  it('refuses a typo instead of falling through to general', () => {
    expect(() => parseWorkerRole('agent')).toThrow(ValidationError);
    expect(() => parseWorkerRole('agent')).toThrow(/WORKER_ROLE/);
    expect(() => parseWorkerRole('Agent')).toThrow(ValidationError);
  });
});

describe('loadRuntimeConfig', () => {
  it('throws on a present-but-invalid WORKER_ROLE even on a non-worker process', () => {
    expect(() => loadRuntimeConfig(env({ WORKER_ROLE: 'agent' }))).toThrow(ValidationError);
  });

  it('includes the PUBLIC_BASE_URL origin in CORS and stays fail-open in preview', () => {
    const cfg = loadRuntimeConfig(
      env({ CORS_ALLOWED_ORIGINS: 'https://shop.example.test, https://other.example.test' }),
    );
    expect(cfg.corsAllowedOrigins).toContain('https://api.example.test');
    expect(cfg.corsAllowedOrigins).toContain('https://shop.example.test');
    expect(cfg.corsAllowedOrigins).toContain('https://other.example.test');
    expect(cfg.corsFailClosed).toBe(false);
  });

  it('fails closed in production', () => {
    const cfg = loadRuntimeConfig(env({ APP_ENVIRONMENT: 'production' }));
    expect(cfg.corsFailClosed).toBe(true);
    expect(cfg.corsAllowedOrigins).toEqual(['https://api.example.test']);
  });

  it('leaves operatorApiToken unset when the env var is absent', () => {
    const cfg = loadRuntimeConfig(env());
    expect(cfg.operatorApiToken).toBeUndefined();
  });

  it('copies optional RENDER_STOREFRONT_SERVICE_ID onto runtime config', () => {
    expect(loadRuntimeConfig(env()).renderStorefrontServiceId).toBeUndefined();
    const cfg = loadRuntimeConfig(env({ RENDER_STOREFRONT_SERVICE_ID: 'srv-storefront-test' }));
    expect(cfg.renderStorefrontServiceId).toBe('srv-storefront-test');
  });
});
