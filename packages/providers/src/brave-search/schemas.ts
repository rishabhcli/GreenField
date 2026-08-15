/**
 * Brave Search Web API schemas.
 *
 * Narrowed to the fields this system actually consumes from
 * `GET /res/v1/web/search` (verified against Brave's 2026-08-15 docs):
 * `query`, `web.results[]` with `title`, `url`, `description`, and optional
 * `extra_snippets` when `extra_snippets=true` is requested. Unknown fields
 * pass through so a documented addition does not become a contract error.
 */

import { z } from 'zod';

export const BraveWebResult = z
  .object({
    title: z.string().optional(),
    url: z.string().optional(),
    description: z.string().optional(),
    extra_snippets: z.array(z.string()).optional(),
  })
  .passthrough();
export type BraveWebResult = z.infer<typeof BraveWebResult>;

export const BraveWebSearchResponse = z
  .object({
    query: z.unknown().optional(),
    web: z
      .object({
        results: z.array(BraveWebResult).default([]),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type BraveWebSearchResponse = z.infer<typeof BraveWebSearchResponse>;
