/**
 * Fastify error handler.
 *
 * Fastify (and `@fastify/sensible`) read `error.statusCode`. Foundry errors
 * expose `httpStatus` instead, so an unmapped throw is sent as 500
 * `{ code: internal }` even when the category is validation or conflict.
 *
 * Stamp `statusCode` from `httpStatus` before the reply is serialised.
 * Unclassified Errors stay 500 — this does not hide real bugs.
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { describeError, isFoundryError, type FoundryError } from '@foundry/core';
import { getLogger } from '@foundry/obs';

type ErrorShape = {
  httpStatus?: unknown;
  statusCode?: unknown;
  status?: unknown;
  category?: unknown;
  code?: unknown;
  message?: unknown;
  retryAfterSeconds?: unknown;
  cause?: unknown;
  name?: unknown;
  issues?: unknown;
};

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599;
}

function walkCauses(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 6; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    current = (current as ErrorShape).cause;
  }
  return chain;
}

function asFoundry(error: unknown): FoundryError | undefined {
  for (const node of walkCauses(error)) {
    if (isFoundryError(node)) return node;
    const shape = node as ErrorShape;
    // Duck-type in case `instanceof` fails across duplicate @foundry/core copies.
    if (
      isHttpStatus(shape.httpStatus) &&
      typeof shape.category === 'string' &&
      typeof shape.message === 'string'
    ) {
      return node as FoundryError;
    }
  }
  return undefined;
}

function isZodLike(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const shape = error as ErrorShape;
  if (shape.name === 'ZodError') return true;
  return Array.isArray(shape.issues) && !isHttpStatus(shape.httpStatus) && !asFoundry(error);
}

/**
 * HTTP status Fastify should send. Prefers Foundry `httpStatus` (including on
 * `error.cause`) over a Fastify-stamped `statusCode: 500`.
 */
export function httpStatusForError(error: unknown): number {
  const foundry = asFoundry(error);
  if (foundry) return foundry.httpStatus;
  if (isZodLike(error)) return 400;

  const shape = error as ErrorShape;
  if (isHttpStatus(shape.statusCode)) return shape.statusCode;
  if (isHttpStatus(shape.status)) return shape.status;
  return 500;
}

/** Copy Foundry `httpStatus` onto Fastify's `statusCode` so the reply is not 500. */
export function stampFastifyStatusCode(error: unknown): number {
  const status = httpStatusForError(error);
  if (error && typeof error === 'object') {
    (error as { statusCode: number }).statusCode = status;
  }
  return status;
}

export function foundryErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const log = getLogger();
  const status = stampFastifyStatusCode(error);
  const foundry = asFoundry(error);
  const described = describeError(foundry ?? error);

  if (status >= 500) {
    log.error({ err: described, route: request.url }, 'unhandled request error');
  } else {
    log.warn({ err: described, route: request.url }, 'request rejected');
  }

  const code = foundry
    ? foundry.code
    : isZodLike(error)
      ? 'validation'
      : String(described['code'] ?? 'internal');
  const message =
    status >= 500
      ? 'Internal error'
      : foundry
        ? foundry.message
        : isZodLike(error)
          ? error instanceof Error
            ? error.message
            : 'Invalid request'
          : String(described['message'] ?? 'Request rejected');

  return reply.code(status).send({
    error: {
      code,
      message,
      traceId: (request as { traceId?: string }).traceId,
      ...(foundry?.retryAfterSeconds ? { retryAfterSeconds: foundry.retryAfterSeconds } : {}),
    },
  });
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(foundryErrorHandler);
}
