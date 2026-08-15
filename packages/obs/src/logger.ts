/**
 * Structured logging.
 *
 * Render aggregates stdout, so logs are JSON lines with a stable shape. The
 * redaction list is not advisory: `Secret` instances already refuse to
 * serialise, and this catches the raw-string cases that slip past them.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger as PinoLogger } from 'pino';
import { describeError } from '@foundry/core';

export interface RequestContext {
  /** Correlates every log line, audit event and provider call in one request. */
  readonly traceId: string;
  readonly companyId?: string;
  /** Agent run that caused this work, when applicable. */
  readonly runId?: string;
  readonly actorId?: string;
  readonly jobId?: string;
  readonly route?: string;
}

const contextStorage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return contextStorage.getStore();
}

export function withContext<T>(context: RequestContext, fn: () => T): T {
  return contextStorage.run(context, fn);
}

/** Paths whose values are replaced with `[redacted]` before a line is written. */
const REDACT_PATHS = [
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'authorization',
  'Authorization',
  'cookie',
  'set-cookie',
  '*.password',
  '*.secret',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["stripe-signature"]',
  'req.headers["webhook-signature"]',
  'headers.authorization',
  'headers["x-api-key"]',
  'config.headers.Authorization',
];

export interface LoggerOptions {
  readonly level: string;
  readonly serviceName: string;
  readonly environment: string;
  readonly instanceId: string;
  readonly releaseSha: string;
  /** Pretty output is never used in a deployed environment. */
  readonly pretty?: boolean;
}

export type Logger = PinoLogger;

let rootLogger: Logger | undefined;

export function initLogger(options: LoggerOptions): Logger {
  rootLogger = pino({
    level: options.level,
    base: {
      service: options.serviceName,
      env: options.environment,
      instance: options.instanceId,
      release: options.releaseSha,
    },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Attach the ambient trace context to every line without threading it
    // through every call site.
    mixin() {
      const ctx = currentContext();
      return ctx ? { ...ctx } : {};
    },
    serializers: {
      err: (value: unknown) => describeError(value),
      error: (value: unknown) => describeError(value),
    },
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
      : {}),
  });
  return rootLogger;
}

export function getLogger(): Logger {
  if (!rootLogger) {
    // A service that logs before configuring logging still gets valid JSON
    // rather than throwing during startup diagnostics.
    rootLogger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', redact: { paths: REDACT_PATHS, censor: '[redacted]' } });
  }
  return rootLogger;
}

export function childLogger(bindings: Record<string, unknown>): Logger {
  return getLogger().child(bindings);
}
