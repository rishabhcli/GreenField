/**
 * Resend adapter — transactional email for order confirmations, shipping
 * notifications, support replies and RFQ delivery. Structured like
 * `../stripe/index.ts`: narrow zod schemas, one adapter class, comments that
 * explain *why*. Every method makes a real HTTP call; with no
 * `RESEND_API_KEY` configured, `requireSecret` raises a typed
 * `CredentialsMissingError`.
 */

import { FoundryError, ValidationError } from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { bearerAuth, type ProviderHttpClient } from '../http/client.js';
import { SECRETS, RESEND_MANIFEST } from '../manifests.js';
import { ResendDomainListResponse, ResendEmail, ResendSendEmailResponse, extractResendError } from './schemas.js';

/**
 * Thrown instead of a bare `ProviderAuthError` when a 403 is specifically a
 * domain-verification problem, so the failure names the exact domain rather
 * than making the caller parse Resend's free-text message. Category
 * `validation` because the fix is on our side (verify the domain or send from
 * a verified one) — retrying the identical request can never succeed.
 */
export class ResendDomainNotVerifiedError extends FoundryError {
  constructor(domain: string, cause?: unknown) {
    super({
      category: 'validation',
      code: 'resend.domain_not_verified',
      message:
        `Resend rejected the send because the sending domain "${domain}" is not verified. ` +
        `Verify it at https://resend.com/domains, or send from an already-verified domain.`,
      context: { domain },
      cause,
    });
  }
}

export interface SendEmailInput {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly html?: string;
  readonly text?: string;
  readonly replyTo?: string;
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly tags?: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
}

export class ResendAdapter extends ProviderAdapter {
  override readonly manifest = RESEND_MANIFEST;
  #client: ProviderHttpClient | undefined;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #httpClient(): ProviderHttpClient {
    if (!this.#client) {
      const secret = this.requireSecret(SECRETS.resendApiKey);
      this.#client = this.http(bearerAuth(secret), { idempotencyHeader: 'Idempotency-Key' });
    }
    return this.#client;
  }

  override async probe(): Promise<ProbeResult> {
    const res = await this.#httpClient().request(
      { method: 'GET', path: '/domains', operation: 'domains.list' },
      ResendDomainListResponse,
    );
    return {
      succeeded: true,
      detail: `GET /domains returned ${res.body.data.length} domain(s)`,
      evidence: { endpoint: 'GET /domains', domainCount: res.body.data.length, verified: res.body.data.map((d) => d.status) },
    };
  }

  /**
   * `POST /emails` with an `Idempotency-Key`, so a retried send cannot double
   * deliver. A 403 caused by an unverified sending domain is re-thrown as
   * `ResendDomainNotVerifiedError` naming `input.from`'s domain directly —
   * built from the request we made, not parsed out of Resend's free-text
   * error message, so it is correct regardless of exact wording.
   */
  async sendEmail(input: SendEmailInput): Promise<{ id: string }> {
    this.assertActivated();
    if (input.to.length === 0) throw new ValidationError('sendEmail requires at least one recipient');
    if (!input.html && !input.text) throw new ValidationError('sendEmail requires either html or text content');

    try {
      const res = await this.#httpClient().request(
        {
          method: 'POST',
          path: '/emails',
          operation: 'emails.send',
          idempotencyKey: input.idempotencyKey,
          body: {
            from: input.from,
            to: input.to,
            subject: input.subject,
            ...(input.html ? { html: input.html } : {}),
            ...(input.text ? { text: input.text } : {}),
            ...(input.replyTo ? { reply_to: input.replyTo } : {}),
            ...(input.cc ? { cc: input.cc } : {}),
            ...(input.bcc ? { bcc: input.bcc } : {}),
            ...(input.tags ? { tags: Object.entries(input.tags).map(([name, value]) => ({ name, value })) } : {}),
          },
        },
        ResendSendEmailResponse,
      );
      return res.body;
    } catch (error) {
      // The shared client's default classification turns both 401 and 403
      // into a `ProviderAuthError`; only 403 is (per Resend's docs) the
      // unverified-domain case; a 401 is a genuine bad-key problem and is
      // left as-is. The domain is re-derived from what we sent, not parsed
      // out of Resend's free-text message, so it is correct regardless of
      // exact wording.
      if (error instanceof FoundryError && error.category === 'auth' && error.context['status'] === 403) {
        throw new ResendDomainNotVerifiedError(domainOf(input.from), error);
      }
      throw error;
    }
  }

  async getEmail(id: string): Promise<ResendEmail> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'GET', path: `/emails/${encodeURIComponent(id)}`, operation: 'emails.get' },
      ResendEmail,
    );
    return res.body;
  }
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? address : address.slice(at + 1).replace(/>$/, '');
}

export { extractResendError };
export * from './schemas.js';
