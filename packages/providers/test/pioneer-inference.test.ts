/**
 * Pioneer prize-track contract: native inference + OpenAI-compatible chat,
 * Fastino encoders as defaults, never a Claude proxy. Live inference 403 is
 * classified from the exact card_required body, not stubbed into success.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, SecretStore, ValidationError } from '@foundry/core';
import {
  PIONEER_GLIGUARD_MODEL,
  PIONEER_GLINER2_BASE_MODEL,
  PIONEER_GLINER2_PII_MODEL,
  PIONEER_OPEN_WEIGHT_CHAT_MODEL,
  PioneerAdapter,
  classifyPioneerError,
} from '../src/pioneer/index.js';

function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
}

loadDotenv(resolve(process.cwd(), '.env'));

/** Captured live POST /inference 2026-08-15. */
const LIVE_INFERENCE_403 = {
  detail: {
    code: 'card_required',
    message: 'To run inference on Pioneer, subscribe to the Hobby or Pro plan at https://agent.pioneer.ai/billing.',
    resolution_url: 'https://agent.pioneer.ai/billing',
  },
};

/** Captured live POST /v1/chat/completions 2026-08-15. */
const LIVE_CHAT_403 = {
  error: {
    message: 'To run inference on Pioneer, subscribe to the Hobby or Pro plan at https://agent.pioneer.ai/billing.',
    type: 'permission_error',
    param: null,
    code: null,
  },
};

describe('Pioneer native paths and prize-track models', () => {
  it('wires POST /inference and POST /v1/chat/completions, not Anthropic', () => {
    const inferSrc = PioneerAdapter.prototype.infer.toString();
    const chatSrc = PioneerAdapter.prototype.chat.toString();
    expect(inferSrc).toContain('/inference');
    expect(chatSrc).toContain('/v1/chat/completions');
    expect(inferSrc).not.toMatch(/anthropic|claude/i);
    expect(chatSrc).not.toMatch(/anthropic|claude/i);
  });

  it('defaults chat to an open-weight Fastino/Nemotron model, not Claude', () => {
    expect(PIONEER_OPEN_WEIGHT_CHAT_MODEL).not.toMatch(/claude/i);
    expect(PIONEER_OPEN_WEIGHT_CHAT_MODEL).toMatch(/Nemotron|Fastino|nvidia/i);
    expect(PIONEER_GLINER2_PII_MODEL).toBe('fastino/gliner2-privacy-filter-PII-multi');
    expect(PIONEER_GLIGUARD_MODEL).toBe('fastino/gliguard-LLMGuardrails-300M');
    expect(PIONEER_GLINER2_BASE_MODEL).toBe('fastino/gliner2-base-v1');
  });

  it('classifies the live inference 403 card_required body', () => {
    const error = classifyPioneerError(403, LIVE_INFERENCE_403);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error?.message).toBe(LIVE_INFERENCE_403.detail.message);
    expect(error?.context['code']).toBe('card_required');
    expect(error?.context['resolutionUrl']).toBe('https://agent.pioneer.ai/billing');
  });

  it('classifies the live chat-completions 403 billing body', () => {
    const error = classifyPioneerError(403, LIVE_CHAT_403);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error?.message).toContain('subscribe to the Hobby or Pro plan');
  });

  it('scanPii without a key does not return an empty stub list', async () => {
    const adapter = new PioneerAdapter({
      secrets: new SecretStore({ get: () => undefined }),
      environment: 'preview',
      publicBaseUrl: 'https://example.test',
    });
    await expect(adapter.scanPii('Jane Doe jane@example.com')).rejects.toBeInstanceOf(CredentialsMissingError);
  });
});

const live = process.env['LIVE_PROBES'] === '1' && Boolean(process.env['PIONEER_API_KEY']);

describe.skipIf(!live)('Pioneer live re-probe', () => {
  it('catalog includes GLiNER2/GLiGuard; inference still returns card_required or succeeds', async () => {
    const pioneer = new PioneerAdapter({
      secrets: new SecretStore(),
      environment: 'production',
      publicBaseUrl: 'https://example.test',
    });
    const probe = await pioneer.probe();
    expect(probe.succeeded).toBe(true);
    expect(probe.evidence['bonusModels']).toEqual([
      PIONEER_GLINER2_PII_MODEL,
      PIONEER_GLIGUARD_MODEL,
      PIONEER_GLINER2_BASE_MODEL,
    ]);

    try {
      await pioneer.scanPii('Contact Jane Doe at jane.doe@example.com');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const foundry = error as ValidationError;
      expect(foundry.message).toMatch(/Hobby or Pro plan|card_required|billing/i);
      expect(String(foundry.context['code'] ?? '')).toMatch(/card_required|^$/);
      return;
    }
    // If billing starts authorizing inference, this is a real success — not a stub.
  });
});
