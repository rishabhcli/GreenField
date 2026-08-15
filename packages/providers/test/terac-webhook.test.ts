/**
 * Terac webhook contract: HMAC over timestamp+rawBody (no separator), and the
 * envelope is a refresh signal — never a fabricated submission.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Secret } from '@foundry/core';
import { verifyTeracSignature } from '../src/http/webhook-verify.js';
import { interpretTeracWebhookEvent, TeracWebhookEnvelope } from '../src/terac/events.js';

const BODY = '{"event_id":"evt_1","event_type":"submission.status.change","opportunity_id":"opp_1"}';
const SECRET = 'terac-signing-secret';

function sign(timestamp: number, body: string): string {
  return createHmac('sha256', SECRET).update(`${timestamp}${body}`).digest('base64');
}

describe('Terac webhook HMAC', () => {
  const secret = new Secret('TERAC_WEBHOOK_SECRET', SECRET, 'unknown');
  const nowSeconds = Math.floor(Date.now() / 1000);

  it('accepts HMAC-SHA256 over timestamp concatenated with the raw body', () => {
    const result = verifyTeracSignature({
      rawBody: BODY,
      headers: {
        'x-terac-request-signature': sign(nowSeconds, BODY),
        'x-terac-request-timestamp': String(nowSeconds),
        'x-event-id': 'evt_1',
      },
      secret,
      nowMs: nowSeconds * 1000,
    });
    expect(result.verified).toBe(true);
    expect(result.eventId).toBe('evt_1');
  });

  it('rejects a signature computed over timestamp.dot.body', () => {
    const wrong = createHmac('sha256', SECRET).update(`${nowSeconds}.${BODY}`).digest('base64');
    expect(() =>
      verifyTeracSignature({
        rawBody: BODY,
        headers: {
          'x-terac-request-signature': wrong,
          'x-terac-request-timestamp': String(nowSeconds),
        },
        secret,
        nowMs: nowSeconds * 1000,
      }),
    ).toThrow(/signature mismatch/);
  });
});

describe('interpretTeracWebhookEvent', () => {
  it('treats a handled event as a refresh of the named opportunity, not as a verdict', () => {
    const envelope = TeracWebhookEnvelope.parse({
      event_type: 'submission.status.change',
      opportunity_id: 'opp_live_1',
      data: { submission_id: 'sub_1' },
    });
    const result = interpretTeracWebhookEvent(envelope);
    expect(result).toEqual({
      action: 'refresh_submissions',
      signal: {
        eventType: 'submission.status.change',
        opportunityId: 'opp_live_1',
        submissionId: 'sub_1',
      },
    });
  });

  it('does not invent an opportunity id when the envelope has none', () => {
    const result = interpretTeracWebhookEvent(
      TeracWebhookEnvelope.parse({ event_type: 'submission.approved' }),
    );
    expect(result.action).toBe('ignored_no_identifier');
  });
});
