/**
 * Sourcing persistence: suppliers, RFQs, quotes, landed-cost models, samples.
 *
 * `markSent` is deliberately narrow: an RFQ can only be recorded as sent when
 * an approval id and a provider message id both exist. That is the difference
 * between "we contacted a real supplier" and "an agent generated some text".
 */

import { z } from 'zod';
import {
  computeLandedCost,
  newId,
  type CostComponent,
  type Incoterm,
  type LandedCostModel,
  type RfqSpecification,
  type SupplierKind,
} from '@foundry/core';
import { exec, q, qMaybe, qOne, type DbPool, type Queryable } from '../pool.js';

const SupplierRow = z.object({
  id: z.string(),
  company_id: z.string(),
  source_provider: z.string(),
  external_id: z.string(),
  profile_url: z.string().nullable(),
  legal_name: z.string(),
  display_name: z.string(),
  kind: z.string(),
  country_code: z.string(),
  region: z.string().nullable(),
  years_active: z.number().nullable(),
  claimed_certifications: z.array(z.string()),
  verified_certifications: z.array(z.string()),
  platform_signals: z.record(z.string(), z.unknown()),
  supports_private_label: z.boolean().nullable(),
  supports_custom_packaging: z.boolean().nullable(),
  contact_channels: z.array(z.string()),
  contact_handle: z.string().nullable(),
  risk_flags: z.array(z.string()),
  discovered_via: z.string(),
  discovered_at: z.date(),
  last_refreshed_at: z.date(),
});

const RfqRow = z.object({
  id: z.string(),
  company_id: z.string(),
  opportunity_id: z.string(),
  supplier_id: z.string(),
  specification: z.record(z.string(), z.unknown()),
  message_body: z.string(),
  channel: z.string(),
  status: z.string(),
  approval_id: z.string().nullable(),
  sent_at: z.date().nullable(),
  external_message_id: z.string().nullable(),
  delivery_error: z.string().nullable(),
  responded_at: z.date().nullable(),
  expires_at: z.date().nullable(),
  created_at: z.date(),
});

const QuoteRow = z.object({
  id: z.string(),
  company_id: z.string(),
  rfq_id: z.string(),
  supplier_id: z.string(),
  received_via: z.string(),
  raw_response_ref: z.string().nullable(),
  received_at: z.date(),
  currency: z.string(),
  price_tiers: z.array(z.record(z.string(), z.unknown())),
  moq: z.number(),
  sample_cost_minor: z.number().nullable(),
  sample_lead_time_days: z.number().nullable(),
  tooling_setup_cost_minor: z.number(),
  customisation_cost_per_unit_minor: z.number(),
  packaging_cost_per_unit_minor: z.number(),
  production_lead_time_days: z.number(),
  incoterm: z.string(),
  origin_port: z.string().nullable(),
  payment_terms: z.string().nullable(),
  valid_until: z.date().nullable(),
  notes: z.string().nullable(),
  verified_by_engagement_id: z.string().nullable(),
});

const CostRow = z.object({
  id: z.string(),
  company_id: z.string(),
  opportunity_id: z.string(),
  quote_id: z.string().nullable(),
  order_quantity: z.number(),
  currency: z.string(),
  components: z.array(z.record(z.string(), z.unknown())),
  destination_country: z.string(),
  incoterm: z.string(),
  hs_code: z.string().nullable(),
  landed_unit_cost: z.string(),
  grounded_ratio: z.number(),
  assumed_components: z.array(z.string()),
  computed_at: z.date(),
});

export type SupplierRow = z.infer<typeof SupplierRow>;
export type RfqRow = z.infer<typeof RfqRow>;
export type QuoteRow = z.infer<typeof QuoteRow>;
export type LandedCostRow = z.infer<typeof CostRow>;

const SUPPLIER_COLUMNS = `id, company_id, source_provider, external_id, profile_url, legal_name, display_name,
  kind, country_code, region, years_active, claimed_certifications, verified_certifications,
  platform_signals, supports_private_label, supports_custom_packaging, contact_channels, contact_handle,
  risk_flags, discovered_via, discovered_at, last_refreshed_at`;
const RFQ_COLUMNS = `id, company_id, opportunity_id, supplier_id, specification, message_body, channel,
  status, approval_id, sent_at, external_message_id, delivery_error, responded_at, expires_at, created_at`;
const QUOTE_COLUMNS = `id, company_id, rfq_id, supplier_id, received_via, raw_response_ref, received_at,
  currency, price_tiers, moq, sample_cost_minor, sample_lead_time_days, tooling_setup_cost_minor,
  customisation_cost_per_unit_minor, packaging_cost_per_unit_minor, production_lead_time_days, incoterm,
  origin_port, payment_terms, valid_until, notes, verified_by_engagement_id`;
const COST_COLUMNS = `id, company_id, opportunity_id, quote_id, order_quantity, currency, components,
  destination_country, incoterm, hs_code, landed_unit_cost, grounded_ratio, assumed_components, computed_at`;

export class SupplierRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(input: {
    companyId: string;
    sourceProvider: string;
    externalId: string;
    legalName: string;
    displayName: string;
    kind: SupplierKind;
    countryCode: string;
    discoveredVia: 'provider_api' | 'browser_session' | 'human_expert' | 'manual_entry';
    profileUrl?: string | null;
    region?: string | null;
    yearsActive?: number | null;
    claimedCertifications?: readonly string[];
    platformSignals?: Record<string, unknown>;
    supportsPrivateLabel?: boolean | null;
    supportsCustomPackaging?: boolean | null;
    contactChannels?: readonly string[];
    contactHandle?: string | null;
    riskFlags?: readonly string[];
  }): Promise<SupplierRow> {
    return qOne(
      this.db,
      `INSERT INTO suppliers (id, company_id, source_provider, external_id, profile_url, legal_name,
                              display_name, kind, country_code, region, years_active, claimed_certifications,
                              platform_signals, supports_private_label, supports_custom_packaging,
                              contact_channels, contact_handle, risk_flags, discovered_via,
                              discovered_at, last_refreshed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19, now(), now())
       ON CONFLICT (company_id, source_provider, external_id) DO UPDATE
         SET legal_name = EXCLUDED.legal_name,
             display_name = EXCLUDED.display_name,
             profile_url = COALESCE(EXCLUDED.profile_url, suppliers.profile_url),
             platform_signals = suppliers.platform_signals || EXCLUDED.platform_signals,
             supports_private_label = COALESCE(EXCLUDED.supports_private_label, suppliers.supports_private_label),
             supports_custom_packaging = COALESCE(EXCLUDED.supports_custom_packaging, suppliers.supports_custom_packaging),
             contact_handle = COALESCE(EXCLUDED.contact_handle, suppliers.contact_handle),
             risk_flags = EXCLUDED.risk_flags,
             last_refreshed_at = now()
       RETURNING ${SUPPLIER_COLUMNS}`,
      [
        newId('supplier'), input.companyId, input.sourceProvider, input.externalId, input.profileUrl ?? null,
        input.legalName, input.displayName, input.kind, input.countryCode, input.region ?? null,
        input.yearsActive ?? null, input.claimedCertifications ?? [], JSON.stringify(input.platformSignals ?? {}),
        input.supportsPrivateLabel ?? null, input.supportsCustomPackaging ?? null,
        input.contactChannels ?? [], input.contactHandle ?? null, input.riskFlags ?? [], input.discoveredVia,
      ],
      SupplierRow,
      'supplier',
      input.externalId,
    );
  }

  async byId(id: string): Promise<SupplierRow> {
    return qOne(this.db, `SELECT ${SUPPLIER_COLUMNS} FROM suppliers WHERE id=$1`, [id], SupplierRow, 'supplier', id);
  }

  async list(companyId: string, options: { privateLabelOnly?: boolean; limit?: number } = {}): Promise<readonly SupplierRow[]> {
    return q(
      this.db,
      `SELECT ${SUPPLIER_COLUMNS} FROM suppliers
        WHERE company_id=$1 AND ($2::boolean IS NOT TRUE OR supports_private_label IS TRUE)
        ORDER BY last_refreshed_at DESC LIMIT $3`,
      [companyId, options.privateLabelOnly ?? false, options.limit ?? 100],
      SupplierRow,
    );
  }

  /** Records a certification we independently confirmed, separate from claims. */
  async addVerifiedCertification(id: string, certification: string): Promise<void> {
    await exec(
      this.db,
      `UPDATE suppliers
          SET verified_certifications = ARRAY(SELECT DISTINCT unnest(verified_certifications || ARRAY[$2::text]))
        WHERE id=$1`,
      [id, certification],
    );
  }
}

export class RfqRepository {
  constructor(private readonly db: Queryable) {}

  async draft(input: {
    companyId: string;
    opportunityId: string;
    supplierId: string;
    specification: RfqSpecification;
    messageBody: string;
    channel: string;
  }): Promise<RfqRow> {
    return qOne(
      this.db,
      `INSERT INTO rfqs (id, company_id, opportunity_id, supplier_id, specification, message_body, channel, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,'draft')
       RETURNING ${RFQ_COLUMNS}`,
      [
        newId('rfq'), input.companyId, input.opportunityId, input.supplierId,
        JSON.stringify(input.specification), input.messageBody, input.channel,
      ],
      RfqRow,
      'rfq',
      input.supplierId,
    );
  }

  async markPending(id: string): Promise<void> {
    await exec(
      this.db,
      `UPDATE rfqs SET status='pending_approval' WHERE id=$1 AND status IN ('draft','pending_approval')`,
      [id],
    );
  }

  async attachApproval(id: string, approvalId: string): Promise<void> {
    await exec(this.db, `UPDATE rfqs SET approval_id=$2, status='approved' WHERE id=$1 AND status IN ('draft','pending_approval')`, [id, approvalId]);
  }

  /**
   * Records that the RFQ actually reached the supplier.
   *
   * Requires a provider message id, and the database CHECK enforces the same
   * thing. A "sent" RFQ with no delivery evidence would be a fabricated
   * supplier contact.
   */
  async markSent(id: string, externalMessageId: string, sentAt = new Date()): Promise<RfqRow> {
    return qOne(
      this.db,
      `UPDATE rfqs SET status='sent', sent_at=$2, external_message_id=$3, delivery_error=NULL
        WHERE id=$1 AND approval_id IS NOT NULL
        RETURNING ${RFQ_COLUMNS}`,
      [id, sentAt, externalMessageId],
      RfqRow,
      'rfq',
      id,
    );
  }

  async markDeliveryFailed(id: string, error: string): Promise<void> {
    await exec(this.db, `UPDATE rfqs SET status='delivery_failed', delivery_error=$2 WHERE id=$1`, [id, error.slice(0, 2000)]);
  }

  async markResponded(id: string, status: 'quoted' | 'declined' | 'acknowledged'): Promise<void> {
    await exec(this.db, `UPDATE rfqs SET status=$2, responded_at=now() WHERE id=$1`, [id, status]);
  }

  async byId(id: string): Promise<RfqRow> {
    return qOne(this.db, `SELECT ${RFQ_COLUMNS} FROM rfqs WHERE id=$1`, [id], RfqRow, 'rfq', id);
  }

  async awaitingReply(companyId: string, olderThanHours = 0): Promise<readonly RfqRow[]> {
    return q(
      this.db,
      `SELECT ${RFQ_COLUMNS} FROM rfqs
        WHERE company_id=$1 AND status IN ('sent','acknowledged')
          AND sent_at < now() - ($2 || ' hours')::interval
        ORDER BY sent_at`,
      [companyId, String(olderThanHours)],
      RfqRow,
    );
  }

  async forOpportunity(opportunityId: string): Promise<readonly RfqRow[]> {
    return q(this.db, `SELECT ${RFQ_COLUMNS} FROM rfqs WHERE opportunity_id=$1 ORDER BY created_at`, [opportunityId], RfqRow);
  }
}

export class QuoteRepository {
  constructor(private readonly db: Queryable) {}

  /** Persists a supplier-stated quote. Alias of `record`. */
  async create(input: Parameters<QuoteRepository['record']>[0]): Promise<QuoteRow> {
    return this.record(input);
  }

  async record(input: {
    companyId: string;
    rfqId: string;
    supplierId: string;
    receivedVia: 'provider_api' | 'email_inbound' | 'browser_session' | 'human_expert_relay' | 'manual_entry';
    rawResponseRef?: string | null;
    receivedAt?: Date;
    currency: string;
    priceTiers: readonly Record<string, unknown>[];
    moq: number;
    productionLeadTimeDays: number;
    incoterm: Incoterm;
    sampleCostMinor?: number | null;
    sampleLeadTimeDays?: number | null;
    toolingSetupCostMinor?: number;
    customisationCostPerUnitMinor?: number;
    packagingCostPerUnitMinor?: number;
    originPort?: string | null;
    paymentTerms?: string | null;
    validUntil?: Date | null;
    notes?: string | null;
  }): Promise<QuoteRow> {
    return qOne(
      this.db,
      `INSERT INTO supplier_quotes (id, company_id, rfq_id, supplier_id, received_via, raw_response_ref,
                                    received_at, currency, price_tiers, moq, sample_cost_minor,
                                    sample_lead_time_days, tooling_setup_cost_minor,
                                    customisation_cost_per_unit_minor, packaging_cost_per_unit_minor,
                                    production_lead_time_days, incoterm, origin_port, payment_terms,
                                    valid_until, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING ${QUOTE_COLUMNS}`,
      [
        newId('quote'), input.companyId, input.rfqId, input.supplierId, input.receivedVia,
        input.rawResponseRef ?? null, input.receivedAt ?? new Date(), input.currency,
        JSON.stringify(input.priceTiers), input.moq, input.sampleCostMinor ?? null,
        input.sampleLeadTimeDays ?? null, input.toolingSetupCostMinor ?? 0,
        input.customisationCostPerUnitMinor ?? 0, input.packagingCostPerUnitMinor ?? 0,
        input.productionLeadTimeDays, input.incoterm, input.originPort ?? null,
        input.paymentTerms ?? null, input.validUntil ?? null, input.notes ?? null,
      ],
      QuoteRow,
      'quote',
      input.rfqId,
    );
  }

  async byId(id: string): Promise<QuoteRow> {
    return qOne(this.db, `SELECT ${QUOTE_COLUMNS} FROM supplier_quotes WHERE id=$1`, [id], QuoteRow, 'quote', id);
  }

  async forOpportunity(opportunityId: string): Promise<readonly QuoteRow[]> {
    return q(
      this.db,
      `SELECT ${QUOTE_COLUMNS.split(', ').map((c) => `sq.${c.trim()}`).join(', ')}
         FROM supplier_quotes sq
         JOIN rfqs r ON r.id = sq.rfq_id
        WHERE r.opportunity_id = $1
        ORDER BY sq.received_at DESC`,
      [opportunityId],
      QuoteRow,
    );
  }

  /**
   * Quotes that are grounded and still valid.
   *
   * Every row in this table is grounded by construction — `received_via` only
   * admits channels that leave a trace, and the schema refuses a quote with no
   * price tiers. What this adds is the expiry check: a quote past
   * `valid_until` is a historical fact, not a price the company can build a
   * margin model on, so it does not count toward "sourcing produced something
   * usable".
   */
  async countGrounded(companyId: string): Promise<number> {
    const row = await qOne(
      this.db,
      `SELECT COUNT(*)::int AS n
         FROM supplier_quotes
        WHERE company_id = $1
          AND (valid_until IS NULL OR valid_until > now())`,
      [companyId],
      z.object({ n: z.number() }),
      'supplier_quotes',
      companyId,
    );
    return row.n;
  }

  async markVerified(id: string, engagementId: string): Promise<void> {
    await exec(this.db, `UPDATE supplier_quotes SET verified_by_engagement_id=$2 WHERE id=$1`, [id, engagementId]);
  }
}

export class LandedCostRepository {
  constructor(private readonly db: Queryable) {}

  /** Computes and stores the model; the derived fields are never caller-supplied. */
  async write(input: {
    companyId: string;
    opportunityId: string;
    quoteId?: string | null;
    orderQuantity: number;
    currency: string;
    components: readonly CostComponent[];
    destinationCountry: string;
    incoterm: Incoterm;
    hsCode?: string | null;
  }): Promise<LandedCostRow> {
    const model: LandedCostModel = {
      id: newId('costModel'),
      companyId: input.companyId,
      opportunityId: input.opportunityId,
      quoteId: input.quoteId ?? null,
      orderQuantity: input.orderQuantity,
      currency: input.currency,
      components: [...input.components],
      destinationCountry: input.destinationCountry,
      incoterm: input.incoterm,
      hsCode: input.hsCode ?? null,
      computedAt: new Date().toISOString(),
    };
    const result = computeLandedCost(model);

    return qOne(
      this.db,
      `INSERT INTO landed_cost_models (id, company_id, opportunity_id, quote_id, order_quantity, currency,
                                       components, destination_country, incoterm, hs_code,
                                       landed_unit_cost, grounded_ratio, assumed_components)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
       RETURNING ${COST_COLUMNS}`,
      [
        model.id, input.companyId, input.opportunityId, input.quoteId ?? null, input.orderQuantity,
        input.currency, JSON.stringify(input.components), input.destinationCountry, input.incoterm,
        input.hsCode ?? null, result.landedUnitCost.toString(), result.groundedRatio,
        result.assumedComponents,
      ],
      CostRow,
      'landed_cost_model',
      input.opportunityId,
    );
  }

  async latestForOpportunity(opportunityId: string): Promise<LandedCostRow | undefined> {
    return qMaybe(
      this.db,
      `SELECT ${COST_COLUMNS} FROM landed_cost_models WHERE opportunity_id=$1 ORDER BY computed_at DESC LIMIT 1`,
      [opportunityId],
      CostRow,
    );
  }

  /** Every landed-cost model for the company, newest first. */
  async listForCompany(companyId: string, limit = 50): Promise<readonly LandedCostRow[]> {
    return q(
      this.db,
      `SELECT ${COST_COLUMNS} FROM landed_cost_models
        WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [companyId, limit],
      CostRow,
    );
  }

  async byId(id: string): Promise<LandedCostRow> {
    return qOne(this.db, `SELECT ${COST_COLUMNS} FROM landed_cost_models WHERE id=$1`, [id], CostRow, 'landed_cost_model', id);
  }
}

export class SourcingRepositories {
  readonly suppliers: SupplierRepository;
  readonly rfqs: RfqRepository;
  readonly quotes: QuoteRepository;
  readonly landedCosts: LandedCostRepository;

  constructor(pool: DbPool) {
    this.suppliers = new SupplierRepository(pool);
    this.rfqs = new RfqRepository(pool);
    this.quotes = new QuoteRepository(pool);
    this.landedCosts = new LandedCostRepository(pool);
  }
}
