/**
 * Deterministic pain-point clustering from already-collected evidence.
 *
 * Two rules shape everything here:
 *
 * 1. **No invented vocabulary.** A cluster's label is built only from words
 *    that occur in the evidence itself, and its statement is a verbatim span of
 *    an evidence summary. Nothing is paraphrased, generated or inferred.
 * 2. **Independence is the point.** A cluster must be allowed to span domains,
 *    because `pain_points.independent_source_count` counts *distinct source
 *    domains* and the opportunity gate below requires at least two of them. An
 *    algorithm that groups only within one domain can never clear that gate —
 *    it produces pain points that are structurally ineligible to become
 *    opportunities.
 *
 * Grouping is star clustering over IDF-weighted term sets: each seed collects
 * the items that overlap it strongly enough, and every item lands in at most
 * one cluster, so `evidence_count` stays a true count of the linked rows.
 */

import type { EvidenceRow } from '@foundry/db';
import type { ServiceDeps } from '../deps.js';

/**
 * The confidence floor for evidence that may be clustered.
 *
 * The collector writes 0.7 (news), 0.6 (Reddit API), 0.5 (browser session) and
 * 0.4 (web-search snippet); `ResearchCollectService.refetch` and
 * `research.update_confidence` clamp an item to 0.3 when it could not be
 * re-established. So this floor means exactly "everything except what we have
 * explicitly marked unverifiable".
 *
 * It is deliberately *below* the 0.4 the search path writes. The previous value
 * (0.5) sat above it, which silently excluded every Brave-collected row from
 * clustering — the dominant source — and made zero clusters the only reachable
 * outcome no matter how much evidence was collected.
 */
export const CLUSTERABLE_EVIDENCE_MIN_CONFIDENCE = 0.35;

/**
 * Two items are about the same pain when either test passes.
 *
 * {@link SPECIFICITY_THRESHOLD} is the main one: the terms they share must
 * carry this fraction of the *rarer* item's total specificity, where each term
 * counts as idf². Squaring is what makes "lien waiver" bind and "management
 * software" not. Measured against the live corpus, 0.5 pulled unrelated trades
 * together and 0.65 keeps trade-specific vocabulary as the thing that binds.
 *
 * {@link RESTATEMENT_THRESHOLD} is the fallback, and deliberately ignores
 * corpus statistics: when a clear majority of the shorter item's words also
 * appear in the other, the two are near restatements of each other whatever the
 * document frequencies say. Without it, a corpus that is mostly *one* topic
 * clusters into nothing, because there the defining words look common.
 */
const SPECIFICITY_THRESHOLD = 0.65;
const RESTATEMENT_THRESHOLD = 0.6;

/** Two items must share at least this many terms; one shared word is a coincidence. */
const MIN_SHARED_TERMS = 2;

/** A restatement is only convincing with some substance behind it. */
const MIN_RESTATEMENT_TERMS = 3;

/** An item with fewer content terms than this carries too little text to compare. */
const MIN_TERMS_PER_ITEM = 3;

/** Longest statement we store; the tail is trimmed at a word boundary. */
const MAX_STATEMENT_CHARS = 240;

/** Words that carry no topic signal. Kept deliberately conservative: complaint
 * words ("problem", "struggle", "headache") are the signal, not noise. */
const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'anyone', 'are', 'around', 'as', 'at',
  'back', 'be', 'because', 'been', 'before', 'being', 'best', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'done', 'down', 'during',
  'each', 'even', 'ever', 'every', 'few', 'for', 'from', 'get', 'gets', 'getting', 'got',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'however',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'keep', 'know',
  'like', 'll', 'lot', 'made', 'make', 'makes', 'making', 'many', 'may', 'me', 'might', 'more', 'most',
  'much', 'must', 'my', 'never', 'new', 'no', 'nor', 'not', 'now',
  'of', 'off', 'on', 'once', 'one', 'only', 'or', 'other', 'others', 'our', 'ours', 'out', 'over', 'own',
  're', 'said', 'same', 'say', 'says', 'see', 'she', 'should', 'since', 'so', 'some', 'still', 'such',
  'take', 'than', 'that', 'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'thing',
  'things', 'this', 'those', 'though', 'through', 'to', 'too', 'two', 'up', 'us', 'use', 'used', 'uses',
  'using', 've', 'very', 'want', 'was', 'way', 'we', 'well', 'were', 'what', 'when', 'where', 'whether',
  'which', 'while', 'who', 'why', 'will', 'with', 'would', 'you', 'your', 'yours',
]);

/** Markers of a first-person complaint. Used only to *rank* real sentences. */
const PAIN_LANGUAGE =
  /\b(annoy\w*|awful|bad|broken?|challeng\w*|complain\w*|confus\w*|cost\w*|difficult\w*|disappoint\w*|error\w*|expensive|fail\w*|frustrat\w*|hard|hassle|hate|headache\w*|impossible|ineffic\w*|issue\w*|lack\w*|los\w*|manual\w*|mess\w*|miss\w*|nightmare|overwhelm\w*|pain\w*|poor|problem\w*|slow\w*|struggl\w*|stuck|tedious|terrible|time-consuming|tir\w*|too much|trouble\w*|unable|useless|waste\w*|worst|worry\w*|wrong)\b/i;

/** A summary that is only a link — browser-session rows store URL + title only. */
const BARE_URL = /^https?:\/\/\S+$/i;

/**
 * Search-engine placeholders. These are the *engine* saying it has no
 * description, not text the source published, so they carry no evidence. Left
 * in, they cluster with each other and produce a pain point that says nothing.
 */
const SEARCH_PLACEHOLDER =
  /^(we (cannot|can't) provide a description for this page( right now)?|no description( is)? available|description not available)\.?$/i;

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
  /** Distinct source domains behind this cluster — the independence measure. */
  readonly distinctDomains: number;
  /** Always false: every word of the label and statement occurs in the evidence. */
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
  /** Evidence rows read for this run, so a zero is explainable rather than mute. */
  readonly evidenceConsidered: number;
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&hellip;': '…',
};

/** Inline highlight tags a search engine wraps around matched words. */
const HIGHLIGHT_TAG = /<\/?(strong|b|em|i|mark|span)\b[^>]*>/gi;

/**
 * Evidence text as a human would read it.
 *
 * Search snippets arrive with `<strong>` highlighting and HTML entities, and
 * browser-session rows may hold only a URL. A URL's final path segment is the
 * publisher's own slug — words the source itself chose — so expanding it is a
 * transcription, not an invention. Nothing else is added.
 */
export function readableText(value: string): string {
  const raw = value.trim();
  if (BARE_URL.test(raw)) return slugWords(raw);

  // Highlight tags sit inside a word ("<strong>no</strong>-shows"), so they
  // close up; any other tag is a real break and becomes a space.
  let text = raw.replace(HIGHLIGHT_TAG, '').replace(/<[^>]+>/g, ' ');
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    text = text.split(entity).join(char);
  }
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(parseInt(hex, 16)));
  text = text.replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number(dec)));
  return text.replace(/\s+/g, ' ').trim();
}

function codePoint(value: number): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
}

function slugWords(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  // Reddit-style paths end with the post slug; trailing ids and short segments
  // carry no words, so walk back to the last segment that actually has some.
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const words = decodeURIComponent(segments[i]!)
      .replace(/[_+-]+/g, ' ')
      .replace(/[^A-Za-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (words.split(' ').filter((w) => w.length > 2).length >= 2) return words;
  }
  return parsed.hostname.replace(/^www\./, '');
}

/** Jaccard token overlap. Retained as the plain-text similarity utility. */
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

export function tokenize(value: string): Set<string> {
  return new Set(termsWithSurfaces(value).map((t) => t.term));
}

/**
 * Content terms with the words they were written as. The stem is what we
 * compare on; the surface is what a label may show, so a label never contains a
 * word that does not appear in the evidence.
 */
function termsWithSurfaces(value: string): Array<{ term: string; surface: string }> {
  const out: Array<{ term: string; surface: string }> = [];
  for (const raw of readableText(value).toLowerCase().split(/[^a-z0-9]+/)) {
    const term = stem(raw);
    if (term.length < 3 || STOPWORDS.has(term) || STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(term)) continue;
    out.push({ term, surface: raw });
  }
  return out;
}

/** The most common way the corpus writes this stem; ties resolve alphabetically. */
function displayTerm(term: string, surfaces: ReadonlyMap<string, ReadonlyMap<string, number>>): string {
  const counts = surfaces.get(term);
  if (!counts || counts.size === 0) return term;
  let best = term;
  let bestCount = -1;
  for (const [surface, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = surface;
      bestCount = count;
    }
  }
  return best;
}

/** Crude, deterministic plural folding so "issues" and "issue" are one term. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/* -------------------------------------------------------------------------- */
/* Clustering                                                                  */
/* -------------------------------------------------------------------------- */

interface Doc {
  readonly item: ClusterableEvidence;
  /** What the source published: the summary, cleaned. */
  readonly body: string;
  /** Page titles the collector recorded in `pain_point_labels`. */
  readonly title: string;
  readonly terms: ReadonlySet<string>;
  /** Σ idf over the doc's terms: how much the item says, used only for ordering. */
  weight: number;
}

/**
 * Groups evidence into pain-point clusters.
 *
 * {@link aboutTheSameThing} decides which items are linked and
 * {@link starCluster} groups them. Both measures normalise by the *smaller*
 * item, so a six-word forum title can join a thirty-word article snippet about
 * the same complaint — which is precisely the cross-domain pairing that makes a
 * cluster independent.
 */
export function clusterEvidence(
  items: readonly ClusterableEvidence[],
  minClusterSize: number,
): EvidenceCluster[] {
  const docs: Doc[] = [];
  const surfaces = new Map<string, Map<string, number>>();

  for (const item of items) {
    const body = readableText(item.summary);
    if (SEARCH_PLACEHOLDER.test(body)) continue;
    const title = readableText(item.pain_point_labels.filter((s) => s.trim().length > 0).join('. '));
    const analysed = termsWithSurfaces(`${body} ${title}`);
    const terms = new Set(analysed.map((t) => t.term));
    if (terms.size < MIN_TERMS_PER_ITEM) continue;
    for (const { term, surface } of analysed) {
      const counts = surfaces.get(term) ?? new Map<string, number>();
      counts.set(surface, (counts.get(surface) ?? 0) + 1);
      surfaces.set(term, counts);
    }
    docs.push({ item, body, title, terms, weight: 0 });
  }
  if (docs.length === 0) return [];

  const idf = inverseDocumentFrequency(docs);
  for (const doc of docs) {
    doc.weight = weightOf(doc.terms, idf);
  }

  // Deterministic order: densest first, ties broken by id.
  const ranked = [...docs].sort((a, b) => b.weight - a.weight || a.item.id.localeCompare(b.item.id));
  const groups = starCluster(ranked, idf, minClusterSize);

  const clusters: EvidenceCluster[] = [];
  const usedLabels = new Set<string>();

  for (const group of groups) {
    const ordered = [...group].sort((a, b) => a.item.id.localeCompare(b.item.id));
    const keyTerms = clusterKeyTerms(ordered, idf);
    const label = uniqueLabel(keyTerms, usedLabels, ordered, surfaces);
    usedLabels.add(label);
    clusters.push({
      key: `terms:${label}`,
      label,
      statement: pickStatement(ordered, keyTerms),
      categoryLabels: unique(
        ordered.flatMap((doc) => doc.item.category_labels.map(normalise).filter((v) => v.length > 0)),
      ),
      evidenceIds: unique(ordered.map((doc) => doc.item.id)),
      distinctDomains: new Set(ordered.map((doc) => doc.item.source_domain)).size,
      painPointLabelsInvented: false,
    });
  }

  return clusters.sort((a, b) => b.evidenceIds.length - a.evidenceIds.length || a.key.localeCompare(b.key));
}

/**
 * Star clustering: repeatedly take the item with the most similar neighbours
 * still unassigned and make it the centre of a cluster.
 *
 * Choosing the *centre* rather than the first or densest item matters. A long
 * article shares only a small fraction of its vocabulary with any one forum
 * post, so seeding by length lets a peripheral item claim two neighbours,
 * dissolve for being under `minClusterSize`, and take the cluster's real
 * members down with it. The highest-degree item is by construction the most
 * typical one, and because its star is the largest available, a star that is
 * still too small proves every remaining star is too small — so the loop can
 * stop there rather than shredding what is left.
 */
function starCluster(
  docs: readonly Doc[],
  idf: ReadonlyMap<string, number>,
  minClusterSize: number,
): Doc[][] {
  const adjacency = docs.map(() => new Set<number>());
  for (let i = 0; i < docs.length; i += 1) {
    for (let j = i + 1; j < docs.length; j += 1) {
      if (!aboutTheSameThing(docs[i]!, docs[j]!, idf)) continue;
      adjacency[i]!.add(j);
      adjacency[j]!.add(i);
    }
  }

  const assigned = new Array<boolean>(docs.length).fill(false);
  const groups: Doc[][] = [];

  for (;;) {
    let centre = -1;
    let largest = 0;
    for (let i = 0; i < docs.length; i += 1) {
      if (assigned[i]) continue;
      let size = 1;
      for (const j of adjacency[i]!) {
        if (!assigned[j]) size += 1;
      }
      if (size > largest) {
        largest = size;
        centre = i;
      }
    }
    if (centre < 0 || largest < minClusterSize) break;

    const members = [centre, ...[...adjacency[centre]!].filter((j) => !assigned[j])].sort((a, b) => a - b);
    for (const index of members) assigned[index] = true;
    groups.push(members.map((index) => docs[index]!));
  }

  return groups;
}

function inverseDocumentFrequency(docs: readonly Doc[]): ReadonlyMap<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.terms) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log(1 + docs.length / count));
  }
  return idf;
}

/** Σ idf² — how much *specific* meaning a set of terms carries. */
function weightOf(terms: Iterable<string>, idf: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const term of terms) {
    const weight = idf.get(term) ?? 0;
    total += weight * weight;
  }
  return total;
}

/** See {@link SPECIFICITY_THRESHOLD} and {@link RESTATEMENT_THRESHOLD}. */
function aboutTheSameThing(a: Doc, b: Doc, idf: ReadonlyMap<string, number>): boolean {
  const shared = sharedTerms(a.terms, b.terms);
  if (shared.length < MIN_SHARED_TERMS) return false;

  const specificity = weightOf(shared, idf) / Math.min(a.weight, b.weight);
  if (specificity >= SPECIFICITY_THRESHOLD) return true;

  const restatement = shared.length / Math.min(a.terms.size, b.terms.size);
  return shared.length >= MIN_RESTATEMENT_TERMS && restatement >= RESTATEMENT_THRESHOLD;
}

function sharedTerms(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const shared: string[] = [];
  for (const term of small) {
    if (large.has(term)) shared.push(term);
  }
  return shared.sort();
}

/**
 * The terms that actually characterise the cluster: those most of its members
 * share, most distinctive first. Every one of them is a word from the evidence.
 */
function clusterKeyTerms(group: readonly Doc[], idf: ReadonlyMap<string, number>): string[] {
  const counts = new Map<string, number>();
  for (const doc of group) {
    for (const term of doc.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort(
      (a, b) =>
        b[1] - a[1] ||
        (idf.get(b[0]) ?? 0) - (idf.get(a[0]) ?? 0) ||
        a[0].localeCompare(b[0]),
    );
  const majority = Math.max(2, Math.ceil(group.length / 2));
  const shared = ranked.filter(([, count]) => count >= majority);
  return (shared.length > 0 ? shared : ranked).slice(0, 5).map(([term]) => term);
}

function uniqueLabel(
  keyTerms: readonly string[],
  used: ReadonlySet<string>,
  group: readonly Doc[],
  surfaces: ReadonlyMap<string, ReadonlyMap<string, number>>,
): string {
  const base = keyTerms.map((term) => displayTerm(term, surfaces)).join(' ').trim();
  if (base.length > 0 && !used.has(base)) return base;
  // Distinguish with the next term the group carries rather than a counter, so
  // the label still describes the cluster.
  for (const doc of group) {
    for (const term of [...doc.terms].sort()) {
      const candidate = `${base} ${displayTerm(term, surfaces)}`.trim();
      if (candidate !== base && !used.has(candidate)) return candidate;
    }
  }
  return `${base} ${group[0]!.item.id}`.trim();
}

/**
 * A real sentence from the evidence, chosen for being an actual statement of a
 * pain: text the source published is preferred over a page title, then
 * complaint language, then coverage of the cluster's own key terms. Never a
 * bare URL, never synthesised.
 */
function pickStatement(group: readonly Doc[], keyTerms: readonly string[]): string {
  let best = '';
  let bestScore = -Infinity;

  for (const doc of group) {
    const candidates = [
      ...sentences(doc.body).map((sentence) => ({ sentence, published: true })),
      ...sentences(doc.title).map((sentence) => ({ sentence, published: false })),
    ];
    for (const { sentence, published } of candidates) {
      const lower = sentence.toLowerCase();
      const hits = keyTerms.filter((term) => lower.includes(term.slice(0, Math.max(4, term.length - 1)))).length;
      const score =
        hits * 2 +
        (published ? 3 : 0) +
        // A sentence that names the pain beats a sentence that merely shares
        // the cluster's vocabulary, which is usually a vendor's own pitch.
        (PAIN_LANGUAGE.test(sentence) ? 6 : 0) +
        (sentence.length >= 60 && sentence.length <= MAX_STATEMENT_CHARS ? 2 : 0) -
        (sentence.length < 25 ? 3 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = sentence;
      }
    }
  }

  if (best.length === 0) best = group[0]!.body || group[0]!.title;
  return truncateAtWord(dropDanglingWord(best.replace(/\s+/g, ' ').trim()), MAX_STATEMENT_CHARS);
}

function sentences(text: string): string[] {
  return text
    // Brave snippets join fragments with " ... " or " · "; titles append " | Site".
    .split(/(?<=[.!?])\s+|\s+\.\.\.\s+|\s+\|\s+|\s+·\s+|\n+/)
    .map((s) => s.replace(/^[\s.…·|—-]+/, '').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0 && !BARE_URL.test(s) && !SEARCH_PLACEHOLDER.test(s));
}

/**
 * Evidence text arrives pre-truncated — URL slugs stop wherever the publisher
 * cut them, and the collector stores page titles clipped to a fixed width — so
 * a quote can end on a stub or a dangling preposition. Trimming the tail keeps
 * the quote verbatim; it only stops mid-word.
 */
function dropDanglingWord(value: string): string {
  const text = /[.!?"')\]]$/.test(value.trim()) ? value.trim() : value.trim().replace(/\s+[A-Za-z]{1,2}$/, '');
  return text.replace(/\s+(and|or|but|with|for|to|the|a|an|of|in|on|that|is|are|my|your)$/i, '').trim();
}

function truncateAtWord(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

export class ResearchClusterService {
  constructor(private readonly deps: ServiceDeps) {}

  async cluster(input: ClusterInput): Promise<ClusterResult> {
    const minClusterSize = input.minClusterSize ?? 3;
    const since = input.sinceIso ? new Date(input.sinceIso) : undefined;
    const evidence = await this.deps.repos.research.evidence.search(input.companyId, {
      since,
      limit: 1000,
      minConfidence: CLUSTERABLE_EVIDENCE_MIN_CONFIDENCE,
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

    return { clusters: clusters.length, opportunitiesCreated, evidenceConsidered: evidence.length };
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
