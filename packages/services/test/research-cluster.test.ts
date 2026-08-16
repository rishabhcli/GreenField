/**
 * Clustering must turn real collected evidence into real pain points.
 *
 * These fixtures are shaped like the rows the collector actually writes: Brave
 * snippets carrying `<strong>` highlighting and HTML entities, page titles
 * parked in `pain_point_labels`, and browser-session rows whose whole summary
 * is a URL. The production failure these tests pin is the one that happened —
 * hundreds of collected rows producing `{"clusters":0}` forever, because the
 * read filter sat above the confidence the collector writes and because
 * grouping required two items to share a domain, which is the opposite of what
 * `independent_source_count` measures.
 *
 * A production change that would make these fail: raising the read floor back
 * above 0.4, requiring domain equality again, or promoting a URL or an invented
 * phrase into a pain point's statement.
 */

import { describe, expect, it } from 'vitest';
import type { ServiceDeps } from '../src/deps.js';
import {
  CLUSTERABLE_EVIDENCE_MIN_CONFIDENCE,
  ResearchClusterService,
  clusterEvidence,
  readableText,
  tokenOverlap,
  type ClusterableEvidence,
} from '../src/research/cluster.js';

const COMPANY = 'co_01M03F7RQW2M6540BY2GZHCFBW';

function item(overrides: Partial<ClusterableEvidence> & Pick<ClusterableEvidence, 'id'>): ClusterableEvidence {
  return {
    source_domain: 'example.com',
    summary: 'the product broke after two weeks of daily use',
    pain_point_labels: [],
    category_labels: [],
    ...overrides,
  };
}

/**
 * Six independently sourced items about one pain, in the exact shapes the
 * collector produces, plus three unrelated items.
 */
function collectedEvidence(): ClusterableEvidence[] {
  return [
    item({
      id: 'evd_01',
      source_domain: 'withmoxie.com',
      summary:
        '<strong>Late payments</strong> cost freelancers and small agencies nearly a third of their income every year. ' +
        'If you find out they&#x27;re having cash flow problems, you can then agree on a way for them to pay off the outstanding invoice.',
      pain_point_labels: ['How to Handle Late Payments and Difficult Clients as a Freelancer'],
    }),
    item({
      id: 'evd_02',
      source_domain: 'reddit.com',
      summary: 'https://www.reddit.com/r/freelance/comments/y8y7of/client_is_always_late_with_recurring_payments/',
    }),
    item({
      id: 'evd_03',
      source_domain: 'reddit.com',
      summary:
        'I&#x27;m new to freelancing, and I manage my payment statuses in an Excel spreadsheet, which is really frustrating. ' +
        'Chasing late invoices eats my week. : r/freelance',
    }),
    item({
      id: 'evd_04',
      source_domain: 'and.co',
      summary:
        'Chasing invoices is the part of freelance work nobody budgets for ... Late payments from clients force freelancers to spend billable hours on collections.',
      pain_point_labels: ['Freelancer Invoice Chasing: Get Paid Without the Stress'],
    }),
    item({
      id: 'evd_05',
      source_domain: 'bonsai.dev',
      summary: 'Late invoice payments and slow-paying clients are the top cash flow problem freelancers report.',
      pain_point_labels: ['Late Invoice Payments: What Freelancers Can Do'],
    }),
    item({
      id: 'evd_06',
      source_domain: 'freelanceunion.org',
      summary: 'Nearly three quarters of freelancers report chasing late payments from clients at least once a year.',
      pain_point_labels: ['Late Payments Are a Freelance Business Problem'],
    }),

    // Different subject entirely — must not be pulled into the payments cluster.
    item({
      id: 'evd_90',
      source_domain: 'snapfix.com',
      summary:
        'Tenant repair issues reported via calls, emails, or texts get lost, resulting in slow responses and repeated complaints.',
      pain_point_labels: ['Property Management Maintenance Software'],
    }),
    item({
      id: 'evd_91',
      source_domain: 'proptechos.com',
      summary: 'Work order management for property teams: eight steps to fewer missed repairs.',
    }),
    item({
      id: 'evd_92',
      source_domain: 'oxmaint.com',
      summary: 'Preventive maintenance scheduling reduces emergency callouts across a building portfolio.',
    }),
  ];
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

describe('readableText', () => {
  it('strips search-engine highlighting without gluing words together', () => {
    expect(readableText('reduce <strong>no</strong>-<strong>shows</strong> in clinics')).toBe(
      'reduce no-shows in clinics',
    );
  });

  it('decodes the entities Brave actually returns', () => {
    expect(readableText('I&#x27;ll chase the &quot;overdue&quot; invoice &amp; wait')).toBe(
      'I\'ll chase the "overdue" invoice & wait',
    );
  });

  it('reads a bare URL as the slug the publisher wrote, not as a URL', () => {
    const text = readableText('https://www.reddit.com/r/freelance/comments/y8y7of/client_is_always_late_with_recurring_payments/');
    expect(text).toBe('client is always late with recurring payments');
    expect(text).not.toMatch(/^https?:/);
  });
});

describe('clusterEvidence over realistically collected evidence', () => {
  it('produces clusters instead of zero', () => {
    const clusters = clusterEvidence(collectedEvidence(), 3);
    expect(clusters.length).toBeGreaterThan(0);
  });

  it('clusters the same pain across independent domains', () => {
    const clusters = clusterEvidence(collectedEvidence(), 3);
    const payments = clusters.find((c) => c.evidenceIds.includes('evd_01'));

    expect(payments).toBeDefined();
    expect(payments!.evidenceIds.length).toBeGreaterThanOrEqual(3);
    // The whole point of the measure: a cluster must be able to span domains,
    // otherwise independent_source_count is structurally 1 and the opportunity
    // gate can never be cleared.
    expect(payments!.distinctDomains).toBeGreaterThanOrEqual(2);
    // Unrelated subject matter stays out.
    expect(payments!.evidenceIds).not.toContain('evd_90');
    expect(payments!.evidenceIds).not.toContain('evd_92');
  });

  it('states the pain in words the evidence used, and never as a URL', () => {
    const clusters = clusterEvidence(collectedEvidence(), 3);
    const payments = clusters.find((c) => c.evidenceIds.includes('evd_01'))!;

    expect(payments.statement).not.toMatch(/^https?:\/\//);
    expect(payments.statement).not.toMatch(/<[a-z]+>|&#x?\d|&quot;/i);
    expect(payments.statement.length).toBeGreaterThan(20);
    expect(payments.statement.toLowerCase()).toMatch(/late|invoice|payment/);

    // Every word of the label occurs in the evidence: nothing is invented.
    const corpus = collectedEvidence()
      .map((e) => readableText(`${e.summary} ${e.pain_point_labels.join(' ')}`).toLowerCase())
      .join(' ');
    for (const word of payments.label.split(' ')) {
      expect(corpus).toContain(word);
    }
    expect(payments.label).not.toMatch(/^https?:\/\//);
    expect(payments.label).not.toMatch(/unspecified|unknown|generated|cluster/i);
    expect(payments.painPointLabelsInvented).toBe(false);
  });

  it('reports each item once, so evidence_count is a true count', () => {
    const clusters = clusterEvidence(collectedEvidence(), 3);
    const all = clusters.flatMap((c) => c.evidenceIds);
    expect(new Set(all).size).toBe(all.length);
  });

  it('is deterministic', () => {
    const first = clusterEvidence(collectedEvidence(), 3);
    const second = clusterEvidence(collectedEvidence(), 3);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('drops groups smaller than minClusterSize', () => {
    const clusters = clusterEvidence(collectedEvidence(), 25);
    expect(clusters).toEqual([]);
  });

  it('never clusters search-engine placeholders, which carry no evidence', () => {
    const placeholders = ['facebook.com', 'reddit.com', 'x.com', 'instagram.com'].map((domain, index) =>
      item({
        id: `evd_ph${index}`,
        source_domain: domain,
        summary: 'We cannot provide a description for this page right now',
      }),
    );
    expect(clusterEvidence(placeholders, 3)).toEqual([]);
  });

  it('does not invent a pain-point label for unlabeled items', () => {
    const clusters = clusterEvidence(
      [
        item({ id: 'e1', source_domain: 'reddit.com', summary: 'handle snaps off after a month of normal kitchen use' }),
        item({ id: 'e2', source_domain: 'forums.example', summary: 'handle snaps off during ordinary kitchen use' }),
        item({ id: 'e3', source_domain: 'reviews.example', summary: 'the handle snapped off after a month of kitchen use' }),
      ],
      3,
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.painPointLabelsInvented).toBe(false);
    expect(clusters[0]!.label).not.toMatch(/unspecified|unknown|generated|cluster/i);
    expect(clusters[0]!.evidenceIds).toEqual(['e1', 'e2', 'e3']);
    expect(clusters[0]!.distinctDomains).toBe(3);
  });

  it('does not merge items that share no subject matter', () => {
    const clusters = clusterEvidence(
      [
        item({ id: 'e1', source_domain: 'reddit.com', summary: 'handle snaps off after a month' }),
        item({ id: 'e2', source_domain: 'news.example', summary: 'shipping took six weeks and arrived damaged' }),
        item({ id: 'e3', source_domain: 'blog.example', summary: 'the checkout page rejects European postcodes' }),
      ],
      2,
    );
    expect(clusters).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

interface SearchCall {
  companyId: string;
  options: { minConfidence?: number; limit?: number; since?: Date };
}

function serviceDeps(
  evidence: readonly ClusterableEvidence[],
  recorded: { searches: SearchCall[]; pains: unknown[]; opportunities: unknown[] },
): ServiceDeps {
  const linked = new Map<string, string[]>();
  const domainOf = new Map(evidence.map((e) => [e.id, e.source_domain]));
  let nextPain = 0;

  return {
    repos: {
      research: {
        evidence: {
          search: async (companyId: string, options: SearchCall['options']) => {
            recorded.searches.push({ companyId, options });
            return evidence;
          },
        },
        painPoints: {
          upsert: async (input: { label: string; statement: string; segment: string }) => {
            nextPain += 1;
            const row = { id: `pain_${nextPain}`, ...input, category_labels: [] as string[] };
            recorded.pains.push(row);
            return row;
          },
          linkEvidence: async (painPointId: string, ids: readonly string[]) => {
            linked.set(painPointId, [...ids]);
            return ids.length;
          },
          // Mirrors the real SQL: distinct source domains, not row count.
          recomputeStats: async (painPointId: string) => {
            const ids = linked.get(painPointId) ?? [];
            const pain = recorded.pains.find((p) => (p as { id: string }).id === painPointId) as Record<string, unknown>;
            return {
              ...pain,
              evidence_count: ids.length,
              independent_source_count: new Set(ids.map((id) => domainOf.get(id))).size,
              category_labels: [],
            };
          },
        },
        graph: {
          upsertNode: async () => 'node_1',
          upsertEdge: async () => 'edge_1',
        },
        opportunities: {
          list: async () => [],
          create: async (input: { title: string; concept: string }) => {
            recorded.opportunities.push(input);
            return { id: `opp_${recorded.opportunities.length}`, title: input.title };
          },
        },
      },
    },
  } as unknown as ServiceDeps;
}

describe('ResearchClusterService', () => {
  it('reads evidence at a floor the collector can actually clear', async () => {
    const recorded = { searches: [] as SearchCall[], pains: [] as unknown[], opportunities: [] as unknown[] };
    const service = new ResearchClusterService(serviceDeps(collectedEvidence(), recorded));
    await service.cluster({ companyId: COMPANY, minClusterSize: 3 });

    // The collector writes 0.4 for a web-search snippet — its dominant output.
    // A floor above that silently discards every one of them.
    expect(recorded.searches).toHaveLength(1);
    expect(recorded.searches[0]!.options.minConfidence).toBeLessThanOrEqual(0.4);
    // ...but `refetch` clamps unverifiable evidence to 0.3, which must stay out.
    expect(CLUSTERABLE_EVIDENCE_MIN_CONFIDENCE).toBeGreaterThan(0.3);
    expect(CLUSTERABLE_EVIDENCE_MIN_CONFIDENCE).toBeLessThanOrEqual(0.4);
  });

  it('writes pain points with a real statement and reports what it considered', async () => {
    const recorded = { searches: [] as SearchCall[], pains: [] as unknown[], opportunities: [] as unknown[] };
    const evidence = collectedEvidence();
    const service = new ResearchClusterService(serviceDeps(evidence, recorded));

    const result = await service.cluster({ companyId: COMPANY, minClusterSize: 3 });

    expect(result.clusters).toBeGreaterThan(0);
    expect(result.evidenceConsidered).toBe(evidence.length);
    expect(recorded.pains.length).toBe(result.clusters);
    for (const pain of recorded.pains as Array<{ label: string; statement: string }>) {
      expect(pain.statement).not.toMatch(/^https?:\/\//);
      expect(pain.label).not.toMatch(/^https?:\/\//);
      expect(pain.statement.trim().length).toBeGreaterThan(20);
    }
  });

  it('creates an opportunity once a pain point has two independent sources', async () => {
    const recorded = { searches: [] as SearchCall[], pains: [] as unknown[], opportunities: [] as unknown[] };
    const service = new ResearchClusterService(serviceDeps(collectedEvidence(), recorded));

    const result = await service.cluster({ companyId: COMPANY, minClusterSize: 3 });

    expect(result.opportunitiesCreated).toBeGreaterThan(0);
    expect(recorded.opportunities.length).toBe(result.opportunitiesCreated);
  });

  it('creates no opportunity when every supporting item comes from one domain', async () => {
    const recorded = { searches: [] as SearchCall[], pains: [] as unknown[], opportunities: [] as unknown[] };
    const oneDomain = collectedEvidence().map((e) => ({ ...e, source_domain: 'reddit.com' }));
    const service = new ResearchClusterService(serviceDeps(oneDomain, recorded));

    const result = await service.cluster({ companyId: COMPANY, minClusterSize: 3 });

    expect(result.clusters).toBeGreaterThan(0);
    expect(result.opportunitiesCreated).toBe(0);
  });
});
