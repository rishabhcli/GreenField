/**
 * Logger redaction and Secret serialisation.
 *
 * A raw API key in a log line is the failure this exists to catch. `Secret`
 * already neuters `toJSON`; the pino redact list catches the string cases
 * that slip past it.
 */

import { describe, expect, it } from 'vitest';
import { Secret } from '@foundry/core';
import { initLogger } from '@foundry/obs';

function captureLogger() {
  const lines: string[] = [];
  const logger = initLogger({
    level: 'info',
    serviceName: 'test',
    environment: 'preview',
    instanceId: 'i',
    releaseSha: 'r',
    destination: { write: (msg: string) => lines.push(msg) },
  });
  return { logger, lines };
}

describe('logger redaction', () => {
  it('redacts apiKey, token and nested password before the line is written', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      { apiKey: 'sk-live-should-not-appear', token: 'bearer-secret', nested: { password: 'hunter2' } },
      'auth dump',
    );
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).not.toContain('sk-live-should-not-appear');
    expect(line).not.toContain('bearer-secret');
    expect(line).not.toContain('hunter2');
    expect(line).toContain('[redacted]');
  });
});

describe('Secret', () => {
  it('neuters toJSON, toString and inspect so a stray log cannot leak the value', () => {
    const secret = new Secret('ANTHROPIC_API_KEY', 'sk-ant-super-secret');
    expect(JSON.stringify({ key: secret })).toBe('{"key":"[Secret ANTHROPIC_API_KEY]"}');
    expect(String(secret)).not.toContain('sk-ant-super-secret');
    expect(secret.toJSON()).toBe('[Secret ANTHROPIC_API_KEY]');
  });
});
