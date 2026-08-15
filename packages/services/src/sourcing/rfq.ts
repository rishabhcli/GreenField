/**
 * RFQ drafting and delivery.
 *
 * Drafting stores the exact outbound text. Sending is a different fact: an RFQ
 * is `sent` only when a human approval id exists *and* a provider returns an
 * external message id. Anything short of that — missing approval, missing
 * capability, a throw from the adapter — is not a supplier contact.
 */

import {
  CapabilityUnsupportedError,
  CredentialsMissingError,
  RfqSpecification,
  ValidationError,
  VendorApprovalRequiredError,
  type Capability,
  type RfqSpecification as RfqSpecificationType,
  type SupplierContactChannel,
} from '@foundry/core';
import type { QuoteRow, RfqRow } from '@foundry/db';
import { getLogger } from '@foundry/obs';
import { requireCapability, type ServiceDeps } from '../deps.js';
import { SourcingQuoteService } from './quotes.js';

export interface DraftRfqInput {
  readonly companyId: string;
  readonly opportunityId: string;
  readonly supplierId: string;
  readonly specification: RfqSpecificationType;
  readonly messageBody: string;
  readonly channel: SupplierContactChannel;
}

export interface SendRfqInput {
  readonly rfqId: string;
  readonly approvalId: string;
}

export type SendRfqResult =
  | { readonly outcome: 'sent'; readonly rfq: RfqRow; readonly externalMessageId: string }
  | {
      readonly outcome: 'blocked';
      readonly reason: string;
      readonly blockedOn: { capability: Capability; reason: string };
    }
  | { readonly outcome: 'delivery_failed'; readonly reason: string };

export interface PollQuotesResult {
  readonly quotes: readonly QuoteRow[];
  readonly blockedOn?: { capability: Capability; reason: string };
}

interface RfqSubmitAdapter {
  readonly providerId?: string;
  supports?(method: string): boolean;
  submitRfq?(input: {
    readonly supplierExternalId: string;
    readonly productExternalId: string | null;
    readonly messageBody: string;
    readonly targetQuantities: readonly number[];
  }): Promise<unknown>;
  getQuote?(input: { readonly rfqExternalRef: string }): Promise<unknown>;
  retrieveQuotes?(query: { readonly rfqExternalRef?: string; readonly rfqId?: string }): Promise<unknown>;
}

export class RfqService {
  constructor(private readonly deps: ServiceDeps) {}

  async draft(input: DraftRfqInput): Promise<RfqRow> {
    const specification = RfqSpecification.parse(input.specification);
    return this.deps.repos.sourcing.rfqs.draft({
      companyId: input.companyId,
      opportunityId: input.opportunityId,
      supplierId: input.supplierId,
      specification,
      messageBody: input.messageBody,
      channel: input.channel,
    });
  }

  /**
   * Marks an RFQ sent only after approval and a provider message id both exist.
   * Vendor-approval failures leave the RFQ unsent and return blockedOn.
   */
  async send(input: SendRfqInput): Promise<SendRfqResult> {
    const log = getLogger();
    const approvalId = input.approvalId?.trim() ?? '';
    if (approvalId.length === 0) {
      throw new ValidationError(
        'Cannot send an RFQ without a recorded approval id. Outbound supplier contact is gated; the message stays a draft.',
        { rfqId: input.rfqId },
      );
    }

    const rfq = await this.deps.repos.sourcing.rfqs.byId(input.rfqId);
    await this.deps.repos.sourcing.rfqs.markPending(rfq.id);
    await this.deps.repos.sourcing.rfqs.attachApproval(rfq.id, approvalId);

    let adapter: RfqSubmitAdapter;
    let statusProvider: string;
    try {
      const resolved = requireCapability<RfqSubmitAdapter>(this.deps, 'sourcing.rfq_submit');
      adapter = resolved.adapter;
      statusProvider = resolved.status.provider ?? adapter.providerId ?? 'unknown';
    } catch (error) {
      if (error instanceof CredentialsMissingError || error instanceof CapabilityUnsupportedError) {
        const reason =
          error.message +
          ' Remediation: send the stored messageBody via email, a ToS-permitted recorded browser session, or a human expert relay — then record the resulting message id.';
        log.warn({ rfqId: rfq.id, reason }, 'RFQ submit capability unavailable');
        return {
          outcome: 'blocked',
          reason,
          blockedOn: { capability: 'sourcing.rfq_submit', reason },
        };
      }
      throw error;
    }

    if (typeof adapter.submitRfq !== 'function' || (typeof adapter.supports === 'function' && !adapter.supports('submitRfq'))) {
      const reason =
        `Provider "${statusProvider}" does not implement submitRfq. ` +
        `Remediation: email, a ToS-permitted browser session, or human expert relay.`;
      return {
        outcome: 'blocked',
        reason,
        blockedOn: { capability: 'sourcing.rfq_submit', reason },
      };
    }

    const supplier = await this.deps.repos.sourcing.suppliers.byId(rfq.supplier_id);
    const spec = RfqSpecification.safeParse(rfq.specification);
    const targetQuantities = spec.success ? spec.data.quantities : [];

    try {
      const submitted = await adapter.submitRfq({
        supplierExternalId: supplier.external_id,
        productExternalId: null,
        messageBody: rfq.message_body,
        targetQuantities,
      });
      const externalMessageId = extractExternalMessageId(submitted);
      if (!externalMessageId) {
        await this.deps.repos.sourcing.rfqs.markDeliveryFailed(
          rfq.id,
          'Provider accepted the call but returned no message id; RFQ is not recorded as sent.',
        );
        return {
          outcome: 'delivery_failed',
          reason: 'Provider returned no external message id; refusing to mark the RFQ sent.',
        };
      }
      const sent = await this.deps.repos.sourcing.rfqs.markSent(rfq.id, externalMessageId);
      log.info({ rfqId: rfq.id, externalMessageId }, 'RFQ sent');
      return { outcome: 'sent', rfq: sent, externalMessageId };
    } catch (error) {
      if (
        error instanceof VendorApprovalRequiredError ||
        error instanceof CapabilityUnsupportedError ||
        error instanceof CredentialsMissingError
      ) {
        const reason = error.message;
        log.warn({ rfqId: rfq.id, reason }, 'RFQ submit blocked; leaving unsent');
        return {
          outcome: 'blocked',
          reason,
          blockedOn: { capability: 'sourcing.rfq_submit', reason },
        };
      }
      const reason = error instanceof Error ? error.message : String(error);
      await this.deps.repos.sourcing.rfqs.markDeliveryFailed(rfq.id, reason);
      throw error;
    }
  }

  async pollQuotes(input: { readonly rfqId: string }): Promise<PollQuotesResult> {
    const rfq = await this.deps.repos.sourcing.rfqs.byId(input.rfqId);

    let adapter: RfqSubmitAdapter;
    try {
      adapter = requireCapability<RfqSubmitAdapter>(this.deps, 'sourcing.quote_retrieve').adapter;
    } catch (error) {
      if (
        error instanceof CredentialsMissingError ||
        error instanceof CapabilityUnsupportedError ||
        error instanceof VendorApprovalRequiredError
      ) {
        return { quotes: [], blockedOn: { capability: 'sourcing.quote_retrieve', reason: error.message } };
      }
      throw error;
    }

    const ref = rfq.external_message_id;
    if (!ref) return { quotes: [] };

    const canGet = typeof adapter.getQuote === 'function';
    const canRetrieve = typeof adapter.retrieveQuotes === 'function';
    if (!canGet && !canRetrieve) {
      return {
        quotes: [],
        blockedOn: {
          capability: 'sourcing.quote_retrieve',
          reason: 'Resolved adapter does not implement getQuote or retrieveQuotes.',
        },
      };
    }

    try {
      const fetched = canGet
        ? await adapter.getQuote!({ rfqExternalRef: ref })
        : await adapter.retrieveQuotes!({ rfqExternalRef: ref, rfqId: rfq.id });
      const items = quoteItems(fetched);
      if (items.length === 0) return { quotes: [] };

      const intake = new SourcingQuoteService(this.deps);
      const quotes: QuoteRow[] = [];
      for (const item of items) {
        try {
          const recorded = await intake.recordFromProvider({
            rfqId: rfq.id,
            payload: withReceivedVia(item, 'provider_api'),
          });
          quotes.push(recorded.quote);
        } catch (error) {
          if (error instanceof ValidationError) continue;
          throw error;
        }
      }
      return { quotes };
    } catch (error) {
      if (
        error instanceof VendorApprovalRequiredError ||
        error instanceof CapabilityUnsupportedError ||
        error instanceof CredentialsMissingError
      ) {
        return { quotes: [], blockedOn: { capability: 'sourcing.quote_retrieve', reason: error.message } };
      }
      throw error;
    }
  }
}

/** @deprecated Use RfqService. */
export { RfqService as SourcingRfqService };

function quoteItems(fetched: unknown): readonly unknown[] {
  if (fetched == null) return [];
  if (Array.isArray(fetched)) return fetched;
  if (typeof fetched === 'object') {
    const rec = fetched as Record<string, unknown>;
    if (Array.isArray(rec.quotes)) return rec.quotes;
    if (Array.isArray(rec.items)) return rec.items;
    if (Object.keys(rec).length === 0) return [];
    return [fetched];
  }
  return [];
}

function withReceivedVia(payload: unknown, fallback: 'provider_api'): unknown {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    return { receivedVia: fallback, ...(payload as Record<string, unknown>) };
  }
  return payload;
}

function extractExternalMessageId(submitted: unknown): string | null {
  if (submitted == null || typeof submitted !== 'object') return null;
  const rec = submitted as Record<string, unknown>;
  for (const key of ['externalRfqRef', 'externalMessageId', 'external_message_id', 'id'] as const) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** Renders the outbound RFQ. Stored verbatim — this is the audit copy, not a template. */
export function renderRfqMessage(spec: RfqSpecificationType): string {
  const lines: string[] = [
    'REQUEST FOR QUOTATION',
    '',
    `Product: ${spec.productName}`,
    '',
    'Description:',
    spec.description,
    '',
    `Quantities (units): ${spec.quantities.join(', ')}`,
  ];

  if (spec.materials.length > 0) lines.push(`Materials: ${spec.materials.join(', ')}`);
  if (spec.dimensions) lines.push(`Dimensions: ${spec.dimensions}`);
  if (spec.colours.length > 0) lines.push(`Colours: ${spec.colours.join(', ')}`);
  if (spec.targetUnitCostCents != null) {
    lines.push(`Target unit cost (cents, our budget — not a bid): ${spec.targetUnitCostCents}`);
  }

  lines.push('');
  lines.push('Private label:');
  lines.push(`  Required: ${spec.privateLabel.required ? 'yes' : 'no'}`);
  if (spec.privateLabel.logoPlacement) lines.push(`  Logo placement: ${spec.privateLabel.logoPlacement}`);
  if (spec.privateLabel.printMethod) lines.push(`  Print method: ${spec.privateLabel.printMethod}`);
  if (spec.privateLabel.artworkFormat) lines.push(`  Artwork format: ${spec.privateLabel.artworkFormat}`);

  lines.push('');
  lines.push('Packaging:');
  lines.push(`  Required: ${spec.packaging.required ? 'yes' : 'no'}`);
  if (spec.packaging.style) lines.push(`  Style: ${spec.packaging.style}`);
  lines.push(`  Printed insert: ${spec.packaging.printedInsert ? 'yes' : 'no'}`);
  lines.push(`  Retail-ready: ${spec.packaging.retailReady ? 'yes' : 'no'}`);

  if (spec.certificationsRequired.length > 0) {
    lines.push('');
    lines.push(`Certifications required: ${spec.certificationsRequired.join(', ')}`);
  }

  lines.push('');
  lines.push(`Destination country: ${spec.destinationCountry}`);
  if (spec.destinationPostalCode) lines.push(`Destination postal code: ${spec.destinationPostalCode}`);
  lines.push(`Preferred incoterm: ${spec.preferredIncoterm}`);
  lines.push(`Sample requested: ${spec.sampleRequested ? 'yes' : 'no'}`);
  if (spec.targetLeadTimeDays != null) lines.push(`Target production lead time (days): ${spec.targetLeadTimeDays}`);
  if (spec.complianceNotes) {
    lines.push('');
    lines.push('Compliance notes:');
    lines.push(spec.complianceNotes);
  }

  lines.push('');
  lines.push(
    'Please reply with: unit price tiers for the quantities above, MOQ, production lead time, incoterm, ' +
      'sample cost and lead time, tooling/setup, customisation per unit, packaging per unit, origin port, ' +
      'and payment terms. State only figures you can honour; omit anything you cannot confirm.',
  );

  return lines.join('\n');
}
