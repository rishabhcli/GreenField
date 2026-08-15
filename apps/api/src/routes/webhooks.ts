/**
 * Inbound webhook ingestion.
 *
 * Webhooks are the authoritative source of money state, so this route is the
 * most security-sensitive surface in the system. The order of operations is
 * fixed and non-negotiable:
 *
 *   1. Verify the signature over the exact raw bytes. An unverified body is
 *      never parsed as anything but bytes.
 *   2. Record the event, keyed on (provider, external event id). A redelivery
 *      is acknowledged immediately and does no work.
 *   3. Enqueue processing and return 2xx fast. Providers expect a reply within
 *      seconds (Whop: 5s) and retry aggressively otherwise.
 *
 * Processing never happens inline. Doing the work before replying is how a slow
 * database turns one provider retry into a thundering herd.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ValidationError, describeError } from '@foundry/core';
import { getLogger, metrics } from '@foundry/obs';
import { verifyWebhook, type WebhookScheme } from '@foundry/providers';
import { SECRETS } from '@foundry/providers';
import type { AppContext } from '@foundry/runtime';

/** Which verifier and secret each provider's endpoint uses. */
const PROVIDER_WEBHOOKS: Record<
  string,
  { scheme: WebhookScheme; secretEnv: keyof typeof SECRETS; eventIdPath: readonly string[]; eventTypePath: readonly string[] }
> = {
  stripe: {
    scheme: 'stripe',
    secretEnv: 'stripeWebhookSecret',
    eventIdPath: ['id'],
    eventTypePath: ['type'],
  },
  whop: {
    scheme: 'standard_webhooks',
    secretEnv: 'whopWebhookSecret',
    eventIdPath: ['id'],
    eventTypePath: ['type'],
  },
  dodo: {
    scheme: 'standard_webhooks',
    secretEnv: 'dodoWebhookSecret',
    eventIdPath: ['business_id'],
    eventTypePath: ['type'],
  },
  linq: {
    scheme: 'standard_webhooks',
    secretEnv: 'linqWebhookSecret',
    eventIdPath: ['id'],
    eventTypePath: ['type'],
  },
  terac: {
    scheme: 'terac',
    secretEnv: 'teracWebhookSecret',
    eventIdPath: ['event_id'],
    eventTypePath: ['event_type'],
  },
  lovable: {
    scheme: 'lovable',
    secretEnv: 'lovableWebhookSecret',
    eventIdPath: ['id'],
    eventTypePath: ['type'],
  },
  sandbox0: {
    scheme: 'sandbox0',
    secretEnv: 'sandbox0WebhookSecret',
    eventIdPath: ['event_id'],
    eventTypePath: ['type'],
  },
};

export async function registerWebhookRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Raw body is mandatory: every signature scheme in use signs the exact bytes,
  // and any re-serialisation breaks verification.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post<{ Params: { provider: string } }>(
    '/webhooks/:provider',
    {
      schema: {
        params: { type: 'object', properties: { provider: { type: 'string' } }, required: ['provider'] },
      },
    },
    async (request: FastifyRequest<{ Params: { provider: string } }>, reply) => {
      const log = getLogger();
      const provider = request.params.provider;
      const spec = PROVIDER_WEBHOOKS[provider];

      if (!spec) {
        metrics.webhooksReceived.inc({ provider, result: 'unknown_provider' });
        return reply.code(404).send({ error: `No webhook endpoint is configured for "${provider}"` });
      }

      const rawBody = request.body as Buffer;
      if (!Buffer.isBuffer(rawBody)) {
        return reply.code(400).send({ error: 'Expected a raw JSON body' });
      }

      /* ---------------------------------------------------------------- */
      /* 1. Verify                                                         */
      /* ---------------------------------------------------------------- */
      const secretSpec = SECRETS[spec.secretEnv];
      const secret = ctx.secrets.tryGet(secretSpec);
      if (!secret) {
        // Refuse rather than accept unverified money state. Returning 503
        // makes the provider retry, so nothing is lost once the secret lands.
        metrics.webhooksReceived.inc({ provider, result: 'no_secret' });
        log.error(
          { provider, env: secretSpec.env },
          'webhook received but the signing secret is not configured; refusing to process it unverified',
        );
        return reply.code(503).send({
          error: `Webhook signing secret ${secretSpec.env} is not configured. Refusing to process an unverified webhook.`,
        });
      }

      try {
        verifyWebhook(provider, spec.scheme, {
          rawBody,
          headers: request.headers as Record<string, string | string[] | undefined>,
          secret,
        });
      } catch (error) {
        metrics.webhooksReceived.inc({ provider, result: 'invalid_signature' });
        log.warn({ provider, err: describeError(error) }, 'webhook signature verification failed');
        // 400, not 401: the provider should not retry a body that will never
        // verify, and a retry storm on a bad secret helps nobody.
        return reply.code(400).send({ error: 'Signature verification failed' });
      }

      /* ---------------------------------------------------------------- */
      /* 2. Record (deduplicating)                                         */
      /* ---------------------------------------------------------------- */
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'Body is not valid JSON' });
      }

      const externalEventId = readPath(payload, spec.eventIdPath) ?? deriveFallbackId(request, rawBody);
      const eventType = readPath(payload, spec.eventTypePath) ?? 'unknown';

      const recorded = await ctx.repos.webhooks.recordIfNew({
        provider,
        externalEventId,
        eventType,
        signatureVerified: true,
        payload,
        headers: request.headers as Record<string, unknown>,
      });

      if (!recorded.isNew) {
        // A redelivery. Acknowledge without doing the work again.
        log.debug({ provider, externalEventId }, 'duplicate webhook acknowledged');
        return reply.code(200).send({ received: true, duplicate: true });
      }

      /* ---------------------------------------------------------------- */
      /* 3. Enqueue and return fast                                        */
      /* ---------------------------------------------------------------- */
      await ctx.queues.enqueue('commerce.webhook', {
        companyId: recorded.event.company_id ?? 'UNRESOLVED',
        traceId: recorded.event.id,
        originRunId: null,
        idempotencyKey: `${provider}:${externalEventId}`,
        webhookEventId: recorded.event.id,
        provider,
      });

      log.info({ provider, eventType, externalEventId }, 'webhook accepted');
      return reply.code(200).send({ received: true, duplicate: false });
    },
  );

  /**
   * Operational view of webhooks that failed repeatedly. A stuck webhook is
   * unreconciled money, so it is surfaced rather than buried in a log.
   */
  app.get('/webhooks/stuck', async () => {
    const stuck = await ctx.repos.webhooks.stuckEvents();
    return {
      count: stuck.length,
      events: stuck.map((e) => ({
        id: e.id,
        provider: e.provider,
        eventType: e.event_type,
        attempts: e.process_attempts,
        lastError: e.last_error,
        receivedAt: e.received_at,
      })),
    };
  });
}

function readPath(value: unknown, path: readonly string[]): string | null {
  let current: unknown = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' && current.length > 0 ? current : null;
}

/**
 * Some providers put the delivery id only in a header (Standard Webhooks uses
 * `webhook-id`). Falling back to it keeps deduplication working; a content hash
 * is the last resort so a body with no id at all still cannot be processed
 * twice.
 */
function deriveFallbackId(request: FastifyRequest, rawBody: Buffer): string {
  const headerId = request.headers['webhook-id'] ?? request.headers['x-event-id'];
  if (typeof headerId === 'string' && headerId.length > 0) return headerId;
  throw new ValidationError(
    'Webhook has no identifiable event id in body or headers; refusing to process it, because it cannot be deduplicated.',
  );
}
