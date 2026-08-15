/**
 * Reddit OAuth listing schemas.
 *
 * Field names follow the documented listing `data.{id,name,permalink,url,title,
 * selftext,body,created_utc,subreddit,score,num_comments}` shape. Optional
 * everywhere we have not pinned a required wire field, so a sparse child is
 * skipped by the mapper rather than crashing the collection run.
 */

import { z } from 'zod';

export const RedditThingData = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    permalink: z.string().optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    selftext: z.string().optional(),
    body: z.string().optional(),
    created_utc: z.number().optional(),
    subreddit: z.string().optional(),
    score: z.number().optional(),
    num_comments: z.number().optional(),
  })
  .passthrough();
export type RedditThingData = z.infer<typeof RedditThingData>;

export const RedditChild = z
  .object({
    kind: z.string().optional(),
    data: RedditThingData,
  })
  .passthrough();
export type RedditChild = z.infer<typeof RedditChild>;

export const RedditListing = z
  .object({
    kind: z.string().optional(),
    data: z
      .object({
        children: z.array(RedditChild).default([]),
        after: z.string().nullable().optional(),
        before: z.string().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type RedditListing = z.infer<typeof RedditListing>;

/** `GET /comments/{id}` returns `[postListing, commentListing]`. */
export const RedditThreadResponse = z.union([RedditListing, z.array(RedditListing)]);
export type RedditThreadResponse = z.infer<typeof RedditThreadResponse>;

export const RedditTokenResponse = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string(),
    expires_in: z.number().positive(),
    scope: z.string().optional(),
  })
  .passthrough();
export type RedditTokenResponse = z.infer<typeof RedditTokenResponse>;
