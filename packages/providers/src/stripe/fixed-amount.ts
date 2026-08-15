/**
 * Fixed-price Payment Links and Checkout Session amounts.
 *
 * A Payment Link that lets the customer type an amount is not a catalogue
 * sale. Organizers still track `plink_1U4lK242nB81EBguRPuIHrxS`; we reuse that
 * id and pin it to a catalogue unit amount rather than minting a second URL.
 *
 * Fail closed: missing or unexpanded line items are treated as custom-amount,
 * because we cannot prove the customer cannot type a price.
 *
 * Checkout `shipping_options` are `fixed_amount` only — a calculated rate
 * would let Stripe invent a price this system never booked.
 */

import { ValidationError } from '@foundry/core';

export const HACKATHON_OFFER_PRICE_MINOR = 9900;
export const HACKATHON_OFFER_CURRENCY = 'usd';

export interface PaymentLinkPriceView {
  readonly line_items?: {
    readonly data?: readonly {
      readonly price?:
        | {
            readonly id?: string;
            readonly unit_amount?: number | null;
            readonly custom_unit_amount?: { readonly enabled?: boolean | null } | null;
          }
        | string
        | null;
    }[];
  } | null;
}

export function paymentLinkAllowsCustomAmount(link: PaymentLinkPriceView): boolean {
  const items = link.line_items?.data ?? [];
  if (items.length === 0) return true;
  return items.some((item) => {
    const price = item.price;
    if (!price || typeof price === 'string') return true;
    return price.custom_unit_amount?.enabled === true;
  });
}

export function paymentLinkFixedAmountMinor(link: PaymentLinkPriceView): number | null {
  if (paymentLinkAllowsCustomAmount(link)) return null;
  const items = link.line_items?.data ?? [];
  if (items.length !== 1) return null;
  const price = items[0]?.price;
  if (!price || typeof price === 'string') return null;
  return typeof price.unit_amount === 'number' ? price.unit_amount : null;
}

export function stripeFixedAmountShippingRate(input: {
  readonly displayName: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly minBusinessDays: number;
  readonly maxBusinessDays: number;
  readonly taxCode?: string;
  readonly automaticTax?: boolean;
}): {
  readonly shipping_rate_data: {
    readonly type: 'fixed_amount';
    readonly display_name: string;
    readonly fixed_amount: { readonly amount: number; readonly currency: string };
    readonly delivery_estimate: {
      readonly minimum: { readonly unit: 'business_day'; readonly value: number };
      readonly maximum: { readonly unit: 'business_day'; readonly value: number };
    };
    readonly tax_behavior?: 'exclusive';
    readonly tax_code?: string;
  };
} {
  if (input.amountMinor < 0) {
    throw new ValidationError('Shipping amount must be zero or a positive catalogue rate', {
      amountMinor: input.amountMinor,
    });
  }
  return {
    shipping_rate_data: {
      type: 'fixed_amount',
      display_name: input.displayName,
      fixed_amount: { amount: input.amountMinor, currency: input.currency.toLowerCase() },
      delivery_estimate: {
        minimum: { unit: 'business_day', value: input.minBusinessDays },
        maximum: { unit: 'business_day', value: input.maxBusinessDays },
      },
      ...(input.automaticTax
        ? { tax_behavior: 'exclusive' as const, tax_code: input.taxCode ?? 'txcd_92010001' }
        : {}),
    },
  };
}

export function stripeCataloguePriceData(input: {
  readonly currency: string;
  readonly unitAmountMinor: number;
  readonly name: string;
  readonly description?: string;
  readonly imageUrl?: string;
  readonly productId: string;
  readonly taxCode?: string;
}): {
  readonly currency: string;
  readonly unit_amount: number;
  readonly product_data: {
    readonly name: string;
    readonly description?: string;
    readonly images?: string[];
    readonly metadata: { readonly internal_product_id: string };
    readonly tax_code?: string;
  };
  readonly tax_behavior?: 'exclusive';
} {
  if (input.unitAmountMinor <= 0) {
    throw new ValidationError('Checkout line items must have a positive catalogue unit price', {
      unitAmountMinor: input.unitAmountMinor,
    });
  }
  return {
    currency: input.currency.toLowerCase(),
    unit_amount: input.unitAmountMinor,
    product_data: {
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      ...(input.imageUrl ? { images: [input.imageUrl] } : {}),
      metadata: { internal_product_id: input.productId },
      ...(input.taxCode ? { tax_code: input.taxCode } : {}),
    },
    ...(input.taxCode ? { tax_behavior: 'exclusive' as const } : {}),
  };
}
