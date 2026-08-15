/**
 * Re-exports from `@foundry/core` used across the agent runtime.
 *
 * A single import surface keeps the agent modules readable and makes it obvious
 * which domain primitives the runtime is allowed to reach for.
 */

export {
  MODEL_BY_TIER,
  ORG_CHART,
  PolicyDeniedError,
  ValidationError,
  NotFoundError,
  ConflictError,
  evaluatePolicy,
  capabilityAvailableForAuthority,
  newId,
  roleByKey,
  specialistsOf,
  managers,
  validateOrgChart,
  toFoundryError,
  describeError,
  type ActorKind,
  type AgentRunStatus,
  type Authority,
  type BudgetScope,
  type Capability,
  type ModelTier,
  type PolicyEvaluation,
  type RoleDefinition,
} from '@foundry/core';

export { toActor } from '@foundry/db';
