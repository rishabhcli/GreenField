/**
 * Production topology on Render: localhost is a development convenience,
 * never the deployed system. `assertProductionTopology` is the boot gate
 * `packages/runtime` already calls; this file pins the Render-owned cases.
 */

import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  assertProductionTopology,
  loadRuntimeConfig,
  type EnvSource,
} from '@foundry/core';
import { RENDER_MANIFEST } from '../src/manifests.js';

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

describe('assertProductionTopology', () => {
  it('refuses production pointed at localhost DATABASE_URL', () => {
    const cfg = loadRuntimeConfig(
      env({
        APP_ENVIRONMENT: 'production',
        DATABASE_URL: 'postgres://localhost:5432/foundry',
      }),
    );
    expect(() => assertProductionTopology(cfg)).toThrow(ValidationError);
    expect(() => assertProductionTopology(cfg)).toThrow(/DATABASE_URL/);
    expect(() => assertProductionTopology(cfg)).toThrow(/local endpoints/);
  });

  it('refuses production PUBLIC_BASE_URL on localhost', () => {
    const cfg = loadRuntimeConfig(
      env({
        APP_ENVIRONMENT: 'production',
        PUBLIC_BASE_URL: 'https://localhost:10000',
      }),
    );
    expect(() => assertProductionTopology(cfg)).toThrow(/PUBLIC_BASE_URL/);
  });

  it('refuses production REDIS_URL on 127.0.0.1', () => {
    const cfg = loadRuntimeConfig(
      env({
        APP_ENVIRONMENT: 'production',
        REDIS_URL: 'redis://127.0.0.1:6379',
      }),
    );
    expect(() => assertProductionTopology(cfg)).toThrow(/REDIS_URL/);
  });

  it('allows production with hosted Render endpoints', () => {
    const cfg = loadRuntimeConfig(
      env({
        APP_ENVIRONMENT: 'production',
        PUBLIC_BASE_URL: 'https://foundry-api-8ih0.onrender.com',
        DATABASE_URL: 'postgres://dpg-example.oregon-postgres.render.com:5432/foundry',
        REDIS_URL: 'redis://red-example:6379',
      }),
    );
    expect(() => assertProductionTopology(cfg)).not.toThrow();
  });

  it('does not apply the localhost refusal in preview', () => {
    const cfg = loadRuntimeConfig(
      env({
        APP_ENVIRONMENT: 'preview',
        PUBLIC_BASE_URL: 'http://localhost:3000',
        DATABASE_URL: 'postgres://localhost:5432/foundry',
        REDIS_URL: 'redis://127.0.0.1:6379',
      }),
    );
    expect(() => assertProductionTopology(cfg)).not.toThrow();
  });
});

describe('Render probe is not the prize pass', () => {
  it('documents GET /v1/services as the live probe, not a deploy or task-run', () => {
    expect(RENDER_MANIFEST.liveProbe.description).toMatch(/GET \/v1\/services/);
    expect(RENDER_MANIFEST.liveProbe.mutatesState).toBe(false);
    expect(RENDER_MANIFEST.baseUrls.production).toBe('https://api.render.com/v1');
  });
});
