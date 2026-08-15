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
 * Two properties matter most:
 *
 *  1. **A phase only completes on evidence.** "Discover" is not done because an
 *     agent was dispatched; it is done because opportunity rows with cited
 *     evidence exist. Every `isPhaseComplete` branch queries for the artefact
 *     the phase was supposed to produce.
 *  2. **Blocked is a first-class outcome.** When a phase cannot proceed because
 *     a capability is unavailable, the cycle records `blocked` with the
 *     capability name and remediation. It does not skip ahead, and it does not
 *     pretend the phase succeeded.
 */

import { LOOP_PHASE_ORDER, type Capability, type LoopPhase } from '@foundry/core';
import { getLogger } from '@foundry/obs';
import type { ServiceDeps } from '../deps.js';

export interface TickResult {
  readonly cycleId: string;
  readonly cycleNumber: number;
  readonly phase: LoopPhase;
  readonly action: 'advanced' | 'waiting' | 'blocked' | 'started_work' | 'cycle_completed';
  readonly detail: string;
  readonly blockedOnCapability?: Capability;
  readonly nextPhase?: LoopPhase;
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
   * Deliberately does a small amount of work and returns. The cron schedule,
   * not a long-running process, is what keeps the company moving — a wedged
   * tick costs one interval, not the whole operation.
   */
  async tick(companyId: string): Promise<TickResult> {
    const log = getLogger();
    const cycle = await this.deps.repos.loop.currentOrStart(companyId);
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
    const evidence = await this.deps.repos.research.evidence.search(companyId, { limit: 1 });
    const evidenceCount = evidence.length;
    const opportunities = await this.deps.repos.research.opportunities.list(companyId, ['discovered']);

    if (evidenceCount === 0) {
      const status = this.#capabilityStatus('research.web_search');
      if (!status.usable) {
        return {
          complete: false,
          detail: 'no research capability is usable, so no evidence can be collected',
          blockedOn: {
            capability: 'research.web_search',
            remediation: status.remediation ?? `research capability is ${status.state}`,
          },
        };
      }
      return { complete: false, detail: 'waiting for the first evidence to be collected' };
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
    const scored = await this.deps.repos.research.opportunities.list(companyId, ['scored']);
    if (scored.length === 0) return { complete: false, detail: 'nothing to validate' };

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
    if (open.length > 0) {
      return { complete: false, detail: `${open.length} expert reviews still open` };
    }
    const reviewed = await this.deps.repos.research.opportunities.list(companyId, ['expert_reviewed']);
    return {
      complete: reviewed.length > 0,
      detail:
        reviewed.length > 0
          ? `${reviewed.length} opportunities carry a completed expert review`
          : 'no expert review has been requested yet',
      outputs: { expert_validate: { performed: true, reviewedOpportunities: reviewed.length } },
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
    const passed = await this.deps.repos.research.opportunities.list(companyId, ['scored', 'expert_reviewed', 'ceo_review']);
    if (passed.length === 0) {
      return { complete: false, detail: 'no opportunity passed the selection gates' };
    }
    return { complete: false, detail: 'awaiting the CEO selection decision' };
  }

  async #assessSource(companyId: string): Promise<PhaseAssessment> {
    const quoteCount = await this.deps.repos.sourcing.quotes.countGrounded(companyId);
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
    const viable = models.filter((m) => m.passes_margin_gate === true);
    if (models.length === 0) {
      return { complete: false, detail: 'no landed-cost model has been built yet' };
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
    return {
      complete: true,
      detail: `site ${company.active_site_id} built`,
      outputs: { build: { siteId: company.active_site_id } },
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
    if (active.length === 0) {
      const status = this.#capabilityStatus('ads.campaign_manage');
      if (!status.usable) {
        return {
          complete: false,
          detail: 'no advertising capability is usable, so no traffic can be bought',
          blockedOn: {
            capability: 'ads.campaign_manage',
            remediation: status.remediation ?? `ad platform is ${status.state}`,
          },
        };
      }
      return { complete: false, detail: 'awaiting the first live experiment' };
    }
    return {
      complete: true,
      detail: `${active.length} experiments live`,
      outputs: { market: { activeExperiments: active.length } },
    };
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

      case 'discover':
        // What to research is a judgement call — which markets, which
        // sources, which queries. The manager makes it and its tools enqueue
        // `research.collect` with concrete arguments. Enqueueing directly
        // from here would mean inventing a search query.
        return this.#dispatch(companyId, cycleId, 'research_manager', {
          objective:
            'Collect real market evidence and cluster it into candidate opportunities. ' +
            'Every claim must cite a retrievable source; do not generate pain points from prior knowledge.',
          phase,
        });

      case 'select':
        return this.#dispatch(companyId, cycleId, 'ceo', {
          objective:
            'Select the opportunity to pursue from the scored candidates, or reject them all and say why. ' +
            'Cite the composite score, the grounded-evidence ratio, and the commercial reasoning.',
          phase,
        });

      case 'decide':
        return this.#dispatch(companyId, cycleId, 'ceo', {
          objective:
            'Decide this cycle: scale, hold, pivot or stop. Cite the metric snapshots and the ledger ' +
            'position behind the decision. If the data is insufficient, say so and hold.',
          phase,
        });

      case 'source':
        return this.#dispatch(companyId, cycleId, 'sourcing_manager', {
          objective:
            'Find real suppliers for the selected opportunity and obtain quotes. ' +
            'A quote must come from a supplier response or a provider API; never estimate one.',
          phase,
          opportunityId: company.selected_opportunity_id,
        });

      case 'brand':
        return this.#dispatch(companyId, cycleId, 'brand_manager', {
          objective: 'Establish the brand: name, positioning, voice, and logo, grounded in the selected opportunity.',
          phase,
          opportunityId: company.selected_opportunity_id,
        });

      case 'market':
        return this.#dispatch(companyId, cycleId, 'growth_manager', {
          objective:
            'Launch the first advertising experiments against the live storefront. ' +
            'Creative must pass human review before an arm goes live.',
          phase,
          siteId: company.active_site_id,
        });

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
        const open = await this.deps.repos.research.expertReviews.listOpen(companyId);
        for (const review of open) {
          await this.deps.queues.enqueue('expert.poll', {
            ...base,
            idempotencyKey: key(review.id),
            expertReviewId: review.id,
            attempt: 0,
          });
        }
        return open.length > 0;
      }

      case 'build': {
        if (!company.active_site_id) {
          return this.#dispatch(companyId, cycleId, 'engineering_manager', {
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
          kinds: ['exploration', 'critical_flow'],
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

      // `observe`, `model_economics` and `replan` complete synchronously in
      // their assessment, so there is nothing to drive.
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
  ): Promise<boolean> {
    const { objective, ...inputRefs } = input;
    await this.deps.dispatcher.dispatch({
      companyId,
      fromRoleKey: 'ceo',
      toRoleKey: roleKey,
      objective,
      traceId: cycleId,
      inputRefs: { cycleId, ...inputRefs },
    });
    return true;
  }

  #capabilityStatus(capability: Capability) {
    return this.deps.capabilities.resolveCapability(capability);
  }

  /** Human-readable position in the cycle, for the operator view. */
  static phaseIndex(phase: LoopPhase): { index: number; total: number } {
    return { index: LOOP_PHASE_ORDER.indexOf(phase) + 1, total: LOOP_PHASE_ORDER.length };
  }
}
