/**
 * Zod schemas for Alibaba Open Platform responses.
 *
 * Unlike every other schema file in this package, these are deliberately
 * loose: `openapi.alibaba.com/doc/doc.htm` and `.../doc/api.htm` both render
 * as an empty client-side shell under WebFetch (confirmed 2026-08-15 — both
 * requests returned only a loading skeleton, no server-rendered
 * documentation body), so the exact field names in a real response were not
 * independently confirmed. Every field below is `.optional()` and every
 * object uses `.passthrough()`, so a real response — whatever its actual
 * shape turns out to be — is captured rather than rejected, and the honest
 * extraction functions in `./alibaba.ts` return `null` for anything not
 * present rather than guessing. See `./alibaba.ts` for the UNVERIFIED
 * request-signing note this pairs with.
 */

import { z } from 'zod';

export const AlibabaProductItem = z
  .object({
    product_id: z.union([z.string(), z.number()]),
    subject: z.string().optional(),
    supplier_id: z.union([z.string(), z.number()]).optional(),
    min_order_quantity: z.number().optional(),
    price: z.union([z.string(), z.number()]).optional(),
    currency: z.string().optional(),
    image_urls: z.array(z.string()).optional(),
    description: z.string().optional(),
  })
  .passthrough();
export type AlibabaProductItem = z.infer<typeof AlibabaProductItem>;

export const AlibabaProductSearchResponse = z
  .object({
    items: z.array(AlibabaProductItem).default([]),
    total: z.number().optional(),
  })
  .passthrough();
export type AlibabaProductSearchResponse = z.infer<typeof AlibabaProductSearchResponse>;

export const AlibabaProductDetailsResponse = AlibabaProductItem;
export type AlibabaProductDetailsResponse = z.infer<typeof AlibabaProductDetailsResponse>;

export const AlibabaSupplierItem = z
  .object({
    supplier_id: z.union([z.string(), z.number()]),
    company_name: z.string().optional(),
    country: z.string().optional(),
    years_active: z.number().optional(),
    certifications: z.array(z.string()).optional(),
    gold_supplier: z.boolean().optional(),
  })
  .passthrough();
export type AlibabaSupplierItem = z.infer<typeof AlibabaSupplierItem>;

export const AlibabaSupplierSearchResponse = z
  .object({
    items: z.array(AlibabaSupplierItem).default([]),
    total: z.number().optional(),
  })
  .passthrough();
export type AlibabaSupplierSearchResponse = z.infer<typeof AlibabaSupplierSearchResponse>;

export const AlibabaSupplierProfileResponse = AlibabaSupplierItem;
export type AlibabaSupplierProfileResponse = z.infer<typeof AlibabaSupplierProfileResponse>;
