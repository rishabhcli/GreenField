/**
 * Fulfilment: turning a paid order into a shipped one.
 *
 * The governing rule is that this service never reports progress it did not
 * cause. An order does not become `SHIPPED` because we intended to ship it; it
 * becomes `SHIPPED` when a carrier label actually exists and a tracking number
 * came back from the fulfilment provider. Everything short of that leaves the
 * order in a queued or blocked state with the reason recorded, which is what a
 * customer-facing status page and a support agent both need to be truthful.
 */

import { z } from 'zod';
import { PolicyDeniedError, ValidationError } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import { optionalCapability, type ServiceDeps } from '../deps.js';

/** The subset of a shipping provider this service depends on. */
export interface ShippingProvider {
  quoteRates(input: {
    toAddress: Record<string, unknown>;
    fromAddress: Record<string, unknown>;
    parcels: readonly { lengthCm: number; widthCm: number; heightCm: number; weightG: number }[];
  }): Promise<readonly { rateId: string; carrier: string; service: string; amountMinor: number; currency: string; estimatedDays: number | null }[]>;

  purchaseLabel(input: { rateId: string; idempotencyKey: string }): Promise<{
    shipmentId: string;
    trackingNumber: string | null;
    trackingUrl: string | null;
    labelUrl: string | null;
    carrier: string;
    service: string;
    costMinor: number;
    currency: string;
  }>;

  getTracking(input: { carrier: string; trackingNumber: string }): Promise<{
    status: string;
    deliveredAt: Date | null;
    lastEventAt: Date | null;
    lastEventDescription: string | null;
  }>;
}

export interface FulfilmentResult {
  readonly outcome: 'shipped' | 'queued' | 'blocked' | 'already_fulfilled' | 'not_payable';
  readonly reason?: string;
  readonly trackingNumber?: string;
}

export class FulfilmentService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Attempts to fulfil one order.
   *
   * Runs on the `fulfilment.sync` queue and is retried, so every step is
   * idempotent: the label purchase is keyed on the order id, and an order that
   * already has a shipment short-circuits.
   */
  async fulfil(orderId: string): Promise<FulfilmentResult> {
    const log = getLogger();
    const order = await this.deps.repos.commerce.orders.byId(orderId);

    // Never ship against an unpaid order. This is the check that stops a
    // mis-mapped webhook from turning into a real shipping cost.
    if (order.amount_paid_minor <= 0) {
      return {
        outcome: 'not_payable',
        reason: `order ${order.order_number} has no captured payment (amount_paid_minor=${order.amount_paid_minor})`,
      };
    }

    if (order.status === 'MANUAL_REVIEW') {
      return { outcome: 'blocked', reason: order.manual_review_reason ?? 'held for manual review' };
    }

    const killed = await this.deps.repos.governance.killSwitches.engagedScopes(order.company_id);
    if (killed.includes('fulfilment') || killed.includes('all')) {
      return { outcome: 'blocked', reason: 'fulfilment kill switch is engaged' };
    }

    const existing = await this.deps.repos.commerce.shipments.forOrder(orderId);
    if (existing.length > 0) {
      const withTracking = existing.find((s) => s.tracking_number !== null);
      return withTracking
        ? { outcome: 'already_fulfilled', trackingNumber: withTracking.tracking_number ?? undefined }
        : { outcome: 'queued', reason: 'a shipment record exists but no tracking number yet' };
    }

    const items = await this.deps.repos.commerce.orders.lineItems(orderId);
    // Which lines actually need a carrier. `physical` on the product row is the
    // authority — the DB refuses to store a physical good without dimensions,
    // so a line with a physical spec is a line we can genuinely quote.
    const lines = await Promise.all(
      items.map(async (li) => ({
        line: li,
        product: li.product_id ? await this.deps.repos.commerce.products.byId(li.product_id) : null,
      })),
    );
    const physical = lines.filter((l) => l.product?.kind === 'physical_good');
    if (physical.length === 0) {
      // A digital-only order needs no carrier. Move it straight to delivered
      // with an explicit event so the history says why.
      await this.deps.repos.commerce.orders.applyEvent({
        orderId,
        kind: 'delivered',
        toStatus: 'DELIVERED',
        actor: 'service:fulfilment',
        payload: { reason: 'digital order; no physical shipment required' },
      });
      return { outcome: 'shipped', reason: 'digital delivery' };
    }

    /* ------------------------------------------------------------------ */
    /* Carrier                                                             */
    /* ------------------------------------------------------------------ */
    const shipping = optionalCapability<ShippingProvider>(this.deps, 'fulfilment.label_purchase');
    if (!shipping) {
      const status = this.deps.providers.forCapability('fulfilment.label_purchase').status;
      const reason =
        status.remediation ?? `no shipping provider is usable (state: ${status.state})`;
      // The order stays queued, not failed. The payment is real and the
      // obligation to ship stands; it is the capability that is missing.
      await this.deps.repos.commerce.orders.applyEvent({
        orderId,
        kind: 'note_added',
        toStatus: 'FULFILLMENT_QUEUED',
        actor: 'service:fulfilment',
        payload: { blockedOn: 'fulfilment.label_purchase', reason },
      });
      log.warn({ orderId, reason }, 'fulfilment blocked: no shipping capability');
      return { outcome: 'blocked', reason };
    }

    const customer = await this.deps.repos.commerce.customers.byId(order.customer_id);
    const toAddress = order.shipping_address;
    if (!toAddress || Object.keys(toAddress).length === 0) {
      await this.deps.repos.commerce.orders.applyEvent({
        orderId,
        kind: 'manual_review_flagged',
        toStatus: 'MANUAL_REVIEW',
        actor: 'service:fulfilment',
        manualReviewReason: 'paid order has no shipping address',
        payload: { customerId: customer.id },
      });
      return { outcome: 'blocked', reason: 'paid order has no shipping address' };
    }

    /* ------------------------------------------------------------------ */
    /* Spend authorisation                                                 */
    /* ------------------------------------------------------------------ */
    const parcelResult = buildParcels(physical);
    if ('blockedReason' in parcelResult) {
      await this.deps.repos.commerce.orders.applyEvent({
        orderId,
        kind: 'manual_review_flagged',
        toStatus: 'MANUAL_REVIEW',
        actor: 'service:fulfilment',
        manualReviewReason: parcelResult.blockedReason,
        payload: { reason: parcelResult.blockedReason },
      });
      return { outcome: 'blocked', reason: parcelResult.blockedReason };
    }
    const parcels = parcelResult.parcels;
    const rates = await shipping.quoteRates({
      toAddress: toAddress as Record<string, unknown>,
      fromAddress: await this.#originAddress(order.company_id),
      parcels,
    });
    if (rates.length === 0) {
      return { outcome: 'blocked', reason: 'carrier returned no rates for this destination' };
    }

    // Cheapest rate that still has a delivery estimate. An estimate-less rate
    // cannot be promised to a customer, so it is not chosen automatically.
    const candidates = rates.filter((r) => r.estimatedDays !== null);
    const chosen = (candidates.length > 0 ? candidates : rates).reduce((best, r) =>
      r.amountMinor < best.amountMinor ? r : best,
    );

    const decision = await this.deps.gate.evaluate({
      companyId: order.company_id,
      authority: 'fulfilment.purchase_label',
      actorHandle: 'fulfilment_specialist',
      amountMinor: chosen.amountMinor,
      currency: chosen.currency,
      budgetScope: 'inventory',
      subjectRefId: orderId,
      action: `purchase shipping label for order ${order.order_number} via ${chosen.carrier} ${chosen.service}`,
    });

    if (decision.outcome === 'deny') {
      throw new PolicyDeniedError(`Label purchase denied: ${decision.explanation}`, { orderId });
    }
    if (decision.outcome === 'require_approval') {
      await this.deps.repos.commerce.orders.applyEvent({
        orderId,
        kind: 'note_added',
        toStatus: 'FULFILLMENT_QUEUED',
        actor: 'service:fulfilment',
        payload: { awaitingApprovalId: decision.approvalId, rate: chosen },
      });
      return { outcome: 'queued', reason: `awaiting approval ${decision.approvalId}` };
    }

    /* ------------------------------------------------------------------ */
    /* Purchase                                                            */
    /* ------------------------------------------------------------------ */
    try {
      const label = await shipping.purchaseLabel({
        rateId: chosen.rateId,
        // Keyed on the order, so a retry of this job reuses the same label
        // rather than buying a second one.
        idempotencyKey: `label:${orderId}`,
      });

      await this.deps.repos.commerce.shipments.create({
        companyId: order.company_id,
        orderId,
        provider: 'shippo',
        externalId: label.shipmentId,
        carrier: label.carrier,
        service: label.service,
        trackingNumber: label.trackingNumber,
        trackingUrl: label.trackingUrl,
        labelUrl: label.labelUrl,
        costMinor: label.costMinor,
        currency: label.currency,
        status: label.trackingNumber ? 'label_purchased' : 'pending',
      });

      await decision.settle(label.costMinor);

      // Only claim SHIPPED when there is a tracking number to back it up.
      if (label.trackingNumber) {
        await this.deps.repos.commerce.orders.applyEvent({
          orderId,
          kind: 'shipment_created',
          toStatus: 'SHIPPED',
          actor: 'service:fulfilment',
          payload: {
            carrier: label.carrier,
            service: label.service,
            trackingNumber: label.trackingNumber,
            costMinor: label.costMinor,
          },
        });
        log.info({ orderId, carrier: label.carrier, tracking: label.trackingNumber }, 'order shipped');
        return { outcome: 'shipped', trackingNumber: label.trackingNumber };
      }

      await this.deps.repos.commerce.orders.applyEvent({
        orderId,
        kind: 'shipment_created',
        toStatus: 'FULFILLING',
        actor: 'service:fulfilment',
        payload: { carrier: label.carrier, note: 'label purchased; awaiting tracking number' },
      });
      return { outcome: 'queued', reason: 'label purchased, tracking number pending' };
    } catch (error) {
      // Release the reservation so a failed purchase does not permanently
      // consume budget the company never spent.
      await decision.release();
      throw error;
    }
  }

  /**
   * Refreshes tracking for in-flight shipments and advances delivered orders.
   *
   * Delivery is recorded from the carrier's own status, never inferred from
   * elapsed time — "it has been five days so it must have arrived" is exactly
   * the kind of claim this system must not make.
   */
  async syncTracking(companyId: string): Promise<{ checked: number; delivered: number }> {
    const shipping = optionalCapability<ShippingProvider>(this.deps, 'fulfilment.tracking');
    if (!shipping) return { checked: 0, delivered: 0 };

    const inFlight = await this.deps.repos.commerce.shipments.inFlight(companyId);
    let delivered = 0;

    for (const shipment of inFlight) {
      if (!shipment.tracking_number) continue;
      const tracking = await shipping.getTracking({
        carrier: shipment.carrier,
        trackingNumber: shipment.tracking_number,
      });

      await this.deps.repos.commerce.shipments.updateStatus(shipment.id, {
        status: normaliseTrackingStatus(tracking.status),
        ...(tracking.deliveredAt ? { deliveredAt: tracking.deliveredAt } : {}),
        ...(tracking.lastEventDescription ? { lastEvent: tracking.lastEventDescription } : {}),
      });

      if (tracking.deliveredAt) {
        await this.deps.repos.commerce.orders.applyEvent({
          orderId: shipment.order_id,
          kind: 'delivered',
          toStatus: 'DELIVERED',
          actor: 'service:fulfilment',
          occurredAt: tracking.deliveredAt,
          payload: { carrier: shipment.carrier, trackingNumber: shipment.tracking_number },
        });
        delivered += 1;
      }
    }

    return { checked: inFlight.length, delivered };
  }

  /** Ship-from address, taken from the company's declared origin countries. */
  async #originAddress(companyId: string): Promise<Record<string, unknown>> {
    const company = await this.deps.repos.companies.byId(companyId);
    const config = company.config as { legalEntity?: { registeredAddress?: Record<string, unknown> | null } };
    const address = config.legalEntity?.registeredAddress;
    if (!address) {
      throw new ValidationError(
        `Company ${companyId} has no registered address, so no ship-from address exists. ` +
          `Set legalEntity.registeredAddress before fulfilling physical orders.`,
      );
    }
    return address;
  }
}

/** Dimensions and weight recorded on a physical product, in the DB's units. */
const PhysicalSpec = z.object({
  weightGrams: z.number().int().positive(),
  lengthMm: z.number().int().positive(),
  widthMm: z.number().int().positive(),
  heightMm: z.number().int().positive(),
});

/**
 * Builds one parcel per line from the product's recorded packaging spec.
 *
 * There is deliberately no default box size. A guessed dimension produces a
 * real quote for a shipment that does not exist, which either under-charges the
 * customer or gets rejected at the counter — so a missing spec blocks the order
 * for a human instead.
 */
function buildParcels(
  lines: readonly { line: { quantity: number }; product: { sku: string; physical: unknown } | null }[],
):
  | { parcels: readonly { lengthCm: number; widthCm: number; heightCm: number; weightG: number }[] }
  | { blockedReason: string } {
  const parcels: { lengthCm: number; widthCm: number; heightCm: number; weightG: number }[] = [];

  for (const { line, product } of lines) {
    const spec = PhysicalSpec.safeParse(product?.physical);
    if (!spec.success) {
      return {
        blockedReason:
          `Product ${product?.sku ?? 'unknown'} has no usable packaging spec ` +
          `(${spec.error.issues.map((i) => i.path.join('.')).join(', ') || 'missing'}). ` +
          `Sourcing must record weight and dimensions before a shipping rate can be quoted.`,
      };
    }
    // One parcel per unit. Consolidating into fewer boxes is a real
    // optimisation, but it changes the rate, so it is not assumed here.
    for (let i = 0; i < line.quantity; i += 1) {
      parcels.push({
        lengthCm: spec.data.lengthMm / 10,
        widthCm: spec.data.widthMm / 10,
        heightCm: spec.data.heightMm / 10,
        weightG: spec.data.weightGrams,
      });
    }
  }

  return { parcels };
}

function normaliseTrackingStatus(raw: string): string {
  const value = raw.toLowerCase();
  if (value.includes('deliver')) return 'delivered';
  if (value.includes('transit') || value.includes('accepted')) return 'in_transit';
  if (value.includes('out_for') || value.includes('out for')) return 'out_for_delivery';
  if (value.includes('return')) return 'returned';
  if (value.includes('fail') || value.includes('exception')) return 'exception';
  return 'label_purchased';
}
