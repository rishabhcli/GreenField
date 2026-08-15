/**
 * Commerce domain: catalogue, orders, and the order state machine.
 *
 * Money state is derived from provider webhooks, never from a browser redirect.
 * `OrderStatus` transitions are validated by an explicit adjacency table so an
 * agent, a webhook and a support action cannot drive an order into a state that
 * the business does not actually support (e.g. REFUNDED -> SHIPPED).
 */

import { z } from 'zod';
import { ConflictError } from '../errors.js';

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                   */
/* -------------------------------------------------------------------------- */

export const ProductKind = z.enum(['physical_good', 'digital_good', 'subscription', 'service', 'membership']);
export type ProductKind = z.infer<typeof ProductKind>;

/**
 * Which payment rail a product must use. Physical goods run through Stripe with
 * the operating company as merchant of record; eligible digital goods can run
 * through Dodo as merchant of record. This is a compliance boundary, not a
 * preference — `assertPaymentRoute` enforces it.
 */
export const PaymentRoute = z.enum(['stripe_direct', 'dodo_merchant_of_record', 'whop_checkout']);
export type PaymentRoute = z.infer<typeof PaymentRoute>;

export const Product = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  opportunityId: z.string().nullable(),
  brandId: z.string().nullable(),
  sku: z.string().min(1),
  name: z.string().min(1),
  kind: ProductKind,
  description: z.string().min(1),
  /** Shipping/compliance attributes for physical goods. */
  physical: z
    .object({
      weightGrams: z.number().int().positive(),
      lengthMm: z.number().int().positive(),
      widthMm: z.number().int().positive(),
      heightMm: z.number().int().positive(),
      hsCode: z.string().nullable(),
      countryOfOrigin: z.string().length(2),
      hazardous: z.boolean().default(false),
      batteryContained: z.boolean().default(false),
    })
    .nullable(),
  paymentRoute: PaymentRoute,
  /** External ids per provider, e.g. `{ stripe_product: "prod_...", stripe_price: "price_..." }`. */
  externalRefs: z.record(z.string(), z.string()).default({}),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  compareAtPriceMinor: z.number().int().nonnegative().nullable(),
  supplierId: z.string().nullable(),
  landedCostModelId: z.string().nullable(),
  inventoryPolicy: z.enum(['track', 'continue_selling', 'preorder', 'made_to_order']).default('track'),
  inventoryOnHand: z.number().int().nonnegative().default(0),
  inventoryReserved: z.number().int().nonnegative().default(0),
  status: z.enum(['draft', 'review', 'active', 'paused', 'discontinued']).default('draft'),
  complianceApprovalId: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Product = z.infer<typeof Product>;

/**
 * Dodo Payments documents its Merchant-of-Record offering around digital
 * products and SaaS. Routing a physical private-label good through it would be
 * a false compliance claim, so it is rejected structurally.
 */
export function assertPaymentRoute(kind: ProductKind, route: PaymentRoute): void {
  if (route === 'dodo_merchant_of_record' && kind === 'physical_good') {
    throw new ConflictError(
      'Dodo Payments is documented as Merchant of Record for digital products and SaaS. ' +
        'Routing a physical good through it would misstate who bears transaction and tax liability. ' +
        'Use stripe_direct for physical goods.',
      { kind, route },
    );
  }
  if (route === 'whop_checkout' && kind === 'physical_good') {
    throw new ConflictError(
      'Whop checkout is used here for digital/membership commerce primitives. ' +
        'Physical private-label fulfilment is not attributed to Whop.',
      { kind, route },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Order state machine                                                         */
/* -------------------------------------------------------------------------- */

export const ORDER_STATUSES = [
  'CREATED',
  'CHECKOUT_STARTED',
  'PAYMENT_PENDING',
  'PAID',
  'FULFILLMENT_QUEUED',
  'FULFILLING',
  'SHIPPED',
  'DELIVERED',
  // exceptional branches
  'PAYMENT_FAILED',
  'CANCELLED',
  'REFUND_REQUESTED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'RETURN_REQUESTED',
  'RETURNED',
  'DISPUTED',
  'LOST_OR_DAMAGED',
  'MANUAL_REVIEW',
] as const;

export const OrderStatus = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatus>;

/**
 * Legal transitions. Deliberately explicit rather than derived: every arrow
 * here is a business decision someone can review.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  // CREATED may go straight to PAYMENT_PENDING or PAID, not only to
  // CHECKOUT_STARTED. The normal path records checkout start first, but a
  // provider webhook can win the race against our own write. Money arriving is
  // authoritative: refusing that transition would mean we captured a real
  // customer's funds and hold no order record of it, which is precisely the
  // unreconciled-payment failure this state machine exists to prevent.
  CREATED: ['CHECKOUT_STARTED', 'PAYMENT_PENDING', 'PAID', 'PAYMENT_FAILED', 'CANCELLED', 'MANUAL_REVIEW'],
  CHECKOUT_STARTED: ['PAYMENT_PENDING', 'PAID', 'PAYMENT_FAILED', 'CANCELLED', 'MANUAL_REVIEW'],
  PAYMENT_PENDING: ['PAID', 'PAYMENT_FAILED', 'CANCELLED', 'MANUAL_REVIEW'],
  PAID: [
    'FULFILLMENT_QUEUED',
    'REFUND_REQUESTED',
    'REFUNDED',
    'PARTIALLY_REFUNDED',
    'DISPUTED',
    'CANCELLED',
    'MANUAL_REVIEW',
  ],
  FULFILLMENT_QUEUED: ['FULFILLING', 'CANCELLED', 'REFUND_REQUESTED', 'DISPUTED', 'MANUAL_REVIEW'],
  FULFILLING: ['SHIPPED', 'LOST_OR_DAMAGED', 'REFUND_REQUESTED', 'DISPUTED', 'MANUAL_REVIEW'],
  SHIPPED: ['DELIVERED', 'LOST_OR_DAMAGED', 'RETURN_REQUESTED', 'REFUND_REQUESTED', 'DISPUTED', 'MANUAL_REVIEW'],
  DELIVERED: ['RETURN_REQUESTED', 'REFUND_REQUESTED', 'DISPUTED', 'MANUAL_REVIEW'],
  PAYMENT_FAILED: ['CHECKOUT_STARTED', 'PAYMENT_PENDING', 'CANCELLED', 'MANUAL_REVIEW'],
  CANCELLED: ['REFUND_REQUESTED', 'REFUNDED', 'MANUAL_REVIEW'],
  REFUND_REQUESTED: ['REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED', 'MANUAL_REVIEW', 'PAID', 'DELIVERED'],
  PARTIALLY_REFUNDED: ['REFUNDED', 'REFUND_REQUESTED', 'DISPUTED', 'MANUAL_REVIEW'],
  REFUNDED: ['DISPUTED', 'MANUAL_REVIEW'],
  RETURN_REQUESTED: ['RETURNED', 'REFUND_REQUESTED', 'DELIVERED', 'MANUAL_REVIEW'],
  RETURNED: ['REFUNDED', 'PARTIALLY_REFUNDED', 'MANUAL_REVIEW'],
  DISPUTED: ['REFUNDED', 'PARTIALLY_REFUNDED', 'PAID', 'DELIVERED', 'MANUAL_REVIEW'],
  LOST_OR_DAMAGED: ['REFUNDED', 'PARTIALLY_REFUNDED', 'FULFILLMENT_QUEUED', 'MANUAL_REVIEW'],
  // Manual review is the universal escape hatch back into the flow.
  MANUAL_REVIEW: [...ORDER_STATUSES],
};

/** Terminal for automation — only a human/manual review moves these on. */
export const ORDER_TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'REFUNDED',
  'RETURNED',
  'CANCELLED',
]);

/** Statuses in which the company holds the customer's money. */
export const ORDER_MONEY_HELD_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'PAID',
  'FULFILLMENT_QUEUED',
  'FULFILLING',
  'SHIPPED',
  'DELIVERED',
  'RETURN_REQUESTED',
  'PARTIALLY_REFUNDED',
  'REFUND_REQUESTED',
  'DISPUTED',
  'LOST_OR_DAMAGED',
]);

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return true; // idempotent re-delivery of the same webhook
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus, orderId: string): void {
  if (!canTransition(from, to)) {
    throw new ConflictError(
      `Illegal order transition ${from} -> ${to}. Allowed: ${(ORDER_TRANSITIONS[from] ?? []).join(', ')}`,
      { orderId, from, to },
    );
  }
}

/**
 * Ranks how far an order has progressed. Webhooks arrive out of order in
 * practice; a late `payment_intent.processing` must not pull a PAID order
 * backwards. Higher rank wins unless the transition is an exceptional branch.
 */
const PROGRESS_RANK: Readonly<Record<OrderStatus, number>> = {
  CREATED: 0,
  CHECKOUT_STARTED: 1,
  PAYMENT_PENDING: 2,
  PAYMENT_FAILED: 2,
  PAID: 3,
  FULFILLMENT_QUEUED: 4,
  FULFILLING: 5,
  SHIPPED: 6,
  DELIVERED: 7,
  RETURN_REQUESTED: 8,
  RETURNED: 9,
  REFUND_REQUESTED: 8,
  PARTIALLY_REFUNDED: 9,
  REFUNDED: 10,
  DISPUTED: 10,
  LOST_OR_DAMAGED: 8,
  CANCELLED: 10,
  MANUAL_REVIEW: 11,
};

/** True when applying `incoming` would move the order backwards. */
export function isStaleTransition(current: OrderStatus, incoming: OrderStatus): boolean {
  return PROGRESS_RANK[incoming] < PROGRESS_RANK[current];
}

/* -------------------------------------------------------------------------- */
/* Orders                                                                      */
/* -------------------------------------------------------------------------- */

export const Address = z.object({
  name: z.string().min(1),
  line1: z.string().min(1),
  line2: z.string().nullable(),
  city: z.string().min(1),
  state: z.string().nullable(),
  postalCode: z.string().min(1),
  country: z.string().length(2),
  phone: z.string().nullable(),
});
export type Address = z.infer<typeof Address>;

export const OrderLineItem = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  sku: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceMinor: z.number().int().nonnegative(),
  subtotalMinor: z.number().int().nonnegative(),
  taxMinor: z.number().int().nonnegative().default(0),
  discountMinor: z.number().int().nonnegative().default(0),
  /** Landed cost snapshot at time of sale, for accurate historical margin. */
  landedUnitCostMinor: z.number().int().nonnegative().nullable(),
  fulfilledQuantity: z.number().int().nonnegative().default(0),
  refundedQuantity: z.number().int().nonnegative().default(0),
});
export type OrderLineItem = z.infer<typeof OrderLineItem>;

export const Order = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  siteId: z.string().nullable(),
  /** Human-facing order number, e.g. `NB-10241`. */
  orderNumber: z.string().min(1),
  customerId: z.string().min(1),
  status: OrderStatus,
  paymentRoute: PaymentRoute,

  currency: z.string().length(3),
  subtotalMinor: z.number().int().nonnegative(),
  shippingMinor: z.number().int().nonnegative().default(0),
  taxMinor: z.number().int().nonnegative().default(0),
  discountMinor: z.number().int().nonnegative().default(0),
  totalMinor: z.number().int().nonnegative(),
  amountPaidMinor: z.number().int().nonnegative().default(0),
  amountRefundedMinor: z.number().int().nonnegative().default(0),

  lineItems: z.array(OrderLineItem).min(1),
  shippingAddress: Address.nullable(),
  billingAddress: Address.nullable(),

  /** Provider object ids: checkout session, payment intent, charge. */
  externalRefs: z.record(z.string(), z.string()).default({}),
  /** Attribution captured at checkout: utm params, click ids, experiment arm. */
  attribution: z.record(z.string(), z.string()).default({}),

  supplierReference: z.string().nullable().default(null),
  threePlReference: z.string().nullable().default(null),
  riskLevel: z.enum(['normal', 'elevated', 'highest', 'unknown']).default('unknown'),
  manualReviewReason: z.string().nullable().default(null),

  placedAt: z.string().datetime().nullable(),
  paidAt: z.string().datetime().nullable(),
  shippedAt: z.string().datetime().nullable(),
  deliveredAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Order = z.infer<typeof Order>;

export const OrderEventKind = z.enum([
  'created',
  'checkout_started',
  'payment_webhook_received',
  'status_changed',
  'payment_captured',
  'payment_failed',
  'refund_issued',
  'dispute_opened',
  'dispute_closed',
  'fulfilment_requested',
  'shipment_created',
  'tracking_updated',
  'delivered',
  'return_requested',
  'return_received',
  'note_added',
  'manual_review_flagged',
  'manual_review_cleared',
]);
export type OrderEventKind = z.infer<typeof OrderEventKind>;

/** Append-only. Never updated or deleted; the order's history is the truth. */
export const OrderEvent = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  kind: OrderEventKind,
  fromStatus: OrderStatus.nullable(),
  toStatus: OrderStatus.nullable(),
  /** `webhook:stripe`, `agent:support_specialist`, `human:operator@…`, `job:reconcile`. */
  actor: z.string().min(1),
  /** Provider event id, so duplicate deliveries collapse to one event. */
  externalEventId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()).default({}),
  occurredAt: z.string().datetime(),
  recordedAt: z.string().datetime(),
});
export type OrderEvent = z.infer<typeof OrderEvent>;

/* -------------------------------------------------------------------------- */
/* Customers, payments, shipments                                              */
/* -------------------------------------------------------------------------- */

export const Customer = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  email: z.string().email().nullable(),
  phoneE164: z.string().nullable(),
  name: z.string().nullable(),
  externalRefs: z.record(z.string(), z.string()).default({}),
  marketingConsent: z.object({
    email: z.boolean().default(false),
    sms: z.boolean().default(false),
    /** Where and when consent was captured — required for SMS compliance. */
    capturedAt: z.string().datetime().nullable(),
    capturedSource: z.string().nullable(),
    optedOutAt: z.string().datetime().nullable(),
  }),
  totalOrders: z.number().int().nonnegative().default(0),
  lifetimeValueMinor: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Customer = z.infer<typeof Customer>;

export const PaymentStatus = z.enum([
  'requires_payment_method',
  'requires_action',
  'processing',
  'succeeded',
  'failed',
  'canceled',
  'refunded',
  'partially_refunded',
  'disputed',
]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const Payment = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  orderId: z.string().min(1),
  provider: z.enum(['stripe', 'dodo', 'whop']),
  /** Provider's payment intent / payment id. Unique per provider. */
  externalId: z.string().min(1),
  status: PaymentStatus,
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  /** Provider fee, when the provider reports it. Null when not yet known. */
  feeMinor: z.number().int().nonnegative().nullable(),
  netMinor: z.number().int().nullable(),
  paymentMethodBrand: z.string().nullable(),
  paymentMethodLast4: z.string().nullable(),
  riskScore: z.number().int().nullable(),
  riskLevel: z.string().nullable(),
  capturedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Payment = z.infer<typeof Payment>;

export const Shipment = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  orderId: z.string().min(1),
  carrier: z.string().min(1),
  service: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  trackingUrl: z.string().url().nullable(),
  labelUrl: z.string().url().nullable(),
  costMinor: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  status: z.enum(['created', 'label_purchased', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'returned']),
  shippedAt: z.string().datetime().nullable(),
  deliveredAt: z.string().datetime().nullable(),
  lineItemIds: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Shipment = z.infer<typeof Shipment>;

/* -------------------------------------------------------------------------- */
/* Order totals                                                                */
/* -------------------------------------------------------------------------- */

export interface OrderTotals {
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly discountMinor: number;
  readonly shippingMinor: number;
  readonly totalMinor: number;
}

export function computeOrderTotals(
  lineItems: readonly Pick<OrderLineItem, 'subtotalMinor' | 'taxMinor' | 'discountMinor'>[],
  shippingMinor: number,
): OrderTotals {
  const subtotalMinor = lineItems.reduce((acc, li) => acc + li.subtotalMinor, 0);
  const taxMinor = lineItems.reduce((acc, li) => acc + li.taxMinor, 0);
  const discountMinor = lineItems.reduce((acc, li) => acc + li.discountMinor, 0);
  return {
    subtotalMinor,
    taxMinor,
    discountMinor,
    shippingMinor,
    totalMinor: subtotalMinor + taxMinor + shippingMinor - discountMinor,
  };
}

/** Refund ceiling: never refund more than was actually captured. */
export function maxRefundableMinor(order: Pick<Order, 'amountPaidMinor' | 'amountRefundedMinor'>): number {
  return Math.max(0, order.amountPaidMinor - order.amountRefundedMinor);
}

export function statusAfterRefund(order: Pick<Order, 'amountPaidMinor' | 'amountRefundedMinor'>, refundMinor: number): OrderStatus {
  const total = order.amountRefundedMinor + refundMinor;
  if (total >= order.amountPaidMinor && order.amountPaidMinor > 0) return 'REFUNDED';
  return 'PARTIALLY_REFUNDED';
}
