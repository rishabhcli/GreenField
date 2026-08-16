/**
 * Brand, storefront, deployment, QA and legal-document persistence.
 *
 * `promoteToProduction` will not record a live production deployment without a
 * QA run id, and it re-evaluates the release gate before writing rather than
 * trusting the caller — the gate is the one control standing between generated
 * code and a real customer's card details.
 */

import { z } from 'zod';
import {
  evaluateReleaseGate,
  newId,
  PRODUCTION_REQUIRED_RUN_KINDS,
  CRITICAL_FLOWS,
  type CriticalFlow,
  type Defect,
  type DefectSeverity,
  type QaRunKind,
  type SiteSpec,
  type SiteStatus,
} from '@foundry/core';
import { ConflictError } from '@foundry/core';
import { exec, q, qMaybe, qOne, withTransaction, type DbPool, type Queryable } from '../pool.js';

/* -------------------------------------------------------------------------- */
/* Brand                                                                       */
/* -------------------------------------------------------------------------- */

const BrandRow = z.object({
  id: z.string(),
  company_id: z.string(),
  opportunity_id: z.string(),
  name: z.string(),
  legal_entity_name: z.string().nullable(),
  tagline: z.string(),
  positioning: z.string(),
  value_proposition: z.string(),
  target_segment: z.string(),
  tone_attributes: z.array(z.string()),
  permitted_claims: z.array(z.record(z.string(), z.unknown())),
  prohibited_claims: z.array(z.string()),
  palette: z.array(z.record(z.string(), z.unknown())),
  typography: z.record(z.string(), z.unknown()),
  domain: z.string().nullable(),
  name_candidates: z.array(z.record(z.string(), z.unknown())),
  status: z.string(),
});

export type BrandRow = z.infer<typeof BrandRow>;

const BRAND_COLUMNS = `id, company_id, opportunity_id, name, legal_entity_name, tagline, positioning,
  value_proposition, target_segment, tone_attributes, permitted_claims, prohibited_claims, palette,
  typography, domain, name_candidates, status`;

export class BrandRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    companyId: string;
    opportunityId: string;
    name: string;
    tagline: string;
    positioning: string;
    valueProposition: string;
    targetSegment: string;
    toneAttributes: readonly string[];
    palette: readonly Record<string, unknown>[];
    typography: Record<string, unknown>;
    permittedClaims?: readonly Record<string, unknown>[];
    prohibitedClaims?: readonly string[];
    nameCandidates?: readonly Record<string, unknown>[];
    domain?: string | null;
  }): Promise<BrandRow> {
    return qOne(
      this.db,
      `INSERT INTO brand_identities (id, company_id, opportunity_id, name, tagline, positioning,
                                     value_proposition, target_segment, tone_attributes, permitted_claims,
                                     prohibited_claims, palette, typography, domain, name_candidates)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13::jsonb,$14,$15::jsonb)
       RETURNING ${BRAND_COLUMNS}`,
      [
        newId('brand'), input.companyId, input.opportunityId, input.name, input.tagline, input.positioning,
        input.valueProposition, input.targetSegment, input.toneAttributes,
        JSON.stringify(input.permittedClaims ?? []), input.prohibitedClaims ?? [],
        JSON.stringify(input.palette), JSON.stringify(input.typography), input.domain ?? null,
        JSON.stringify(input.nameCandidates ?? []),
      ],
      BrandRow,
      'brand',
      input.name,
    );
  }

  async byId(id: string): Promise<BrandRow> {
    return qOne(this.db, `SELECT ${BRAND_COLUMNS} FROM brand_identities WHERE id=$1`, [id], BrandRow, 'brand', id);
  }

  /**
   * Registers a claim together with its substantiation. The advertising-claims
   * checker reads this; a claim absent from it cannot be used in creative.
   */
  async addPermittedClaim(
    id: string,
    claim: { claim: string; substantiation: string; substantiationSourceRef?: string | null; approvedBy?: string | null },
  ): Promise<void> {
    await exec(
      this.db,
      `UPDATE brand_identities
          SET permitted_claims = permitted_claims || $2::jsonb
        WHERE id=$1`,
      [
        id,
        JSON.stringify([
          {
            ...claim,
            substantiationSourceRef: claim.substantiationSourceRef ?? null,
            approvedBy: claim.approvedBy ?? null,
            approvedAt: claim.approvedBy ? new Date().toISOString() : null,
          },
        ]),
      ],
    );
  }

  async setStatus(id: string, status: string): Promise<void> {
    await exec(this.db, `UPDATE brand_identities SET status=$2 WHERE id=$1`, [id, status]);
  }

  async setDomain(id: string, domain: string): Promise<void> {
    await exec(this.db, `UPDATE brand_identities SET domain=$2 WHERE id=$1`, [id, domain]);
  }
}

export class AssetRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    companyId: string;
    brandId?: string | null;
    kind: string;
    url: string;
    mimeType: string;
    generation: Record<string, unknown>;
    widthPx?: number | null;
    heightPx?: number | null;
    bytes?: number | null;
    altText?: string | null;
  }): Promise<string> {
    const row = await qOne(
      this.db,
      `INSERT INTO creative_assets (id, company_id, brand_id, kind, url, mime_type, width_px, height_px,
                                    bytes, generation, alt_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
       RETURNING id`,
      [
        newId('asset'), input.companyId, input.brandId ?? null, input.kind, input.url, input.mimeType,
        input.widthPx ?? null, input.heightPx ?? null, input.bytes ?? null,
        JSON.stringify(input.generation), input.altText ?? null,
      ],
      z.object({ id: z.string() }),
      'asset',
      input.kind,
    );
    return row.id;
  }

  async setStatus(id: string, status: string): Promise<void> {
    await exec(this.db, `UPDATE creative_assets SET status=$2 WHERE id=$1`, [id, status]);
  }

  async attachReview(id: string, reviewId: string): Promise<void> {
    await exec(
      this.db,
      `UPDATE creative_assets SET review_ids = ARRAY(SELECT DISTINCT unnest(review_ids || ARRAY[$2::text])) WHERE id=$1`,
      [id, reviewId],
    );
  }

  async listForBrand(brandId: string, kind?: string): Promise<readonly Record<string, unknown>[]> {
    return q(
      this.db,
      `SELECT id, kind, url, mime_type, width_px, height_px, alt_text, status, generation, created_at
         FROM creative_assets WHERE brand_id=$1 AND ($2::text IS NULL OR kind=$2)
        ORDER BY created_at DESC`,
      [brandId, kind ?? null],
      z.record(z.string(), z.unknown()),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Sites, builds, deployments                                                  */
/* -------------------------------------------------------------------------- */

const SiteRow = z.object({
  id: z.string(),
  company_id: z.string(),
  brand_id: z.string(),
  spec: z.record(z.string(), z.unknown()),
  status: z.string(),
  generator_provider: z.string().nullable(),
  generator_project_id: z.string().nullable(),
  repository_url: z.string().nullable(),
  preview_url: z.string().nullable(),
  production_url: z.string().nullable(),
  hosting_service_id: z.string().nullable(),
  current_deployment_id: z.string().nullable(),
  last_qa_run_id: z.string().nullable(),
});

const DeploymentRow = z.object({
  id: z.string(),
  company_id: z.string(),
  site_id: z.string().nullable(),
  provider: z.string(),
  external_deploy_id: z.string().nullable(),
  service_id: z.string().nullable(),
  environment: z.string(),
  commit_sha: z.string().nullable(),
  status: z.string(),
  url: z.string().nullable(),
  previous_deployment_id: z.string().nullable(),
  gating_qa_run_id: z.string().nullable(),
  started_at: z.date(),
  finished_at: z.date().nullable(),
  logs_url: z.string().nullable(),
  error: z.string().nullable(),
});

export type SiteRow = z.infer<typeof SiteRow>;
export type DeploymentRow = z.infer<typeof DeploymentRow>;

const SITE_COLUMNS = `id, company_id, brand_id, spec, status, generator_provider, generator_project_id,
  repository_url, preview_url, production_url, hosting_service_id, current_deployment_id, last_qa_run_id`;
const DEPLOY_COLUMNS = `id, company_id, site_id, provider, external_deploy_id, service_id, environment,
  commit_sha, status, url, previous_deployment_id, gating_qa_run_id, started_at, finished_at, logs_url, error`;

export class SiteRepository {
  constructor(private readonly pool: DbPool) {}

  async create(input: { companyId: string; brandId: string; spec: SiteSpec }): Promise<SiteRow> {
    return qOne(
      this.pool,
      `INSERT INTO sites (id, company_id, brand_id, spec, status)
       VALUES ($1,$2,$3,$4::jsonb,'spec_drafted') RETURNING ${SITE_COLUMNS}`,
      [newId('site'), input.companyId, input.brandId, JSON.stringify(input.spec)],
      SiteRow,
      'site',
      input.brandId,
    );
  }

  async byId(id: string): Promise<SiteRow> {
    return qOne(this.pool, `SELECT ${SITE_COLUMNS} FROM sites WHERE id=$1`, [id], SiteRow, 'site', id);
  }

  async setStatus(id: string, status: SiteStatus): Promise<void> {
    await exec(this.pool, `UPDATE sites SET status=$2 WHERE id=$1`, [id, status]);
  }

  async updateSpec(id: string, spec: SiteSpec): Promise<SiteRow> {
    return qOne(
      this.pool,
      `UPDATE sites SET spec=$2::jsonb WHERE id=$1 RETURNING ${SITE_COLUMNS}`,
      [id, JSON.stringify(spec)],
      SiteRow,
      'site',
      id,
    );
  }

  async setGenerator(id: string, provider: string, projectId: string, repositoryUrl?: string | null): Promise<void> {
    await exec(
      this.pool,
      `UPDATE sites SET generator_provider=$2, generator_project_id=$3, repository_url=COALESCE($4, repository_url) WHERE id=$1`,
      [id, provider, projectId, repositoryUrl ?? null],
    );
  }

  async setUrls(id: string, urls: { previewUrl?: string | null; productionUrl?: string | null; hostingServiceId?: string | null }): Promise<void> {
    await exec(
      this.pool,
      `UPDATE sites
          SET preview_url = COALESCE($2, preview_url),
              production_url = COALESCE($3, production_url),
              hosting_service_id = COALESCE($4, hosting_service_id)
        WHERE id=$1`,
      [id, urls.previewUrl ?? null, urls.productionUrl ?? null, urls.hostingServiceId ?? null],
    );
  }

  async recordBuild(input: {
    siteId: string;
    reason: 'initial' | 'iteration' | 'defect_fix' | 'content_update';
    provider: string;
    instructions?: string | null;
    externalRef?: string | null;
  }): Promise<string> {
    const row = await qOne(
      this.pool,
      `INSERT INTO site_builds (id, site_id, reason, instructions, provider, external_ref, status)
       VALUES ($1,$2,$3,$4,$5,$6,'running') RETURNING id`,
      [newId('siteBuild'), input.siteId, input.reason, input.instructions ?? null, input.provider, input.externalRef ?? null],
      z.object({ id: z.string() }),
      'site_build',
      input.siteId,
    );
    return row.id;
  }

  async latestSucceededBuild(siteId: string): Promise<{ id: string; status: string } | undefined> {
    return qMaybe(
      this.pool,
      `SELECT id, status FROM site_builds
        WHERE site_id=$1 AND status='succeeded'
        ORDER BY started_at DESC LIMIT 1`,
      [siteId],
      z.object({ id: z.string(), status: z.string() }),
    );
  }

  /** Records the exported file map, proving the code was actually retrieved. */
  async finishBuild(
    buildId: string,
    outcome: { status: 'succeeded' | 'failed' | 'cancelled'; exportedFiles?: Record<string, string> | null; error?: string | null },
  ): Promise<void> {
    await exec(
      this.pool,
      `UPDATE site_builds SET status=$2, exported_files=$3::jsonb, error=$4, finished_at=now() WHERE id=$1`,
      [buildId, outcome.status, outcome.exportedFiles ? JSON.stringify(outcome.exportedFiles) : null, outcome.error ?? null],
    );
  }
}

export class DeploymentRepository {
  constructor(private readonly pool: DbPool) {}

  async start(input: {
    companyId: string;
    siteId?: string | null;
    provider: 'render' | 'lovable';
    environment: 'preview' | 'staging' | 'production';
    serviceId?: string | null;
    externalDeployId?: string | null;
    commitSha?: string | null;
    gatingQaRunId?: string | null;
  }): Promise<DeploymentRow> {
    return withTransaction(this.pool, async (client) => {
      const previous = await qMaybe(
        client,
        `SELECT ${DEPLOY_COLUMNS} FROM deployments
          WHERE company_id=$1 AND environment=$2 AND status='live'
            AND ($3::text IS NULL OR site_id = $3)
          ORDER BY started_at DESC LIMIT 1`,
        [input.companyId, input.environment, input.siteId ?? null],
        DeploymentRow,
      );

      return qOne(
        client,
        `INSERT INTO deployments (id, company_id, site_id, provider, external_deploy_id, service_id,
                                  environment, commit_sha, status, previous_deployment_id, gating_qa_run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10)
         RETURNING ${DEPLOY_COLUMNS}`,
        [
          newId('deployment'), input.companyId, input.siteId ?? null, input.provider,
          input.externalDeployId ?? null, input.serviceId ?? null, input.environment,
          input.commitSha ?? null, previous?.id ?? null, input.gatingQaRunId ?? null,
        ],
        DeploymentRow,
        'deployment',
        input.environment,
      );
    });
  }

  async update(
    id: string,
    patch: { status?: string; url?: string | null; externalDeployId?: string | null; logsUrl?: string | null; error?: string | null },
  ): Promise<DeploymentRow> {
    return qOne(
      this.pool,
      `UPDATE deployments
          SET status = COALESCE($2, status),
              url = COALESCE($3, url),
              external_deploy_id = COALESCE($4, external_deploy_id),
              logs_url = COALESCE($5, logs_url),
              error = COALESCE($6, error),
              finished_at = CASE WHEN $2 IN ('live','failed','canceled','rolled_back') THEN now() ELSE finished_at END
        WHERE id=$1
        RETURNING ${DEPLOY_COLUMNS}`,
      [id, patch.status ?? null, patch.url ?? null, patch.externalDeployId ?? null, patch.logsUrl ?? null, patch.error ?? null],
      DeploymentRow,
      'deployment',
      id,
    );
  }

  async byId(id: string): Promise<DeploymentRow> {
    return qOne(this.pool, `SELECT ${DEPLOY_COLUMNS} FROM deployments WHERE id=$1`, [id], DeploymentRow, 'deployment', id);
  }

  /** The deployment a rollback would restore. */
  async rollbackTarget(id: string): Promise<DeploymentRow | undefined> {
    const current = await this.byId(id);
    if (!current.previous_deployment_id) return undefined;
    return qMaybe(this.pool, `SELECT ${DEPLOY_COLUMNS} FROM deployments WHERE id=$1`, [current.previous_deployment_id], DeploymentRow);
  }

  async currentLive(companyId: string, environment: string, siteId?: string | null): Promise<DeploymentRow | undefined> {
    return qMaybe(
      this.pool,
      `SELECT ${DEPLOY_COLUMNS} FROM deployments
        WHERE company_id=$1 AND environment=$2 AND status='live' AND ($3::text IS NULL OR site_id=$3)
        ORDER BY started_at DESC LIMIT 1`,
      [companyId, environment, siteId ?? null],
      DeploymentRow,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* QA                                                                          */
/* -------------------------------------------------------------------------- */

const QaRunRow = z.object({
  id: z.string(),
  company_id: z.string(),
  site_id: z.string().nullable(),
  deployment_id: z.string().nullable(),
  kind: z.string(),
  provider: z.string(),
  external_project_id: z.string().nullable(),
  external_run_id: z.string().nullable(),
  target_url: z.string(),
  status: z.string(),
  flows_covered: z.array(z.string()),
  defect_counts: z.record(z.string(), z.number()),
  unavailable_reason: z.string().nullable(),
  started_at: z.date().nullable(),
  finished_at: z.date().nullable(),
  evidence_url: z.string().nullable(),
});

const DefectRow = z.object({
  id: z.string(),
  qa_run_id: z.string(),
  provider: z.string(),
  external_id: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  severity: z.string(),
  affected_flow: z.string().nullable(),
  reproduction_steps: z.array(z.string()),
  root_cause: z.string().nullable(),
  suggested_fix: z.string().nullable(),
  evidence_url: z.string().nullable(),
  status: z.string(),
  assigned_role_key: z.string().nullable(),
});

export type QaRunRow = z.infer<typeof QaRunRow>;
export type DefectRow = z.infer<typeof DefectRow>;

const QA_COLUMNS = `id, company_id, site_id, deployment_id, kind, provider, external_project_id,
  external_run_id, target_url, status, flows_covered, defect_counts, unavailable_reason, started_at,
  finished_at, evidence_url`;
const DEFECT_COLUMNS = `id, qa_run_id, provider, external_id, title, description, severity, affected_flow,
  reproduction_steps, root_cause, suggested_fix, evidence_url, status, assigned_role_key`;

export class QaRepository {
  constructor(private readonly pool: DbPool) {}

  async startRun(input: {
    companyId: string;
    siteId?: string | null;
    deploymentId?: string | null;
    kind: QaRunKind;
    provider: string;
    targetUrl: string;
    externalProjectId?: string | null;
  }): Promise<QaRunRow> {
    return qOne(
      this.pool,
      `INSERT INTO qa_runs (id, company_id, site_id, deployment_id, kind, provider, target_url,
                            external_project_id, status, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running', now())
       RETURNING ${QA_COLUMNS}`,
      [
        newId('qaRun'), input.companyId, input.siteId ?? null, input.deploymentId ?? null, input.kind,
        input.provider, input.targetUrl, input.externalProjectId ?? null,
      ],
      QaRunRow,
      'qa_run',
      input.kind,
    );
  }

  /**
   * Records that a check could not run.
   *
   * This is a distinct outcome from "ran and passed", and the release gate
   * treats it as a blocker for production. An unexecuted check must never be
   * reported as a clean one.
   */
  async markProviderUnavailable(input: {
    companyId: string;
    siteId?: string | null;
    deploymentId?: string | null;
    kind: QaRunKind;
    provider: string;
    targetUrl: string;
    reason: string;
  }): Promise<QaRunRow> {
    return qOne(
      this.pool,
      `INSERT INTO qa_runs (id, company_id, site_id, deployment_id, kind, provider, target_url,
                            status, unavailable_reason, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'provider_unavailable',$8, now())
       RETURNING ${QA_COLUMNS}`,
      [
        newId('qaRun'), input.companyId, input.siteId ?? null, input.deploymentId ?? null, input.kind,
        input.provider, input.targetUrl, input.reason,
      ],
      QaRunRow,
      'qa_run',
      input.kind,
    );
  }

  async finishRun(
    id: string,
    outcome: {
      status: 'completed' | 'failed' | 'cancelled';
      flowsCovered?: readonly CriticalFlow[];
      externalRunId?: string | null;
      evidenceUrl?: string | null;
    },
  ): Promise<QaRunRow> {
    return qOne(
      this.pool,
      `UPDATE qa_runs
          SET status=$2, flows_covered=$3, external_run_id=COALESCE($4, external_run_id),
              evidence_url=COALESCE($5, evidence_url), finished_at=now(),
              defect_counts = (
                SELECT COALESCE(jsonb_object_agg(severity, n), '{}'::jsonb)
                  FROM (SELECT severity, COUNT(*)::int AS n FROM defects WHERE qa_run_id = $1 GROUP BY severity) s
              )
        WHERE id=$1
        RETURNING ${QA_COLUMNS}`,
      [id, outcome.status, outcome.flowsCovered ?? [], outcome.externalRunId ?? null, outcome.evidenceUrl ?? null],
      QaRunRow,
      'qa_run',
      id,
    );
  }

  async recordDefect(input: {
    companyId: string;
    qaRunId: string;
    provider: string;
    externalId?: string | null;
    title: string;
    description: string;
    severity: DefectSeverity;
    affectedFlow?: CriticalFlow | null;
    reproductionSteps?: readonly string[];
    rootCause?: string | null;
    suggestedFix?: string | null;
    evidenceUrl?: string | null;
  }): Promise<string> {
    const row = await qOne(
      this.pool,
      `INSERT INTO defects (id, company_id, qa_run_id, provider, external_id, title, description, severity,
                            affected_flow, reproduction_steps, root_cause, suggested_fix, evidence_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (provider, external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET status = CASE WHEN defects.status = 'fixed' THEN 'reopened' ELSE defects.status END
       RETURNING id`,
      [
        newId('defect'), input.companyId, input.qaRunId, input.provider, input.externalId ?? null,
        input.title, input.description, input.severity, input.affectedFlow ?? null,
        input.reproductionSteps ?? [], input.rootCause ?? null, input.suggestedFix ?? null,
        input.evidenceUrl ?? null,
      ],
      z.object({ id: z.string() }),
      'defect',
      input.title,
    );
    return row.id;
  }

  async setDefectStatus(id: string, status: string, assignedRoleKey?: string | null): Promise<void> {
    await exec(
      this.pool,
      `UPDATE defects SET status=$2, assigned_role_key=COALESCE($3, assigned_role_key) WHERE id=$1`,
      [id, status, assignedRoleKey ?? null],
    );
  }

  async openDefects(companyId: string, siteId?: string | null): Promise<readonly DefectRow[]> {
    return q(
      this.pool,
      `SELECT ${DEFECT_COLUMNS.split(',').map((c) => `d.${c.trim()}`).join(', ')}
         FROM defects d
         JOIN qa_runs r ON r.id = d.qa_run_id
        WHERE d.company_id=$1
          AND d.status IN ('open','reopened','assigned')
          AND ($2::text IS NULL OR r.site_id = $2)
        ORDER BY CASE d.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
      [companyId, siteId ?? null],
      DefectRow,
    );
  }

  async runsForDeployment(deploymentId: string): Promise<readonly QaRunRow[]> {
    return q(this.pool, `SELECT ${QA_COLUMNS} FROM qa_runs WHERE deployment_id=$1 ORDER BY started_at`, [deploymentId], QaRunRow);
  }

  async runsForSite(siteId: string, limit = 20): Promise<readonly QaRunRow[]> {
    return q(this.pool, `SELECT ${QA_COLUMNS} FROM qa_runs WHERE site_id=$1 ORDER BY created_at DESC LIMIT $2`, [siteId, limit], QaRunRow);
  }

  /**
   * Evaluates the release gate from persisted evidence.
   *
   * Reads the runs and open defects rather than accepting a caller's summary,
   * so the verdict always reflects what is actually recorded.
   */
  async evaluateGate(
    companyId: string,
    siteId: string,
    deploymentId: string,
    environment: 'preview' | 'staging' | 'production',
  ): Promise<ReturnType<typeof evaluateReleaseGate>> {
    const runs = await this.runsForDeployment(deploymentId);
    const defects = await this.openDefects(companyId, siteId);

    return evaluateReleaseGate({
      environment,
      runs: runs.map((r) => ({
        kind: r.kind as QaRunKind,
        status: r.status as QaRunRow['status'] & ('queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'provider_unavailable'),
        flowsCovered: r.flows_covered as CriticalFlow[],
        unavailableReason: r.unavailable_reason,
      })),
      openDefects: defects.map((d) => ({
        severity: d.severity as DefectSeverity,
        affectedFlow: (d.affected_flow as CriticalFlow | null) ?? null,
        status: d.status as Defect['status'],
      })),
      requiredFlows: environment === 'production' ? [...CRITICAL_FLOWS] : ['homepage_loads', 'product_page_loads'],
      requiredRunKinds: environment === 'production' ? PRODUCTION_REQUIRED_RUN_KINDS : ['browser_e2e'],
    });
  }

  /**
   * Records a production release only when the gate actually passes.
   *
   * Re-evaluating here rather than trusting the caller means a bug in an agent
   * cannot promote a broken storefront: the gate is checked at the write, which
   * is the last point before real customers see it.
   */
  async promoteToProduction(input: {
    companyId: string;
    siteId: string;
    deploymentId: string;
    url: string;
  }): Promise<{ promoted: boolean; gate: ReturnType<typeof evaluateReleaseGate> }> {
    const gate = await this.evaluateGate(input.companyId, input.siteId, input.deploymentId, 'production');
    if (gate.verdict === 'block') {
      return { promoted: false, gate };
    }

    const gatingRun = (await this.runsForDeployment(input.deploymentId)).find(
      (r) => r.kind === 'autonomous_exploration' && r.status === 'completed',
    );
    if (!gatingRun) {
      throw new ConflictError(
        'Release gate passed but no completed autonomous QA run is on record for this deployment; refusing to promote.',
        { deploymentId: input.deploymentId },
      );
    }

    await withTransaction(this.pool, async (client) => {
      await exec(
        client,
        `UPDATE deployments SET status='live', url=$2, gating_qa_run_id=$3, finished_at=now() WHERE id=$1`,
        [input.deploymentId, input.url, gatingRun.id],
      );
      await exec(
        client,
        `UPDATE sites SET status='production_deployed', production_url=$2, current_deployment_id=$3, last_qa_run_id=$4 WHERE id=$1`,
        [input.siteId, input.url, input.deploymentId, gatingRun.id],
      );
    });

    return { promoted: true, gate };
  }
}

/* -------------------------------------------------------------------------- */
/* Legal documents                                                             */
/* -------------------------------------------------------------------------- */

export class LegalDocumentRepository {
  constructor(private readonly db: Queryable) {}

  async publish(input: {
    companyId: string;
    siteId?: string | null;
    kind: string;
    bodyMarkdown: string;
    /** Snapshot of the config the document was generated from. */
    generatedFrom: Record<string, unknown>;
  }): Promise<{ id: string; version: number }> {
    const row = await qOne(
      this.db,
      `INSERT INTO legal_documents (id, company_id, site_id, kind, version, body_markdown, generated_from)
       SELECT $1, $2, $3, $4, COALESCE(MAX(version), 0) + 1, $5, $6::jsonb
         FROM legal_documents WHERE company_id = $2 AND kind = $4
       RETURNING id, version`,
      [
        newId('document'), input.companyId, input.siteId ?? null, input.kind,
        input.bodyMarkdown, JSON.stringify(input.generatedFrom),
      ],
      z.object({ id: z.string(), version: z.number() }),
      'legal_document',
      input.kind,
    );
    return row;
  }

  /** Only a named human may mark a document reviewed by counsel. */
  async recordReview(id: string, status: 'internal_reviewed' | 'counsel_reviewed', reviewedBy: string): Promise<void> {
    await exec(
      this.db,
      `UPDATE legal_documents SET review_status=$2, reviewed_by=$3, reviewed_at=now() WHERE id=$1`,
      [id, status, reviewedBy],
    );
  }

  async current(companyId: string, kind: string): Promise<Record<string, unknown> | undefined> {
    return qMaybe(
      this.db,
      `SELECT id, kind, version, body_markdown, review_status, reviewed_by, reviewed_at, published_url, created_at
         FROM legal_documents WHERE company_id=$1 AND kind=$2 ORDER BY version DESC LIMIT 1`,
      [companyId, kind],
      z.record(z.string(), z.unknown()),
    );
  }

  async listCurrent(companyId: string): Promise<readonly Record<string, unknown>[]> {
    return q(
      this.db,
      `SELECT DISTINCT ON (kind) id, kind, version, review_status, reviewed_by, published_url, created_at
         FROM legal_documents WHERE company_id=$1 ORDER BY kind, version DESC`,
      [companyId],
      z.record(z.string(), z.unknown()),
    );
  }

  async setPublishedUrl(id: string, url: string): Promise<void> {
    await exec(this.db, `UPDATE legal_documents SET published_url=$2, effective_from=COALESCE(effective_from, now()) WHERE id=$1`, [id, url]);
  }
}

export class BuildRepositories {
  readonly brands: BrandRepository;
  readonly assets: AssetRepository;
  readonly sites: SiteRepository;
  readonly deployments: DeploymentRepository;
  readonly qa: QaRepository;
  readonly legal: LegalDocumentRepository;

  constructor(pool: DbPool) {
    this.brands = new BrandRepository(pool);
    this.assets = new AssetRepository(pool);
    this.sites = new SiteRepository(pool);
    this.deployments = new DeploymentRepository(pool);
    this.qa = new QaRepository(pool);
    this.legal = new LegalDocumentRepository(pool);
  }
}
