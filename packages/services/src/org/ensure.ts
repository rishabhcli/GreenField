/**
 * Ensures one operating company exists: row, org-chart actors, loop cycle,
 * first `loop.tick` job. Called from API/worker boot and from POST
 * `/api/companies`. Creating the company does not invent sponsor capability;
 * later phases record `blockedOn` when a key is missing.
 */

import { CompanyConfig, describeError } from '@foundry/core';
import type { Repositories } from '@foundry/db';
import type { QueueSet } from '@foundry/queue';
import { getLogger } from '@foundry/obs';
import { defaultHackathonCompanyConfig, HACKATHON_COMPANY } from './default-config.js';
import { seedOrgActors } from './seed.js';

export interface EnsureOperatingCompanyInput {
  readonly repos: Repositories;
  readonly queues: QueueSet;
  readonly name?: string;
  readonly mission?: string;
  readonly ownerName?: string;
  readonly ownerEmail?: string;
  readonly config?: CompanyConfig;
}

export interface EnsureOperatingCompanyResult {
  readonly companyId: string;
  readonly name: string;
  readonly created: boolean;
  readonly actorsSeeded: number;
  readonly cycleId: string;
  readonly cyclePhase: string;
  readonly cycleStatus: string;
  readonly loopJobId: string | null;
  readonly enqueueError: string | null;
}

export async function ensureOperatingCompany(
  input: EnsureOperatingCompanyInput,
): Promise<EnsureOperatingCompanyResult> {
  const log = getLogger();
  const existing = await input.repos.companies.first();
  if (existing) {
    const currency = safeCurrency(existing);
    const actorsSeeded = await seedOrgActors(input.repos, existing.id, currency);
    const cycle = await input.repos.loop.currentOrStart(existing.id);
    const queued = await enqueueFirstTick(input.queues, existing.id, cycle.id);
    log.info(
      { companyId: existing.id, cycleId: cycle.id, created: false, actorsSeeded },
      'operating company already present',
    );
    return {
      companyId: existing.id,
      name: existing.name,
      created: false,
      actorsSeeded,
      cycleId: cycle.id,
      cyclePhase: cycle.phase,
      cycleStatus: cycle.status,
      loopJobId: queued.loopJobId,
      enqueueError: queued.enqueueError,
    };
  }

  const ownerName = input.ownerName ?? HACKATHON_COMPANY.ownerName;
  const ownerEmail = input.ownerEmail ?? HACKATHON_COMPANY.ownerEmail;
  const config = input.config ?? defaultHackathonCompanyConfig({ ownerName, ownerEmail });
  const company = await input.repos.companies.create({
    name: input.name ?? HACKATHON_COMPANY.name,
    mission: input.mission ?? HACKATHON_COMPANY.mission,
    config,
  });
  const actorsSeeded = await seedOrgActors(input.repos, company.id, config.commerce.baseCurrency);
  const cycle = await input.repos.loop.currentOrStart(company.id);
  const queued = await enqueueFirstTick(input.queues, company.id, cycle.id);
  log.info(
    { companyId: company.id, cycleId: cycle.id, created: true, actorsSeeded, loopJobId: queued.loopJobId },
    'operating company created',
  );
  return {
    companyId: company.id,
    name: company.name,
    created: true,
    actorsSeeded,
    cycleId: cycle.id,
    cyclePhase: cycle.phase,
    cycleStatus: cycle.status,
    loopJobId: queued.loopJobId,
    enqueueError: queued.enqueueError,
  };
}

function safeCurrency(row: { readonly config: unknown }): string {
  const parsed = CompanyConfig.safeParse(row.config);
  return parsed.success ? parsed.data.commerce.baseCurrency : 'USD';
}

async function enqueueFirstTick(
  queues: QueueSet,
  companyId: string,
  cycleId: string,
): Promise<{ loopJobId: string | null; enqueueError: string | null }> {
  try {
    const loopJobId = await queues.enqueue('loop.tick', {
      companyId,
      traceId: companyId,
      originRunId: null,
      idempotencyKey: `loop:start:${companyId}`,
      cycleId,
      forcePhase: null,
    });
    return { loopJobId, enqueueError: null };
  } catch (error) {
    getLogger().warn(
      { companyId, err: describeError(error) },
      'loop.tick enqueue failed; in-process tick is the fallback',
    );
    return { loopJobId: null, enqueueError: error instanceof Error ? error.message : String(error) };
  }
}
