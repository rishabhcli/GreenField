/**
 * The operating loop.
 *
 * This is what makes the system a company rather than a pipeline. A cron tick
 * calls `tick()`; it reads the current cycle, decides whether the current phase
 * is finished, and either advances or reports precisely what the phase is
 * waiting on. Nothing here does the work itself — every phase enqueues jobs and
 * dispatches agent runs, so a restarted worker resumes from the database rather
 * than from memory.
 *
 * Three properties matter most:
 *
 *  1. **A phase only completes on evidence.** "Discover" is not done because an
 *     agent was dispatched; it is done because opportunity rows with cited
 *     evidence exist. Every `isPhaseComplete` branch queries for the artefact
 *     the phase was supposed to produce.
 *  2. **Blocked is a first-class outcome, and a reversible one.** When a phase
 *     cannot proceed because a capability is unavailable, the cycle records
 *     `blocked` with the capability name and remediation. It does not skip
 *     ahead, and it does not pretend the phase succeeded. Equally, `blocked` is
 *     a claim about *now*: the next tick re-derives it from the live capability
 *     registry, and an assessment that no longer blocks retracts the stored
 *     block. A credential arriving is the expected case, not an exception, so a
 *     stale `blocked_reason` must never be able to pin the company.
 *  3. **One tick at a time, per company.** Assessment and advancement are a
 *     read-then-write pair with no protection of their own, so two overlapping
 *     ticks would each read the same phase, each conclude it was complete, and
 *     each advance — skipping a phase outright and spending money twice on the
 *     way. `tick` therefore runs under a per-company advisory lock. See the
 *     comment on `tick` for what specifically goes wrong without it.
 */

import {
  LOOP_PHASE_ORDER,
  DEFAULT_SELECTION_GATES,
  ValidationError,
  productLineOf,
  type Capability,
  type LoopPhase,
  type ProductLine,
} from '@foundry/core';
import { companyConfig, tryAdvisoryLock } from '@foundry/db';
import { getLogger } from '@foundry/obs';
import type { ServiceDeps } from '../deps.js';
import { TERAC_STUDY_BLOCKER } from '../org/prize-tracks.js';
import { ExpertReviewService } from '../research/expert.js';
import { LandedCostService } from '../sourcing/economics.js';

export interface TickOptions {
  /** Operator-forced phase. Applied under the same advisory lock as the rest of the tick. */
  readonly forcePhase?: string | null;
}

export interface TickResult {
  readonly cycleId: string;
  readonly cycleNumber: number;
  readonly phase: LoopPhase;
  /**
   * What this tick did.
   *
   * `skipped_locked` is deliberately distinct from both `waiting` and
   * `blocked`, and neither of those was reused:
   *
   *   - `blocked` means a *capability* is unavailable and the cycle has been
   *     written to the `blocked` state with a remediation. Lock contention is
   *     not a capability problem and must never be reported as one, or the
   *     loop's blocked reporting stops meaning "something needs a credential".
   *   - `waiting` means the phase was assessed and found incomplete with no new
   *     work to start. A tick that lost the lock never assessed anything, so
   *     claiming the phase is "waiting" would assert a conclusion it did not
   *     reach — the one thing this codebase is built not to do.
   *
   * `skipped_locked` says exactly what happened: another tick owns this
   * company right now, and this one did nothing at all.
   */
  readonly action: 'advanced' | 'waiting' | 'blocked' | 'started_work' | 'cycle_completed' | 'skipped_locked';
  readonly detail: string;
  readonly blockedOnCapability?: Capability;
  readonly nextPhase?: LoopPhase;
}

/**
 * Advisory-lock key for one company's tick.
 *
 * Keyed on the company, not on the loop as a whole: the thing that must not
 * overlap is two ticks of the *same* cycle. Two companies advancing their own
 * cycles at the same moment is normal and must stay parallel, so a global lock
 * would be a correctness fix that quietly becomes a scaling ceiling.
 *
 * The `foundry:loop:tick:` prefix keeps this in a different part of the hashed
 * key space from the other advisory locks in the system (`foundry:migrations`),
 * which share one 64-bit namespace because Postgres advisory locks are global
 * to the database.
 */
function tickLockKey(companyId: string): string {
  return `foundry:loop:tick:${companyId}`;
}

/** Site statuses that prove a storefront was actually generated — spec_drafted is not enough. */
const BUILD_EVIDENCE_STATUSES = new Set([
  'generated',
  'preview_deployed',
  'qa_passed',
  'production_deployed',
]);

const BUILD_NOT_YET_GENERATED = new Set(['spec_drafted', 'generating', 'building', 'build_failed']);

/**
 * How long `expert_validate` waits for Terac to price a feasibility request
 * before the cycle proceeds without expert validation. This guards a quality
 * gate, not a money path: nothing has been spent on an unpriced study, no
 * verdict is fabricated by moving on, and the review rows are left open so the
 * 15-minute `expert.poll` cron can still complete them whenever Terac answers.
 */
const EXPERT_PRICING_DEADLINE_MS = 60 * 60 * 1000;

/** Review statuses proving a live Terac study: launched or already collecting submissions. */
const ENGAGED_REVIEW_STATUSES = new Set(['launched', 'in_progress', 'submissions_received']);

/**
 * Whether an open expert review can still complete `expert_validate` on its
 * own. `priced` cannot — it is a live Terac response proving the study is
 * unfunded (see `TERAC_STUDY_BLOCKER`) — and an unengaged request older than
 * the pricing deadline has shown no evidence Terac will ever answer. A review
 * with no readable request timestamp counts as still progressing, because its
 * staleness cannot be proven.
 */
function reviewCanStillProgress(
  review: { readonly status: string; readonly requested_at?: Date | null; readonly created_at?: Date | null },
  nowMs: number,
): boolean {
  if (review.status === 'priced') return false;
  if (ENGAGED_REVIEW_STATUSES.has(review.status)) return true;
  const requestedAt = review.requested_at ?? review.created_at;
  if (!requestedAt) return true;
  return nowMs - requestedAt.getTime() < EXPERT_PRICING_DEADLINE_MS;
}

function parseForcePhase(raw: string): LoopPhase {
  if ((LOOP_PHASE_ORDER as readonly string[]).includes(raw)) {
    return raw as LoopPhase;
  }
  throw new ValidationError(`forcePhase must be one of ${LOOP_PHASE_ORDER.join(' | ')}, got "${raw}"`, {
    forcePhase: raw,
  });
}

/** What a phase must be able to show before the loop moves past it. */
interface PhaseAssessment {
  readonly complete: boolean;
  readonly detail: string;
  readonly blockedOn?: { capability: Capability; remediation: string };
  /** Outputs recorded on the cycle when the phase completes. */
  readonly outputs?: Record<string, unknown>;
}

export class LoopOrchestrator {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * One tick of the loop.
   *
   * Deliberately does a small amount of work and returns. The schedule, not a
   * long-running process, is what keeps the company moving — a wedged tick
   * costs one interval, not the whole operation.
   *
   * ## Why this is behind a lock
   *
   * `tick` reads the current phase, decides whether it is complete, and then
   * writes that decision by advancing the cycle. Nothing in that read-then-write
   * pair is atomic, and there is more than one thing in the deployment that can
   * call it: the repeatable `loop.tick` job, an operator hitting
   * `POST /api/companies/:id/loop/tick`, and the `tickCompanyLoop` Render
   * Workflows task. Two of those overlapping produces a specific, silent
   * corruption rather than a visible error:
   *
   *   1. Tick A and tick B both read the cycle at phase `observe`.
   *   2. Both assess `observe` and both find it complete — correctly, because
   *      it is.
   *   3. A calls `advance`, which takes `FOR UPDATE` on the cycle row, reads
   *      phase `observe`, and moves it to `discover`.
   *   4. B calls `advance`. The row lock made it wait, so it now re-reads the
   *      row and sees phase `discover` — and advances *that* to `score`.
   *
   * The cycle has skipped `discover` entirely, and `observe`'s outputs were
   * filed under the `discover` key because `advance` labels the outputs with
   * the phase it re-read rather than the phase that was assessed. The row lock
   * inside `advance` cannot prevent this: it correctly serialises the two
   * writes, but the second write was decided on evidence gathered before the
   * first one happened. The mutual exclusion has to span assess *and* advance,
   * which means it belongs here.
   *
   * A tick that cannot get the lock returns `skipped_locked` and does nothing.
   * It does not wait, retry or throw: another tick is already doing this exact
   * work, and the whole design of the loop is that a missed tick costs one
   * interval because the next tick re-derives everything from the database.
   * Throwing would additionally be wrong — `loop.tick` has `attempts: 1`, so a
   * throw is a dead-lettered job, and a queued retry of a tick is just another
   * racing tick.
   */
  async tick(companyId: string, options: TickOptions = {}): Promise<TickResult> {
    // Establish which cycle this tick concerns *before* contending for the
    // lock, so that even a tick which does nothing can name the cycle it
    // declined to touch — a `TickResult` with no cycle would be useless to the
    // operator reading the log line. Calling this outside the lock is safe:
    // `currentOrStart` runs SERIALIZABLE, so two ticks racing to open the very
    // first cycle produce one row and one 40001 retry, not two cycles.
    const opened = await this.deps.repos.loop.currentOrStart(companyId);

    const result = await tryAdvisoryLock(this.deps.repos.pool, tickLockKey(companyId), () =>
      this.#tickExclusive(companyId, options),
    );
    if (result !== undefined) return result;

    getLogger().info(
      { companyId, cycleId: opened.id, phase: opened.phase },
      'loop tick skipped: another tick holds the lock for this company',
    );
    return {
      cycleId: opened.id,
      cycleNumber: opened.cycle_number,
      phase: opened.phase as LoopPhase,
      action: 'skipped_locked',
      detail: 'another tick already holds the operating-loop lock for this company; this tick did nothing',
    };
  }

  /**
   * The body of a tick, guaranteed to be the only one running for this company.
   */
  async #tickExclusive(companyId: string, options: TickOptions = {}): Promise<TickResult> {
    const log = getLogger();
    // Re-read under the lock instead of reusing the row `tick` already fetched.
    // Between that read and the lock being granted, the previous holder may
    // have advanced the phase — or wrapped the cycle and opened the next one —
    // and an assessment made against a stale phase is precisely the corruption
    // the lock exists to prevent. This costs one cheap query and is consistent
    // with the rest of the loop, which never trusts in-memory state.
    let cycle = await this.deps.repos.loop.currentOrStart(companyId);

    if (options.forcePhase) {
      const forced = parseForcePhase(options.forcePhase);
      await this.deps.repos.loop.setPhase(cycle.id, forced);
      await this.deps.repos.loop.unblock(cycle.id);
      cycle = await this.deps.repos.loop.currentOrStart(companyId);
      log.info({ cycleId: cycle.id, forcePhase: forced }, 'loop phase forced by operator');
    }

    const phase = cycle.phase as LoopPhase;

    // A global kill switch stops the loop before it can spend anything.
    const killed = await this.deps.repos.governance.killSwitches.engagedScopes(companyId);
    if (killed.includes('all')) {
      await this.deps.repos.loop.block(cycle.id, 'the global kill switch is engaged', null);
      return {
        cycleId: cycle.id,
        cycleNumber: cycle.cycle_number,
        phase,
        action: 'blocked',
        detail: 'global kill switch engaged; the loop will not act until it is released',
      };
    }

    const assessment = await this.assess(companyId, phase);

    if (assessment.blockedOn) {
      await this.deps.repos.loop.block(
        cycle.id,
        `${phase}: ${assessment.blockedOn.remediation}`,
        assessment.blockedOn.capability,
      );
      log.warn(
        { cycleId: cycle.id, phase, capability: assessment.blockedOn.capability },
        'loop phase blocked on an unavailable capability',
      );
      return {
        cycleId: cycle.id,
        cycleNumber: cycle.cycle_number,
        phase,
        action: 'blocked',
        detail: assessment.blockedOn.remediation,
        blockedOnCapability: assessment.blockedOn.capability,
      };
    }

    // The assessment found nothing blocking, so any `blocked` status still on
    // the row is now a false statement about the world and must be retracted
    // before this tick does anything else.
    //
    // This is the recovery path for the normal case the whole capability
    // registry is built around: a credential is issued, `apps/verifier` records
    // a passing probe, the capability goes `live_verified`, and the phase that
    // was waiting on it can proceed. Without this, nothing retracts the block —
    // `advance` (the only other writer that clears `blocked_reason`) runs solely
    // when the phase is *complete*, so a cycle blocked at `discover` on a
    // missing BRAVE_SEARCH_API_KEY keeps naming that key as the reason it is
    // stuck for as long as clustering is still in flight, hours after the key
    // was set and the probe passed. That stale row is not cosmetic: it is what
    // `GET /api/company/loop`, `/readiness` and the CEO's own `company.status`
    // tool read, so the company would be told to go fix a credential that has
    // been live and verified all along.
    //
    // It is safe to clear unconditionally here: a capability that is genuinely
    // still unavailable produces `assessment.blockedOn` above and returns
    // before this point, and the global kill switch blocks even earlier.
    if (cycle.status === 'blocked') {
      await this.deps.repos.loop.unblock(cycle.id);
      log.info(
        { cycleId: cycle.id, phase, clearedCapability: cycle.blocked_on_capability },
        'loop cycle unblocked: the capability it was waiting on is available again',
      );
    }

    if (assessment.complete) {
      const { cycle: advanced, wrapped } = await this.deps.repos.loop.advance(
        cycle.id,
        assessment.outputs ?? {},
      );
      log.info(
        { cycleId: cycle.id, from: phase, to: advanced.phase, wrapped },
        'loop advanced',
      );
      return {
        cycleId: cycle.id,
        cycleNumber: cycle.cycle_number,
        phase,
        action: wrapped ? 'cycle_completed' : 'advanced',
        detail: assessment.detail,
        nextPhase: advanced.phase as LoopPhase,
      };
    }

    // Not complete and not blocked: make sure the work for this phase is
    // actually in flight. Re-driving is safe because every enqueue is keyed.
    const started = await this.drive(companyId, cycle.id, phase);
    return {
      cycleId: cycle.id,
      cycleNumber: cycle.cycle_number,
      phase,
      action: started ? 'started_work' : 'waiting',
      detail: assessment.detail,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Assessment: has this phase produced what it promised?               */
  /* ------------------------------------------------------------------ */

  async assess(companyId: string, phase: LoopPhase): Promise<PhaseAssessment> {
    switch (phase) {
      case 'observe':
        return this.#assessObserve(companyId);
      case 'discover':
        return this.#assessDiscover(companyId);
      case 'score':
        return this.#assessScore(companyId);
      case 'expert_validate':
        return this.#assessExpertValidate(companyId);
      case 'select':
        return this.#assessSelect(companyId);
      case 'source':
        return this.#assessSource(companyId);
      case 'model_economics':
        return this.#assessEconomics(companyId);
      case 'brand':
        return this.#assessBrand(companyId);
      case 'build':
        return this.#assessBuild(companyId);
      case 'qa':
        return this.#assessQa(companyId);
      case 'launch':
        return this.#assessLaunch(companyId);
      case 'market':
        return this.#assessMarket(companyId);
      case 'measure':
        return this.#assessMeasure(companyId);
      case 'decide':
        return this.#assessDecide(companyId);
      case 'replan':
        // Replan closes the cycle. It completes as soon as the CEO decision
        // from `decide` has been recorded, which the previous phase enforced.
        return { complete: true, detail: 'cycle wrapping to a new observation window' };
    }
  }

  /**
   * Observation is the cheapest phase and always completable: it establishes
   * the current state of the business from the database. It is not a no-op —
   * the snapshot it records is what `decide` later compares against.
   */
  async #assessObserve(companyId: string): Promise<PhaseAssessment> {
    const capabilities = this.deps.capabilities.summary();
    const orders = await this.deps.repos.commerce.orders.listByStatus(
      companyId,
      ['PAID', 'FULFILLMENT_QUEUED', 'FULFILLING', 'SHIPPED', 'DELIVERED'],
      500,
    );
    const revenueMinor = orders.reduce((acc, o) => acc + o.amount_paid_minor, 0);
    return {
      complete: true,
      detail: `observed ${orders.length} fulfilled-or-paid orders, ${revenueMinor} minor units captured`,
      outputs: {
        observe: {
          observedAt: new Date().toISOString(),
          paidOrderCount: orders.length,
          capturedRevenueMinor: revenueMinor,
          capabilitySummary: capabilities,
        },
      },
    };
  }

  async #assessDiscover(companyId: string): Promise<PhaseAssessment> {
    const evidence = await this.deps.repos.research.evidence.search(companyId, {
      limit: 1,
      minConfidence: 0,
    });
    const evidenceCount = evidence.length;
    const opportunities = await this.deps.repos.research.opportunities.list(companyId, ['discovered']);

    if (evidenceCount === 0) {
      const web = this.#capabilityStatus('research.web_search');
      const browser = this.#capabilityStatus('research.browser_session');
      if (web.usable) {
        return { complete: false, detail: 'waiting for the first evidence to be collected' };
      }
      // Brave is unusable. Solari evidence (if any) is handled above. Zero
      // pages is a browser_session failure, not a web_search one.
      return {
        complete: false,
        detail: browser.usable
          ? 'Solari browser session produced no evidence rows'
          : 'no research capability is usable, so no evidence can be collected',
        blockedOn: {
          capability: 'research.browser_session',
          remediation:
            browser.usable
              ? 'research.browser_session loaded 0 pages'
              : (browser.remediation ?? web.remediation ?? `research.browser_session is ${browser.state}`),
        },
      };
    }

    if (opportunities.length === 0) {
      return { complete: false, detail: `${evidenceCount} evidence items collected; clustering not finished` };
    }
    return {
      complete: true,
      detail: `${opportunities.length} candidate opportunities from ${evidenceCount} evidence items`,
      outputs: { discover: { evidenceCount, opportunityCount: opportunities.length } },
    };
  }

  async #assessScore(companyId: string): Promise<PhaseAssessment> {
    const unscored = await this.deps.repos.research.opportunities.list(companyId, ['discovered', 'evidence_gathering']);
    const scored = await this.deps.repos.research.opportunities.list(companyId, ['scored']);
    if (unscored.length > 0) {
      return { complete: false, detail: `${unscored.length} opportunities still unscored` };
    }
    if (scored.length === 0) {
      return { complete: false, detail: 'no opportunity has a composite score yet' };
    }
    return {
      complete: true,
      detail: `${scored.length} opportunities scored`,
      outputs: { score: { scoredCount: scored.length } },
    };
  }

  async #assessExpertValidate(companyId: string): Promise<PhaseAssessment> {
    // A real completed review beats every caveat path below, even while other
    // reviews are still open: the phase promised a review artefact and one
    // exists.
    const reviewed = await this.deps.repos.research.opportunities.list(companyId, ['expert_reviewed']);
    if (reviewed.length > 0) {
      return {
        complete: true,
        detail: `${reviewed.length} opportunities carry a completed expert review`,
        outputs: { expert_validate: { performed: true, reviewedOpportunities: reviewed.length } },
      };
    }

    // Requesting a review moves an opportunity to `expert_review_requested`,
    // so an assessment keyed on `scored` alone goes blind the moment the drive
    // step runs and pins the cycle here forever.
    const candidates = await this.deps.repos.research.opportunities.list(companyId, [
      'scored',
      'expert_review_requested',
    ]);
    if (candidates.length === 0) return { complete: false, detail: 'nothing to validate' };

    const status = this.#capabilityStatus('expert.structured_review');
    if (!status.usable) {
      // Expert validation is a quality gate, not a hard dependency. The plan
      // allows proceeding without it, but the cycle must record that the
      // opportunity was selected WITHOUT expert validation — that fact travels
      // with the decision rather than being lost.
      return {
        complete: true,
        detail: `proceeding without expert validation: ${status.remediation ?? status.state}`,
        outputs: {
          expert_validate: {
            performed: false,
            reason: status.remediation ?? `capability is ${status.state}`,
            caveat: 'opportunity selection is unvalidated by human experts',
          },
        },
      };
    }

    const open = await this.deps.repos.research.expertReviews.listOpen(companyId);
    if (open.length === 0) {
      return { complete: false, detail: 'no expert review has been requested yet' };
    }

    const now = Date.now();
    const progressing = open.filter((review) => reviewCanStillProgress(review, now));
    if (progressing.length > 0) {
      return { complete: false, detail: `${progressing.length} of ${open.length} expert reviews still open` };
    }

    // None of the open reviews can complete this phase on their own: `priced`
    // is a live Terac response proving the study is unfunded, and the rest
    // have outlived the pricing deadline with no engagement. The same escape
    // as the unusable-capability branch above applies — the review rows are
    // deliberately NOT cancelled, so the `expert.poll` cron can still complete
    // them if Terac funds or answers later, but they must not pin the cycle.
    const unfunded = open.filter((review) => review.status === 'priced').length;
    const reason =
      unfunded > 0
        ? TERAC_STUDY_BLOCKER
        : `Terac did not respond to ${open.length} feasibility pricing request(s) within ` +
          `${EXPERT_PRICING_DEADLINE_MS / 60_000} minutes. The review rows stay open and the expert.poll ` +
          `cron will still complete them if Terac answers later.`;
    return {
      complete: true,
      detail:
        `proceeding without expert validation: ${open.length} expert reviews are open but none can progress ` +
        `(${unfunded} unfunded, ${open.length - unfunded} unanswered past the pricing deadline)`,
      outputs: {
        expert_validate: {
          performed: false,
          reason,
          caveat: 'opportunity selection is unvalidated by human experts',
        },
      },
    };
  }

  async #assessSelect(companyId: string): Promise<PhaseAssessment> {
    const company = await this.deps.repos.companies.byId(companyId);
    if (company.selected_opportunity_id) {
      return {
        complete: true,
        detail: `opportunity ${company.selected_opportunity_id} selected`,
        outputs: { select: { opportunityId: company.selected_opportunity_id } },
      };
    }
    // `expert_review_requested` belongs here because `expert_validate` can
    // complete with `performed: false` while the requests are still open at
    // Terac; the caveat travels on the cycle outputs and no stage rule forbids
    // selecting such a candidate. The stage is not reset to `scored`, both
    // because it is the truth (the requests remain open and pollable) and
    // because a `scored` row would make the next expert_validate drive step
    // re-request — and re-pay for — the same review.
    const passed = await this.deps.repos.research.opportunities.list(companyId, [
      'scored',
      'expert_review_requested',
      'expert_reviewed',
      'ceo_review',
    ]);
    if (passed.length === 0) {
      return { complete: false, detail: 'no opportunity passed the selection gates' };
    }
    return { complete: false, detail: 'awaiting the CEO selection decision' };
  }

  async #assessSource(companyId: string): Promise<PhaseAssessment> {
    const quoteCount = await this.deps.repos.sourcing.quotes.countGrounded(companyId);

    // A digital product has no supplier, so there is no RFQ to send and no
    // quote that could ever arrive. Waiting here would not be caution, it would
    // be a phase parked on an artefact that does not exist for this kind of
    // business — indefinitely, since `sourcing.rfq_submit` and
    // `sourcing.quote_retrieve` have no live provider either. The phase
    // therefore completes, but it completes *stating why*: `performed: false`
    // with the reason recorded on the cycle, in the same shape `expert_validate`
    // uses when it proceeds without a review. No supplier, RFQ, quote or
    // supplier_quotes row is created, and `groundedQuoteCount` reports the real
    // count (normally 0) rather than implying sourcing happened.
    if (await this.#isDigital(companyId)) {
      return {
        complete: true,
        detail:
          'digital product line: there is no supplier to source from, so sourcing completes without a quote',
        outputs: {
          source: {
            performed: false,
            productLine: 'digital',
            reason:
              'commerce.productLine is "digital"; a digital product has no supplier, no RFQ and no supplier quote. ' +
              'No supplier, quote or cost figure was fabricated to satisfy this phase.',
            groundedQuoteCount: quoteCount,
            caveat:
              'unit economics for this line are modelled from measured marginal delivery cost, not from a supplier quote',
          },
        },
      };
    }

    if (quoteCount === 0) {
      const status = this.#capabilityStatus('sourcing.supplier_search');
      if (!status.usable) {
        return {
          complete: false,
          detail: 'no supplier sourcing capability is usable',
          blockedOn: {
            capability: 'sourcing.supplier_search',
            remediation: status.remediation ?? `sourcing capability is ${status.state}`,
          },
        };
      }
      return { complete: false, detail: 'awaiting the first supplier quote' };
    }
    return {
      complete: true,
      detail: `${quoteCount} grounded supplier quotes recorded`,
      outputs: { source: { groundedQuoteCount: quoteCount } },
    };
  }

  async #assessEconomics(companyId: string): Promise<PhaseAssessment> {
    const models = await this.deps.repos.sourcing.landedCosts.listForCompany(companyId);
    const viable = models.filter((m) => m.grounded_ratio >= DEFAULT_SELECTION_GATES.minGroundedWeightRatio);
    if (models.length === 0) {
      // Both lines require a real unit-economics model before launch — a digital
      // product still has marginal cost, and an opportunity cannot be selected
      // without a contribution margin. Only the inputs differ, so only the
      // wording of what is missing differs.
      return {
        complete: false,
        detail: (await this.#isDigital(companyId))
          ? 'no unit-economics model has been built yet from the measured marginal cost of delivering a digital unit'
          : 'no landed-cost model has been built yet',
      };
    }
    if (viable.length === 0) {
      // A real, common outcome: the unit economics do not work. The loop must
      // report this rather than proceeding to build a business that loses money
      // on every sale.
      return {
        complete: true,
        detail: `no landed-cost model clears the margin gate (${models.length} evaluated); the CEO must reselect`,
        outputs: {
          model_economics: {
            evaluated: models.length,
            viable: 0,
            verdict: 'unit economics do not support launch',
          },
        },
      };
    }
    return {
      complete: true,
      detail: `${viable.length} of ${models.length} cost models clear the margin gate`,
      outputs: { model_economics: { evaluated: models.length, viable: viable.length } },
    };
  }

  async #assessBrand(companyId: string): Promise<PhaseAssessment> {
    const company = await this.deps.repos.companies.byId(companyId);
    if (company.active_brand_id) {
      return {
        complete: true,
        detail: `brand ${company.active_brand_id} active`,
        outputs: { brand: { brandId: company.active_brand_id } },
      };
    }
    return { complete: false, detail: 'no brand has been established yet' };
  }

  async #assessBuild(companyId: string): Promise<PhaseAssessment> {
    const company = await this.deps.repos.companies.byId(companyId);
    if (!company.active_site_id) {
      const status = this.#capabilityStatus('site.generate');
      if (!status.usable) {
        return {
          complete: false,
          detail: 'no site generation capability is usable',
          blockedOn: {
            capability: 'site.generate',
            remediation: status.remediation ?? `site generation is ${status.state}`,
          },
        };
      }
      return { complete: false, detail: 'site build in progress' };
    }

    const site = await this.deps.repos.build.sites.byId(company.active_site_id);
    const succeeded = await this.deps.repos.build.sites.latestSucceededBuild(company.active_site_id);
    if (BUILD_EVIDENCE_STATUSES.has(site.status) || succeeded) {
      return {
        complete: true,
        detail: `site ${company.active_site_id} ${site.status}`,
        outputs: { build: { siteId: company.active_site_id, status: site.status } },
      };
    }
    return {
      complete: false,
      detail: `site ${company.active_site_id} is ${site.status}; waiting for a generated build`,
    };
  }

  async #assessQa(companyId: string): Promise<PhaseAssessment> {
    const company = await this.deps.repos.companies.byId(companyId);
    if (!company.active_site_id) {
      return { complete: false, detail: 'no site exists to run QA against' };
    }
    const runs = await this.deps.repos.build.qa.runsForSite(company.active_site_id, 1);
    const latest = runs[0];
    if (!latest) {
      return { complete: false, detail: 'no QA run has been executed against the built site' };
    }
    if (latest.status === 'running' || latest.status === 'queued') {
      return { complete: false, detail: `QA run ${latest.id} is ${latest.status}` };
    }
    // A failed gate does not block the loop — it sends the cycle onward with
    // the failure recorded, and the deployment CHECK constraint independently
    // prevents a production release without a passing run.
    return {
      complete: true,
      detail: `QA run ${latest.id} finished with status ${latest.status}`,
      outputs: { qa: { runId: latest.id, status: latest.status, gatePassed: latest.status === 'passed' } },
    };
  }

  async #assessLaunch(companyId: string): Promise<PhaseAssessment> {
    const live = await this.deps.repos.build.deployments.currentLive(companyId, 'production');
    if (!live) {
      const status = this.#capabilityStatus('site.publish_preview');
      if (!status.usable) {
        return {
          complete: false,
          detail: 'no publishing capability is usable',
          blockedOn: {
            capability: 'site.publish_preview',
            remediation: status.remediation ?? `publishing is ${status.state}`,
          },
        };
      }
      return { complete: false, detail: 'awaiting a live production deployment' };
    }
    return {
      complete: true,
      detail: `deployment ${live.id} is live`,
      outputs: { launch: { deploymentId: live.id, url: live.url } },
    };
  }

  async #assessMarket(companyId: string): Promise<PhaseAssessment> {
    const active = await this.deps.repos.growth.experiments.listRunning(companyId);
    const linqSends = await this.deps.repos.growth.support.countOutbound(companyId, 'linq');
    if (active.length > 0 || linqSends > 0) {
      return {
        complete: true,
        detail:
          active.length > 0
            ? `${active.length} experiments live`
            : `${linqSends} Linq outreach messages sent`,
        outputs: { market: { activeExperiments: active.length, linqOutbound: linqSends } },
      };
    }

    const ads = this.#capabilityStatus('ads.campaign_manage');
    const linq = this.#capabilityStatus('messaging.imessage_app');
    if (!ads.usable && !linq.usable) {
      return {
        complete: false,
        detail: 'no advertising or Linq messaging capability is usable, so no customers can be reached',
        blockedOn: {
          capability: ads.usable ? 'messaging.imessage_app' : 'ads.campaign_manage',
          remediation:
            [ads.remediation, linq.remediation].filter(Boolean).join(' ') ||
            `ads is ${ads.state}; linq is ${linq.state}`,
        },
      };
    }
    return { complete: false, detail: 'awaiting the first live experiment or Linq outreach send' };
  }

  async #assessMeasure(companyId: string): Promise<PhaseAssessment> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const experiments = await this.deps.repos.growth.experiments.listRunning(companyId);
    let snapshotCount = 0;
    for (const experiment of experiments) {
      const recent = await this.deps.repos.growth.metrics.recent('experiment', experiment.id, 48);
      snapshotCount += recent.filter((r) => r.window_end >= since).length;
    }
    if (snapshotCount === 0) {
      return { complete: false, detail: 'no metric snapshots collected in the last 24 hours' };
    }
    return {
      complete: true,
      detail: `${snapshotCount} metric snapshots in the last 24 hours`,
      outputs: { measure: { snapshotCount } },
    };
  }

  async #assessDecide(companyId: string): Promise<PhaseAssessment> {
    const cycle = await this.deps.repos.loop.currentOrStart(companyId);
    if (cycle.ceo_decision) {
      return {
        complete: true,
        detail: `CEO decision recorded: ${cycle.ceo_decision}`,
        outputs: { decide: { decision: cycle.ceo_decision, rationale: cycle.ceo_decision_rationale } },
      };
    }
    return { complete: false, detail: 'awaiting the CEO decision for this cycle' };
  }

  /* ------------------------------------------------------------------ */
  /* Driving: put the phase's work in flight                             */
  /* ------------------------------------------------------------------ */

  /**
   * Enqueues the work a phase needs, or dispatches the responsible agent.
   *
   * Returns whether anything new was started. Every enqueue is keyed on the
   * cycle and phase, so calling this on every tick does not pile up duplicate
   * work — BullMQ deduplicates on the job id.
   */
  async drive(companyId: string, cycleId: string, phase: LoopPhase): Promise<boolean> {
    const key = (suffix: string) => `${cycleId}:${phase}:${suffix}`;
    const base = { companyId, traceId: cycleId, originRunId: null };
    const company = await this.deps.repos.companies.byId(companyId);

    switch (phase) {
      /* ------------------------------------------------------------ */
      /* Judgement phases: the organisation decides, not a queue job.  */
      /* ------------------------------------------------------------ */

      case 'discover': {
        // What to research is a judgement call — which markets, which
        // sources, which queries. The manager makes it and its tools enqueue
        // `research.collect` with concrete arguments. Enqueueing directly
        // from here would mean inventing a search query. Clustering, once
        // evidence exists, is mechanical and must not wait on the agent tool.
        const evidence = await this.deps.repos.research.evidence.search(companyId, {
          limit: 1,
          minConfidence: 0,
        });
        if (evidence.length > 0) {
          await this.deps.queues.enqueue('research.cluster', {
            ...base,
            idempotencyKey: key('cluster'),
            sinceIso: null,
            minClusterSize: 3,
          });
        }
        return this.#dispatch(companyId, cycleId, 'research_manager', {
          objective:
            'Collect real market evidence and cluster it into candidate opportunities. ' +
            'Every claim must cite a retrievable source; do not generate pain points from prior knowledge.',
          phase,
        });
      }

      case 'select':
        return this.#dispatch(companyId, cycleId, 'ceo', {
          objective:
            'Select the opportunity to pursue from the scored candidates, or reject them all and say why. ' +
            'Cite the composite score, the grounded-evidence ratio, and the commercial reasoning.',
          phase,
        }, { system: true });

      case 'decide':
        return this.#dispatch(companyId, cycleId, 'ceo', {
          objective:
            'Decide this cycle: scale, hold, pivot or stop. Cite the metric snapshots and the ledger ' +
            'position behind the decision. If the data is insufficient, say so and hold.',
          phase,
        }, { system: true });

      case 'source': {
        // Assessment completes `source` outright on a digital line, so this is
        // normally unreachable there. Guarding anyway: an operator forcing the
        // phase must not spend a sourcing manager's inference budget hunting
        // suppliers for a product that has none.
        if (productLineOf(company.config) === 'digital') return false;
        return this.#dispatch(companyId, cycleId, 'sourcing_manager', {
          objective:
            'Find real suppliers for the selected opportunity and obtain quotes. ' +
            'A quote must come from a supplier response or a provider API; never estimate one.',
          phase,
          opportunityId: company.selected_opportunity_id,
        });
      }

      case 'brand':
        return this.#dispatch(companyId, cycleId, 'brand_manager', {
          objective: 'Establish the brand: name, positioning, voice, and logo, grounded in the selected opportunity.',
          phase,
          opportunityId: company.selected_opportunity_id,
        });

      case 'market': {
        await this.deps.queues.enqueue('marketing.outreach', {
          ...base,
          idempotencyKey: key('linq-outreach'),
        });
        return this.#dispatch(companyId, cycleId, 'growth_manager', {
          objective:
            'Acquire customers: send the fixed-price founding checkout over Linq to consented handles ' +
            '(linq.outreach / linq.send_link), and launch advertising experiments against the live storefront. ' +
            'Do not let customers type an amount. Creative must pass human review before an ad arm goes live.',
          phase,
          siteId: company.active_site_id,
        });
      }

      /* ------------------------------------------------------------ */
      /* Mechanical phases: the loop already knows the arguments.      */
      /* ------------------------------------------------------------ */

      case 'score': {
        const pending = await this.deps.repos.research.opportunities.list(companyId, [
          'discovered',
          'evidence_gathering',
        ]);
        for (const opportunity of pending) {
          await this.deps.queues.enqueue('opportunity.score', {
            ...base,
            idempotencyKey: key(opportunity.id),
            opportunityId: opportunity.id,
            weightProfile: 'commercial_impact',
          });
        }
        return pending.length > 0;
      }

      case 'expert_validate': {
        const experts = new ExpertReviewService(this.deps);
        const scored = await this.deps.repos.research.opportunities.list(companyId, ['scored']);
        let requested = 0;
        for (const opportunity of scored.slice(0, 8)) {
          const result = await experts.request({
            companyId,
            subjectRefId: opportunity.id,
            subject: 'opportunity_validity',
            question:
              `General Population feasibility review for opportunity "${opportunity.title}": ${opportunity.concept}. ` +
              `Would you buy this, at what price, and what would stop you?`,
            participantsRequested: 5,
          });
          if (result.reviewId) requested += 1;
        }
        const open = await this.deps.repos.research.expertReviews.listOpen(companyId);
        for (const review of open) {
          await this.deps.queues.enqueue('expert.poll', {
            ...base,
            idempotencyKey: key(review.id),
            expertReviewId: review.id,
            attempt: 0,
          });
        }
        return requested > 0 || open.length > 0;
      }

      case 'build': {
        if (!company.active_site_id) {
          return this.#dispatch(companyId, cycleId, 'commerce_manager', {
            objective: 'Create the storefront site record and generate the first build from the brand and catalogue.',
            phase,
          });
        }
        await this.deps.queues.enqueue('site.build', {
          ...base,
          idempotencyKey: key(company.active_site_id),
          siteId: company.active_site_id,
          reason: 'initial',
          instructions: null,
        });
        const site = await this.deps.repos.build.sites.byId(company.active_site_id);
        const succeeded = await this.deps.repos.build.sites.latestSucceededBuild(company.active_site_id);
        if (!BUILD_NOT_YET_GENERATED.has(site.status) || succeeded) {
          await this.deps.queues.enqueue('site.deploy', {
            ...base,
            idempotencyKey: key('preview'),
            siteId: company.active_site_id,
            environment: 'preview',
            commitSha: null,
            gatingQaRunId: null,
          });
        }
        return true;
      }

      case 'qa': {
        if (!company.active_site_id) return false;
        const deployment = await this.deps.repos.build.deployments.currentLive(companyId, 'preview', company.active_site_id);
        if (!deployment?.url) {
          // Nothing deployed to test against yet. QA against a URL that does
          // not exist would produce a meaningless pass.
          return false;
        }
        await this.deps.queues.enqueue('qa.run', {
          ...base,
          idempotencyKey: key(deployment.id),
          siteId: company.active_site_id,
          deploymentId: deployment.id,
          targetUrl: deployment.url,
          kinds: ['autonomous_exploration', 'payment_state', 'data_integrity'],
          blockingForRelease: true,
        });
        return true;
      }

      case 'launch': {
        if (!company.active_site_id) return false;
        const runs = await this.deps.repos.build.qa.runsForSite(company.active_site_id, 1);
        const gating = runs[0];
        if (!gating || gating.status !== 'passed') {
          // The database also refuses this, but failing here gives a reason
          // instead of a constraint violation.
          return false;
        }
        await this.deps.queues.enqueue('site.deploy', {
          ...base,
          idempotencyKey: key(gating.id),
          siteId: company.active_site_id,
          environment: 'production',
          commitSha: null,
          gatingQaRunId: gating.id,
        });
        return true;
      }

      case 'measure': {
        const running = await this.deps.repos.growth.experiments.listRunning(companyId);
        const windowEnd = new Date();
        const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
        for (const experiment of running) {
          await this.deps.queues.enqueue('marketing.metrics_collect', {
            ...base,
            idempotencyKey: key(`${experiment.id}:${windowStart.toISOString().slice(0, 13)}`),
            experimentId: experiment.id,
            windowStartIso: windowStart.toISOString(),
            windowEndIso: windowEnd.toISOString(),
          });
        }
        return running.length > 0;
      }

      case 'model_economics': {
        const economics = new LandedCostService(this.deps);
        const opportunityId = company.selected_opportunity_id;
        if (!opportunityId) return false;
        let destination = 'US';
        let currency = 'USD';
        try {
          const config = companyConfig(company);
          destination = config.commerce.shipsFrom[0] ?? 'US';
          currency = config.commerce.baseCurrency;
        } catch {
          destination = 'US';
          currency = 'USD';
        }

        if (productLineOf(company.config) === 'digital') {
          // No quotes exist and none can, so the model is built from what the
          // company has actually been charged to run itself. `buildDigital`
          // refuses if nothing has been measured — that refusal is the correct
          // outcome, not a case to paper over with an estimate.
          const opportunity = await this.deps.repos.research.opportunities.byId(opportunityId);
          try {
            await economics.buildDigital({
              companyId,
              opportunityId,
              currency,
              destinationCountry: destination,
              sellingPriceMinor: opportunity.assumed_selling_price_cents,
            });
            return true;
          } catch (error) {
            if (error instanceof ValidationError) {
              getLogger().warn(
                { opportunityId, err: error.message },
                'digital unit-cost model refused; nothing was estimated',
              );
              return false;
            }
            throw error;
          }
        }

        const quotes = await this.deps.repos.sourcing.quotes.forOpportunity(opportunityId);
        const opportunity = await this.deps.repos.research.opportunities.byId(opportunityId);
        let built = 0;
        for (const quote of quotes) {
          try {
            await economics.build({
              companyId,
              opportunityId,
              quoteId: quote.id,
              orderQuantity: quote.moq,
              destinationCountry: destination,
              sellingPriceMinor: opportunity.assumed_selling_price_cents,
            });
            built += 1;
          } catch (error) {
            if (error instanceof ValidationError) {
              getLogger().warn({ quoteId: quote.id, err: error.message }, 'landed-cost model refused this quote');
              continue;
            }
            throw error;
          }
        }
        return built > 0;
      }

      // `observe` and `replan` complete synchronously in their assessment.
      default:
        return false;
    }
  }

  /** Dispatches a manager or the CEO and reports that work started. */
  async #dispatch(
    companyId: string,
    cycleId: string,
    roleKey: string,
    input: { objective: string; phase: LoopPhase } & Record<string, unknown>,
    options: { readonly system?: boolean } = {},
  ): Promise<boolean> {
    const { objective, ...inputRefs } = input;
    if (options.system || roleKey === 'ceo') {
      await this.deps.dispatcher.enqueueSystem({
        companyId,
        toRoleKey: roleKey,
        objective,
        traceId: cycleId,
        inputRefs: { cycleId, ...inputRefs },
      });
    } else {
      await this.deps.dispatcher.dispatch({
        companyId,
        fromRoleKey: 'ceo',
        toRoleKey: roleKey,
        objective,
        traceId: cycleId,
        inputRefs: { cycleId, ...inputRefs },
      });
    }
    return true;
  }

  #capabilityStatus(capability: Capability) {
    return this.deps.capabilities.resolveCapability(capability);
  }

  /**
   * What this company sells, read straight from the stored config.
   *
   * Deliberately not inferred from the mission text or the opportunity title:
   * string-matching a prose field would make the loop's behaviour depend on how
   * a sentence was phrased, and a reworded mission would silently change which
   * artefacts a phase waits for. `productLineOf` reads the one declared field
   * and falls back to `physical`, so an unset or drifted config keeps the
   * behaviour that existed before this field did.
   */
  async #productLine(companyId: string): Promise<ProductLine> {
    const company = await this.deps.repos.companies.byId(companyId);
    return productLineOf(company.config);
  }

  async #isDigital(companyId: string): Promise<boolean> {
    return (await this.#productLine(companyId)) === 'digital';
  }

  /** Human-readable position in the cycle, for the operator view. */
  static phaseIndex(phase: LoopPhase): { index: number; total: number } {
    return { index: LOOP_PHASE_ORDER.indexOf(phase) + 1, total: LOOP_PHASE_ORDER.length };
  }
}
