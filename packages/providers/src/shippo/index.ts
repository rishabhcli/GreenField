/**
 * Shippo adapter — multi-carrier rate quotes, label purchase and tracking.
 * Structured like `../stripe/index.ts`: narrow zod schemas, one adapter
 * class, comments that explain *why*. Every method makes a real HTTP call;
 * with no `SHIPPO_API_TOKEN` configured, `requireSecret` raises a typed
 * `CredentialsMissingError`.
 *
 * Auth header confirmed 2026-08-15 (see `./constants.ts`): `Authorization:
 * ShippoToken <token>`, not `Bearer` — the generic `bearerAuth` helper in
 * `../http/client.ts` would send the wrong scheme, so this adapter builds its
 * own `AuthApplier`.
 */

import { type Secret, ValidationError } from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { type AuthApplier, type ProviderHttpClient } from '../http/client.js';
import { SECRETS, SHIPPO_MANIFEST } from '../manifests.js';
import { SHIPPO_AUTH_SCHEME } from './constants.js';
import {
  ShippoAddress,
  ShippoAddressInput,
  ShippoAddressList,
  ShippoParcel,
  ShippoRate,
  ShippoShipment,
  ShippoTracking,
  ShippoTransaction,
  ShippoTransactionList,
} from './schemas.js';

function shippoTokenAuth(token: Secret): AuthApplier {
  return (headers) => {
    headers['authorization'] = `${SHIPPO_AUTH_SCHEME} ${token.reveal()}`;
  };
}

export interface GetRatesInput {
  readonly addressFrom: ShippoAddressInput;
  readonly addressTo: ShippoAddressInput;
  readonly parcels: readonly ShippoParcel[];
}

export interface GetRatesResult {
  readonly rates: readonly ShippoRate[];
  /** Non-null exactly when `rates` is empty — a business condition, not an error. */
  readonly reason: string | null;
  readonly shipmentId: string;
}

export interface PurchaseLabelInput {
  readonly rateId: string;
  /** Our order id — stored in Shippo's `metadata` field and used to detect a duplicate purchase before spending money again. */
  readonly orderId: string;
  readonly labelFileType?: string;
}

export class ShippoAdapter extends ProviderAdapter {
  override readonly manifest = SHIPPO_MANIFEST;
  #client: ProviderHttpClient | undefined;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #httpClient(): ProviderHttpClient {
    if (!this.#client) {
      const token = this.requireSecret(SECRETS.shippoApiToken);
      this.#client = this.http(shippoTokenAuth(token));
    }
    return this.#client;
  }

  override async probe(): Promise<ProbeResult> {
    const res = await this.#httpClient().request(
      { method: 'GET', path: '/addresses', operation: 'addresses.list', query: { results: 1 } },
      ShippoAddressList,
    );
    return {
      succeeded: true,
      detail: `GET /addresses?results=1 returned ${res.body.results.length} of ${res.body.count ?? 'an unknown number of'} address(es)`,
      evidence: { endpoint: 'GET /addresses', authScheme: SHIPPO_AUTH_SCHEME, count: res.body.count ?? null },
    };
  }

  /**
   * `POST /shipments` (`async: false`) returns quoted rates inline. Zero
   * rates is reported as a business condition — no carrier serves this
   * lane/parcel combination, or every quote failed a carrier-side check —
   * never as a thrown error and never retried as if the request itself failed.
   */
  async getRates(input: GetRatesInput): Promise<GetRatesResult> {
    this.assertActivated();
    if (input.parcels.length === 0) throw new ValidationError('getRates requires at least one parcel');

    const res = await this.#httpClient().request(
      {
        method: 'POST',
        path: '/shipments',
        operation: 'shipments.create',
        body: { address_from: input.addressFrom, address_to: input.addressTo, parcels: input.parcels, async: false },
      },
      ShippoShipment,
    );

    if (res.body.rates.length === 0) {
      const reason =
        res.body.messages
          .map((m) => m.text)
          .filter((t): t is string => Boolean(t))
          .join('; ') || 'no carrier returned a rate for this shipment';
      return { rates: [], reason, shipmentId: res.body.object_id };
    }
    return { rates: res.body.rates, reason: null, shipmentId: res.body.object_id };
  }

  /**
   * Checks for an existing transaction carrying the same order id in
   * `metadata` before purchasing, because a duplicate label costs real money.
   * `POST /transactions` (`async: false`) then buys the label.
   */
  async purchaseLabel(input: PurchaseLabelInput): Promise<ShippoTransaction> {
    this.assertActivated();
    const existing = await this.#findExistingTransactionForOrder(input.orderId);
    if (existing) return existing;

    const res = await this.#httpClient().request(
      {
        method: 'POST',
        path: '/transactions',
        operation: 'transactions.create',
        body: { rate: input.rateId, label_file_type: input.labelFileType ?? 'PDF', async: false, metadata: input.orderId },
      },
      ShippoTransaction,
    );
    return res.body;
  }

  /**
   * Shippo has no server-side filter for "the transaction whose metadata
   * equals X" — this is a bounded scan of the most recent transactions
   * (newest first, capped at `maxPages * 25` records) rather than a
   * guaranteed lookup. It catches the common case (a retried job checking
   * right after its own prior attempt), but it is not a substitute for the
   * platform's own idempotency ledger, which should key every
   * `purchaseLabel` call on the order id as the authoritative guard.
   */
  async #findExistingTransactionForOrder(orderId: string, maxPages = 5): Promise<ShippoTransaction | undefined> {
    let next: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const res = await this.#httpClient().request(
        {
          method: 'GET',
          path: next ?? '/transactions',
          operation: 'transactions.list',
          ...(next ? {} : { query: { results: 25 } }),
        },
        ShippoTransactionList,
      );
      const match = res.body.results.find((t) => t.metadata === orderId);
      if (match) return match;
      if (!res.body.next) return undefined;
      next = res.body.next;
    }
    return undefined;
  }

  async getTracking(carrier: string, trackingNumber: string): Promise<ShippoTracking> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'GET', path: `/tracks/${encodeURIComponent(carrier)}/${encodeURIComponent(trackingNumber)}`, operation: 'tracks.get' },
      ShippoTracking,
    );
    return res.body;
  }

  async validateAddress(address: ShippoAddressInput): Promise<ShippoAddress> {
    this.assertActivated();
    const res = await this.#httpClient().request(
      { method: 'POST', path: '/addresses', operation: 'addresses.create', body: { ...address, validate: true } },
      ShippoAddress,
    );
    return res.body;
  }
}

export * from './constants.js';
export * from './schemas.js';
