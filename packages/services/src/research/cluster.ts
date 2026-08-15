/**
 * Deterministic pain-point clustering from already-collected evidence.
 *
 * Labels are taken from evidence that already has them, or from the source's
 * own summary text when grouping by domain + token overlap. This job never
 * invents a pain-point vocabulary an item did not carry.
 */

import type { EvidenceRow } from '@foundry/db';
import type { ServiceDeps } from '../deps.js';

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'after',
  'during',
  'from',
  'at',
  'by',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'this',
  'that',
  'as',
]);

export interface ClusterableEvidence {
  readonly id: string;
  readonly source_domain: string;
  readonly summary: string;
  readonly pain_point_labels: readonly string[];
  readonly category_labels: readonly string[];
}

export interface EvidenceCluster {
  readonly key: string;
  readonly label: string;
  readonly statement: string;
  readonly categoryLabels: readonly string[];
  readonly evidenceIds: readonly string[];
  /** Always false: labels are copied from evidence or from the source summary. */
  readonly painPointLabelsInvented: false;
}

export interface ClusterInput {
  readonly companyId: string;
  readonly sinceIso?: string;
  readonly minClusterSize?: number;
}

export interface ClusterResult {
  readonly clusters: number;
  readonly opportunitiesCreated: number;
}

const OVERLAP_THRESHOLD = 0.5;

export function tokenOverlap(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function clusterEvidence(
  items: readonly ClusterableEvidence[],
  minClusterSize: number,
): EvidenceCluster[] {
  const labeled = new Map<string, ClusterableEvidence[]>();
  const unlabeled: ClusterableEvidence[] = [];

  for (const item of items) {
    const first = firstLabel(item.pain_point_labels);
    if (first) {
      const group = labeled.get(first) ?? [];
      group.push(item);
      labeled.set(first, group);
    } else {
      unlabeled.push(item);
    }
  }

  const clusters: EvidenceCluster[] = [];

  for (const [label, group] of labeled) {
    if (group.length < minClusterSize) continue;
    clusters.push(toCluster(`label:${label}`, label, group[0]!.summary || label, group));
  }

  for (const group of groupByDomainOverlap(unlabeled)) {
    if (group.length < minClusterSize) continue;
    const seed = group[0]!;
    const statement = seed.summary.trim().slice(0, 80) || seed.source_domain;
    clusters.push(toCluster(`domain:${seed.source_domain}|${statement}`, statement, statement, group));
  }

  return clusters;
}

function groupByDomainOverlap(items: readonly ClusterableEvidence[]): ClusterableEvidence[][] {
  const remaining = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const groups: ClusterableEvidence[][] = [];

  while (remaining.length > 0) {
    const seed = remaining.shift()!;
    const group = [seed];
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      const candidate = remaining[i]!;
      if (candidate.source_domain !== seed.source_domain) continue;
      if (tokenOverlap(candidate.summary, seed.summary) < OVERLAP_THRESHOLD) continue;
      group.push(candidate);
      remaining.splice(i, 1);
    }
    groups.push(group);
  }

  return groups;
}

function toCluster(
  key: string,
  label: string,
  statement: string,
  group: readonly ClusterableEvidence[],
): EvidenceCluster {
  const categoryLabels = unique(group.flatMap((item) => item.category_labels.map(normalise).filter((v) => v.length > 0)));
  return {
    key,
    label: label.slice(0, 200),
    statement: statement.slice(0, 2000),
    categoryLabels,
    evidenceIds: unique(group.map((item) => item.id)),
    painPointLabelsInvented: false,
  };
}

function firstLabel(labels: readonly string[]): string | undefined {
  for (const label of labels) {
    const normalised = normalise(label);
    if (normalised.length > 0) return normalised;
  }
  return undefined;
}

function tokenize(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of value.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export class ResearchClusterService {
  constructor(private readonly deps: ServiceDeps) {}

  async cluster(input: ClusterInput): Promise<ClusterResult> {
    const minClusterSize = input.minClusterSize ?? 3;
    const since = input.sinceIso ? new Date(input.sinceIso) : undefined;
    const evidence = await this.deps.repos.research.evidence.search(input.companyId, {
      since,
      limit: 1000,
      minConfidence: 0.5,
    });

    const clusters = clusterEvidence(evidence.map(asClusterable), minClusterSize);
    const painPoints = [];

    for (const cluster of clusters) {
      const pain = await this.deps.repos.research.painPoints.upsert({
        companyId: input.companyId,
        label: cluster.label,
        statement: cluster.statement,
        segment: 'unspecified',
        categoryLabels: cluster.categoryLabels,
      });
      await this.deps.repos.research.painPoints.linkEvidence(pain.id, cluster.evidenceIds);
      const ranked = await this.deps.repos.research.painPoints.recomputeStats(pain.id);
      painPoints.push({ pain: ranked, evidenceIds: cluster.evidenceIds });

      await this.deps.repos.research.graph.upsertNode({
        companyId: input.companyId,
        kind: 'pain_point',
        label: ranked.label,
        refId: ranked.id,
      });
    }

    const existing = await this.deps.repos.research.opportunities.list(input.companyId);
    const claimed = new Set(existing.flatMap((row) => row.pain_point_ids));
    let opportunitiesCreated = 0;

    for (const { pain, evidenceIds } of painPoints) {
      if (pain.independent_source_count < 2) continue;
      if (claimed.has(pain.id)) continue;

      const category = pain.category_labels[0]?.trim() || 'unspecified';
      const opportunity = await this.deps.repos.research.opportunities.create({
        companyId: input.companyId,
        title: pain.label,
        concept: pain.statement,
        painPointIds: [pain.id],
        targetSegment: pain.segment,
        category,
        valueHypothesis: pain.statement,
      });
      claimed.add(pain.id);
      opportunitiesCreated += 1;

      const painNodeId = await this.deps.repos.research.graph.upsertNode({
        companyId: input.companyId,
        kind: 'pain_point',
        label: pain.label,
        refId: pain.id,
      });
      // graph_nodes.kind has no `opportunity` value; product_concept is the
      // opportunity's concept node and carries the opportunity id as ref.
      const opportunityNodeId = await this.deps.repos.research.graph.upsertNode({
        companyId: input.companyId,
        kind: 'product_concept',
        label: opportunity.title,
        refId: opportunity.id,
        attributes: { opportunityId: opportunity.id },
      });
      await this.deps.repos.research.graph.upsertEdge({
        companyId: input.companyId,
        kind: 'could_be_solved_by',
        fromNodeId: painNodeId,
        toNodeId: opportunityNodeId,
        evidenceIds,
      });
    }

    return { clusters: clusters.length, opportunitiesCreated };
  }
}

/** @deprecated Use ResearchClusterService. */
export { ResearchClusterService as PainPointClusteringService };

function asClusterable(row: EvidenceRow): ClusterableEvidence {
  return {
    id: row.id,
    source_domain: row.source_domain,
    summary: row.summary,
    pain_point_labels: row.pain_point_labels,
    category_labels: row.category_labels,
  };
}
