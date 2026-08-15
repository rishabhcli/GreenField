/**
 * Missing-capability handling: blocked is not failed.
 *
 * Throwing on a missing key would make BullMQ retry a job that cannot succeed
 * until a human issues the credential, burning the retry budget.
 */

import { describe, expect, it } from 'vitest';
import { CredentialsMissingError, RateLimitError } from '@foundry/core';
import { tolerateMissingCapability } from '../src/handlers.js';

describe('tolerateMissingCapability', () => {
  it('turns CredentialsMissingError into a blocked result', async () => {
    const result = await tolerateMissingCapability(async () => {
      throw new CredentialsMissingError('brave', ['BRAVE_SEARCH_API_KEY']);
    });
    expect(result).toMatchObject({
      status: 'blocked',
      capability: 'brave',
    });
    expect(String((result as { reason: string }).reason)).toContain('BRAVE_SEARCH_API_KEY');
  });

  it('rethrows a rate limit so the queue retries', async () => {
    await expect(
      tolerateMissingCapability(async () => {
        throw new RateLimitError('anthropic', 12);
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});
