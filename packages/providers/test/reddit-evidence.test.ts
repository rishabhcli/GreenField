/**
 * Reddit listing → EvidenceDraft mapping.
 *
 * The helper must refuse to invent a URL or id. Provenance is always the
 * public Reddit OAuth API — never a "model generated this" method.
 */

import { describe, expect, it } from 'vitest';
import { listingToEvidenceDrafts } from '../src/reddit/index.js';

const ENDPOINT = '/search';

describe('listingToEvidenceDrafts', () => {
  it('skips children that have neither permalink nor id rather than inventing a URL', () => {
    const drafts = listingToEvidenceDrafts(
      {
        kind: 'Listing',
        data: {
          children: [{ kind: 't3', data: { title: 'a post with no identity' } }],
        },
      },
      { endpoint: ENDPOINT },
    );
    expect(drafts).toHaveLength(0);
  });

  it('does not invent URLs when permalink is missing; uses the real name as externalId', () => {
    const drafts = listingToEvidenceDrafts(
      {
        kind: 'Listing',
        data: {
          children: [
            {
              kind: 't3',
              data: {
                id: 'abc123',
                name: 't3_abc123',
                title: 'Real post, no permalink',
                selftext: 'Public selftext from the listing.',
                subreddit: 'homeimprovement',
                created_utc: 1_700_000_000,
                score: 12,
              },
            },
          ],
        },
      },
      { endpoint: ENDPOINT },
    );
    expect(drafts).toHaveLength(1);
    const draft = drafts[0]!;
    expect(draft.sourceUrl).toBeNull();
    expect(draft.externalId).toBe('t3_abc123');
  });

  it('builds sourceUrl only from the listing permalink and sets public_api provenance', () => {
    const permalink = '/r/homeimprovement/comments/abc123/leaky_faucet/';
    const drafts = listingToEvidenceDrafts(
      {
        kind: 'Listing',
        data: {
          children: [
            {
              kind: 't3',
              data: {
                id: 'abc123',
                name: 't3_abc123',
                permalink,
                title: 'Leaky faucet',
                selftext: 'The cheap washers fail after two weeks.',
                subreddit: 'homeimprovement',
                created_utc: 1_700_000_000,
                score: 42,
                num_comments: 8,
              },
            },
          ],
        },
      },
      { endpoint: ENDPOINT },
    );
    expect(drafts).toHaveLength(1);
    const draft = drafts[0]!;
    expect(draft.sourceUrl).toBe(`https://reddit.com${permalink}`);
    expect(draft.externalId).toBe('t3_abc123');
    expect(draft.sourceKind).toBe('reddit_post');
    expect(draft.provenance).toEqual({
      method: 'public_api',
      provider: 'reddit',
      endpoint: ENDPOINT,
    });
    expect(draft.excerpt).toBe('The cheap washers fail after two weeks.');
    expect(draft.compliance.excerptStoragePermitted).toBe(true);
  });

  it('does not fill excerpt when the listing has no selftext/body to store', () => {
    const drafts = listingToEvidenceDrafts(
      {
        kind: 'Listing',
        data: {
          children: [
            {
              kind: 't1',
              data: {
                id: 'xyz',
                name: 't1_xyz',
                permalink: '/r/foo/comments/abc/title/xyz',
                title: undefined,
                body: undefined,
              },
            },
          ],
        },
      },
      { endpoint: '/comments/abc' },
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.excerpt).toBeNull();
    expect(drafts[0]!.sourceKind).toBe('reddit_comment');
    expect(drafts[0]!.provenance.method).toBe('public_api');
    expect(drafts[0]!.summary.length).toBeGreaterThan(0);
  });
});
