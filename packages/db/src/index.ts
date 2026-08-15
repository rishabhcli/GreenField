export * from './pool.js';
export * from './migrate.js';
export * from './health.js';

export * from './repositories/idempotency.js';
export * from './repositories/audit.js';
export * from './repositories/governance.js';
export * from './repositories/webhooks.js';
export * from './repositories/verifications.js';
export * from './repositories/companies.js';
export * from './repositories/research.js';
export * from './repositories/sourcing.js';
export * from './repositories/build.js';
export * from './repositories/commerce.js';
export * from './repositories/growth.js';
export * from './repositories/finance.js';
export * from './repositories/agents.js';

import type { DbPool } from './pool.js';
import { AuditRepository } from './repositories/audit.js';
import { AgentRepositories } from './repositories/agents.js';
import { BuildRepositories } from './repositories/build.js';
import { CommerceRepositories } from './repositories/commerce.js';
import { CompanyRepository, LoopCycleRepository } from './repositories/companies.js';
import { GovernanceRepositories } from './repositories/governance.js';
import { GrowthRepositories } from './repositories/growth.js';
import { IdempotencyRepository } from './repositories/idempotency.js';
import { LedgerRepository } from './repositories/finance.js';
import { ResearchRepositories } from './repositories/research.js';
import { SourcingRepositories } from './repositories/sourcing.js';
import { VerificationRepository } from './repositories/verifications.js';
import { WebhookRepository } from './repositories/webhooks.js';

/**
 * Every repository, constructed once and shared. Services take this rather than
 * a raw pool so no service can reach around the repository layer and issue ad
 * hoc SQL that bypasses an invariant.
 */
export class Repositories {
  readonly companies: CompanyRepository;
  readonly loop: LoopCycleRepository;
  readonly governance: GovernanceRepositories;
  readonly audit: AuditRepository;
  readonly idempotency: IdempotencyRepository;
  readonly webhooks: WebhookRepository;
  readonly verifications: VerificationRepository;
  readonly research: ResearchRepositories;
  readonly sourcing: SourcingRepositories;
  readonly build: BuildRepositories;
  readonly commerce: CommerceRepositories;
  readonly growth: GrowthRepositories;
  readonly ledger: LedgerRepository;
  readonly agents: AgentRepositories;

  constructor(readonly pool: DbPool) {
    this.companies = new CompanyRepository(pool);
    this.loop = new LoopCycleRepository(pool);
    this.governance = new GovernanceRepositories(pool);
    this.audit = new AuditRepository(pool);
    this.idempotency = new IdempotencyRepository(pool);
    this.webhooks = new WebhookRepository(pool);
    this.verifications = new VerificationRepository(pool);
    this.research = new ResearchRepositories(pool);
    this.sourcing = new SourcingRepositories(pool);
    this.build = new BuildRepositories(pool);
    this.commerce = new CommerceRepositories(pool);
    this.growth = new GrowthRepositories(pool);
    this.ledger = new LedgerRepository(pool);
    this.agents = new AgentRepositories(pool);
  }
}
