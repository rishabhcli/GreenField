/**
 * Cloudflare adapter — domain/registrar visibility and DNS management for
 * launched storefronts. Structured like `../stripe/index.ts`: narrow zod
 * schemas, one adapter class, comments that explain *why*. Every method
 * makes a real HTTP call; with no `CLOUDFLARE_API_TOKEN` configured,
 * `requireSecret` raises a typed `CredentialsMissingError`.
 *
 * The one thing every method here has to get right: **Cloudflare returns
 * HTTP 200 with `success: false`** for a great many failures. The shared
 * `ProviderHttpClient` only classifies non-2xx responses as errors, so a
 * `success:false` body sails through as a normal 200 unless each call site
 * checks the envelope explicitly — `unwrap()` below is that check, applied
 * everywhere a result is read.
 */

import { FoundryError, ProviderContractError, ValidationError } from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { bearerAuth, type ProviderHttpClient } from '../http/client.js';
import { SECRETS, CLOUDFLARE_MANIFEST } from '../manifests.js';
import {
  CloudflareApiErrorDetail,
  CloudflareDeleteResultEnvelope,
  CloudflareDnsRecord,
  CloudflareDnsRecordEnvelope,
  CloudflareDnsRecordListEnvelope,
  CloudflareRegistrarDomain,
  CloudflareRegistrarDomainEnvelope,
  CloudflareRegistrarDomainListEnvelope,
  CloudflareTokenVerifyEnvelope,
  CloudflareZone,
  CloudflareZoneListEnvelope,
} from './schemas.js';

/** `success:false` with HTTP 200 — the failure mode this whole adapter is written to never miss. */
export class CloudflareApiError extends FoundryError {
  constructor(operation: string, errors: readonly CloudflareApiErrorDetail[], context?: Record<string, unknown>) {
    super({
      category: 'validation',
      code: 'cloudflare.request_failed',
      message: `Cloudflare rejected "${operation}" (HTTP 200, success:false): ${
        errors.length > 0 ? errors.map((e) => `[${e.code}] ${e.message}`).join('; ') : 'no error detail returned'
      }`,
      context: { operation, errors, ...context },
    });
  }
}

function unwrap<T>(
  operation: string,
  envelope: { readonly success: boolean; readonly errors: readonly CloudflareApiErrorDetail[]; readonly result: T | null },
): T {
  if (!envelope.success) throw new CloudflareApiError(operation, envelope.errors);
  if (envelope.result === null) {
    throw new ProviderContractError('cloudflare_dns', `${operation} reported success but returned a null result`, { operation });
  }
  return envelope.result;
}

export interface DnsRecordInput {
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly ttl?: number;
  readonly proxied?: boolean;
}

export class CloudflareAdapter extends ProviderAdapter {
  override readonly manifest = CLOUDFLARE_MANIFEST;
  #client: ProviderHttpClient | undefined;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #httpClient(): ProviderHttpClient {
    if (!this.#client) {
      const token = this.requireSecret(SECRETS.cloudflareApiToken);
      this.#client = this.http(bearerAuth(token));
    }
    return this.#client;
  }

  #accountId(): string {
    return this.requireSecret(SECRETS.cloudflareAccountId).reveal();
  }

  override async probe(): Promise<ProbeResult> {
    const res = await this.#httpClient().request(
      { method: 'GET', path: '/user/tokens/verify', operation: 'tokens.verify' },
      CloudflareTokenVerifyEnvelope,
    );
    const result = unwrap('tokens.verify', res.body);
    return {
      succeeded: true,
      detail: `GET /user/tokens/verify: token status "${result.status}"`,
      evidence: { endpoint: 'GET /user/tokens/verify', tokenId: result.id, status: result.status },
    };
  }

  /**
   * Cloudflare Registrar is transfer-only: it manages domains already
   * registered elsewhere once transferred in, and publishes no endpoint for
   * registering a brand-new domain nobody has ever registered. "Availability"
   * here can therefore only mean *"is this domain present in our registrar
   * account,"* never *"is this fresh domain available to anyone."*
   * Conflating the two would be exactly the fabricated-availability failure
   * this system is built to avoid — a caller that needs true new-domain
   * availability needs a different, registrar-proper provider, and the
   * capability registry should report that gap honestly rather than this
   * method inventing a yes/no it cannot actually know.
   */
  async checkDomainAvailability(
    domain: string,
  ): Promise<{ readonly domain: string; readonly inRegistrarAccount: boolean; readonly detail: CloudflareRegistrarDomain | null }> {
    this.assertActivated();
    try {
      const res = await this.#httpClient().request(
        {
          method: 'GET',
          path: `/accounts/${this.#accountId()}/registrar/domains/${encodeURIComponent(domain)}`,
          operation: 'registrar.domains.get',
        },
        CloudflareRegistrarDomainEnvelope,
      );
      if (!res.body.success) return { domain, inRegistrarAccount: false, detail: null };
      return { domain, inRegistrarAccount: true, detail: res.body.result };
    } catch (error) {
      if (error instanceof FoundryError && (error.category === 'not_found' || error.context['status'] === 404)) {
        return { domain, inRegistrarAccount: false, detail: null };
      }
      throw error;
    }
  }

  async listRegistrarDomains(): Promise<readonly CloudflareRegistrarDomain[]> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'GET', path: `/accounts/${this.#accountId()}/registrar/domains`, operation: 'registrar.domains.list' },
      CloudflareRegistrarDomainListEnvelope,
    );
    return unwrap('registrar.domains.list', res.body);
  }

  async listZones(): Promise<readonly CloudflareZone[]> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'GET', path: '/zones', operation: 'zones.list', query: { 'account.id': this.#accountId() } },
      CloudflareZoneListEnvelope,
    );
    return unwrap('zones.list', res.body);
  }

  async listDnsRecords(zoneId: string, filter: { readonly type?: string; readonly name?: string } = {}): Promise<readonly CloudflareDnsRecord[]> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      {
        method: 'GET',
        path: `/zones/${encodeURIComponent(zoneId)}/dns_records`,
        operation: 'dnsRecords.list',
        query: { type: filter.type, name: filter.name },
      },
      CloudflareDnsRecordListEnvelope,
    );
    return unwrap('dnsRecords.list', res.body);
  }

  /**
   * Reads existing records for the same `type` + `name` first and patches the
   * match instead of creating a duplicate — DNS has no natural idempotency
   * key, so this read-then-write is the guard against a retried deploy step
   * littering a zone with duplicate A/CNAME records.
   */
  async createDnsRecord(zoneId: string, input: DnsRecordInput): Promise<CloudflareDnsRecord> {
    this.assertActivated();
    const existing = await this.listDnsRecords(zoneId, { type: input.type, name: input.name });
    const match = existing[0];
    if (match) return this.updateDnsRecord(zoneId, match.id, input);

    const res = await this.#httpClient().request(
      {
        method: 'POST',
        path: `/zones/${encodeURIComponent(zoneId)}/dns_records`,
        operation: 'dnsRecords.create',
        body: {
          type: input.type,
          name: input.name,
          content: input.content,
          ...(input.ttl !== undefined ? { ttl: input.ttl } : {}),
          ...(input.proxied !== undefined ? { proxied: input.proxied } : {}),
        },
      },
      CloudflareDnsRecordEnvelope,
    );
    return unwrap('dnsRecords.create', res.body);
  }

  async updateDnsRecord(zoneId: string, recordId: string, input: Partial<DnsRecordInput>): Promise<CloudflareDnsRecord> {
    this.assertActivated();
    if (!input.type && !input.name && !input.content && input.ttl === undefined && input.proxied === undefined) {
      throw new ValidationError('updateDnsRecord requires at least one field to change', { zoneId, recordId });
    }
    const res = await this.#httpClient().request(
      {
        method: 'PATCH',
        path: `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
        operation: 'dnsRecords.update',
        body: {
          ...(input.type ? { type: input.type } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.content ? { content: input.content } : {}),
          ...(input.ttl !== undefined ? { ttl: input.ttl } : {}),
          ...(input.proxied !== undefined ? { proxied: input.proxied } : {}),
        },
      },
      CloudflareDnsRecordEnvelope,
    );
    return unwrap('dnsRecords.update', res.body);
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      {
        method: 'DELETE',
        path: `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
        operation: 'dnsRecords.delete',
      },
      CloudflareDeleteResultEnvelope,
    );
    unwrap('dnsRecords.delete', res.body);
  }
}

export * from './schemas.js';
