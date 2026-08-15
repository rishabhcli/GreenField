/**
 * Clustering is deterministic and must not invent pain-point labels.
 *
 * A production change that would make these fail: grouping unlabeled evidence
 * under a fabricated label, or merging summaries with token overlap below 0.5.
 */

import { describe, expect, it } from 'vitest';
import { clusterEvidence, tokenOverlap, type ClusterableEvidence } from '../src/research/cluster.js';

function item(overrides: Partial<ClusterableEvidence> & Pick<ClusterableEvidence, 'id'>): ClusterableEvidence {
  return {
    source_domain: 'example.com',
    summary: 'the product broke after two weeks of daily use',
    pain_point_labels: [],
    category_labels: [],
    ...overrides,
  };
}

describe('tokenOverlap', () => {
  it('returns 1 for identical token sets and 0 for disjoint sets', () => {
    expect(tokenOverlap('leaking bottle cap', 'leaking bottle cap')).toBe(1);
    expect(tokenOverlap('leaking bottle cap', 'unrelated shipping delay')).toBe(0);
  });

  it('is at least 0.5 when most tokens are shared', () => {
    expect(tokenOverlap('leaking bottle cap fails', 'leaking bottle cap')).toBeGreaterThanOrEqual(0.5);
  });
});

describe('clusterEvidence', () => {
  it('groups by the first pain_point_labels entry when present', () => {
    const clusters = clusterEvidence(
      [
        item({
          id: 'e1',
          pain_point_labels: ['leaking cap', 'other'],
          summary: 'cap leaks on the first squeeze',
        }),
        item({
          id: 'e2',
          pain_point_labels: ['leaking cap'],
          summary: 'the cap leaked in my bag',
        }),
        item({
          id: 'e3',
          source_domain: 'other.com',
          pain_point_labels: ['too expensive'],
          summary: 'price is too high for the quality',
        }),
      ],
      2,
    );

    const leaking = clusters.find((c) => c.label === 'leaking cap');
    expect(leaking?.evidenceIds).toEqual(['e1', 'e2']);
    expect(clusters.some((c) => c.label === 'too expensive')).toBe(false);
  });

  it('does not invent a pain-point label for unlabeled items', () => {
    const clusters = clusterEvidence(
      [
        item({
          id: 'e1',
          source_domain: 'reddit.com',
          summary: 'handle snaps off after a month of normal use',
          pain_point_labels: [],
        }),
        item({
          id: 'e2',
          source_domain: 'reddit.com',
          summary: 'handle snaps off during ordinary kitchen use',
          pain_point_labels: [],
        }),
      ],
      2,
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.painPointLabelsInvented).toBe(false);
    expect(clusters[0]!.label).not.toMatch(/unspecified|unknown|generated|cluster/i);
    expect(clusters[0]!.evidenceIds).toEqual(['e1', 'e2']);
  });

  it('does not merge unlabeled items on different domains or with overlap below 0.5', () => {
    const clusters = clusterEvidence(
      [
        item({
          id: 'e1',
          source_domain: 'reddit.com',
          summary: 'handle snaps off after a month',
          pain_point_labels: [],
        }),
        item({
          id: 'e2',
          source_domain: 'news.example',
          summary: 'handle snaps off after a month',
          pain_point_labels: [],
        }),
        item({
          id: 'e3',
          source_domain: 'reddit.com',
          summary: 'shipping took six weeks and arrived damaged',
          pain_point_labels: [],
        }),
      ],
      2,
    );

    expect(clusters).toEqual([]);
  });

  it('drops groups smaller than minClusterSize', () => {
    const clusters = clusterEvidence(
      [
        item({ id: 'e1', pain_point_labels: ['leaking cap'] }),
        item({ id: 'e2', pain_point_labels: ['leaking cap'] }),
      ],
      3,
    );
    expect(clusters).toEqual([]);
  });
});
