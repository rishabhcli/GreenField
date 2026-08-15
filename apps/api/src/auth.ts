/**
 * Operator authentication.
 *
 * Deliberately fails closed: with no token configured, every protected
 * route is refused rather than left open. An unprotected `/metrics` or
 * approval endpoint would make the controls decorative.
 *
 * Shared by governance routes and `/metrics` so there is one comparison,
 * not two that can drift.
 */

import { PolicyDeniedError } from '@foundry/core';

const OPERATOR_TOKEN_ENV = 'OPERATOR_API_TOKEN';

export async function requireOperator(
  request: { headers: Record<string, unknown> },
  configured: string | undefined,
): Promise<string> {
  if (!configured) {
    throw new PolicyDeniedError(
      `${OPERATOR_TOKEN_ENV} is not configured, so operator actions are refused. ` +
        `Set it on the Render service to enable the approval, kill-switch and metrics controls.`,
    );
  }
  const header = request.headers['authorization'];
  const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!presented || !timingSafeEqual(presented, configured)) {
    throw new PolicyDeniedError('Operator token missing or invalid.');
  }
  return 'operator';
}

/** Constant-time compare, so a token cannot be guessed byte by byte. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
