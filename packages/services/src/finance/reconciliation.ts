/**
 * Reconciliation — the check that catches the system lying to itself.
 *
 * Everything else in the money path is written by code that believes its own
 * inputs. Reconciliation is the one place that goes back to the provider, asks
 * what *it* thinks happened, and compares. That makes it the structural defence
 * against the failure this project is built to avoid: a database full of
 * plausible-looking payments that no processor ever saw.
 *
 * It never self-heals. A discrepancy is recorded and escalated; silently
 * "correcting" the local row to match the provider would destroy the very
 * evidence that something went wrong.
 */

import { reconcile, type ReconciliationResult } from '@foundry/core';
import { getLogger, metrics } from '@foundry/obs';
import { optionalCapability, type ServiceDeps } from '../deps.js';
import { LedgerService } from './ledger.js';

/** What reconciliation needs from a payment provider. */
export interface ReconcilableProvider {
  listPayments(input: { since: Date; limit?: number }): Promise<
    readonly { externalId: string; amountMinor: number; currency: string; status: string; feeMinor: number | null; netMinor: number | null }[]
  >;
}

export interface ReconciliationReport {
  readonly provider: string;
  readonly windowDays: number;
  readonly result: ReconciliationResult;
  /** Fee corrections posted to the ledger as a result of this sweep. */
  readonly feesBackfilled: number;
  readonly skippedReason?: string;
}

export class ReconciliationService {
  private readonly ledger: LedgerService;

  constructor(private readonly deps: ServiceDeps) {
    this.ledger = new LedgerService(deps);
  }

  /**
   * Reconciles one provider over a trailing window.
   *
   * Runs nightly from cron. The window is deliberately longer than the
   * provider's own settlement delay so a late-arriving fee is still caught.
   */
  async run(companyId: string, provider: 'stripe', windowDays = 14): Promise<ReconciliationReport> {
    const log = getLogger();
    const adapter = optionalCapability<ReconcilableProvider>(this.deps, 'payments.webhooks');

    if (!adapter || typeof adapter.listPayments !== 'function') {
      const status = this.deps.providers.forCapability('payments.webhooks').status;
      const reason = status.remediation ?? `payment provider is ${status.state}`;
      // Not a clean result — an unrun reconciliation is not a passing one, and
      // reporting it as such would be exactly the false assurance this service
      // exists to prevent.
      log.warn({ provider, reason }, 'reconciliation skipped: provider unavailable');
      return {
        provider,
        windowDays,
        result: emptyUnrunResult(),
        feesBackfilled: 0,
        skippedReason: reason,
      };
    }

    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const providerPayments = await adapter.listPayments({ since, limit: 1000 });
    const localPayments = await this.deps.repos.commerce.payments.listForReconciliation(companyId, provider, since);

    const result = reconcile({
      providerPayments: providerPayments.map((p) => ({
        externalId: p.externalId,
        amountMinor: p.amountMinor,
        currency: p.currency,
        status: p.status,
      })),
      localPayments: localPayments.map((p) => ({
        externalId: p.external_id,
        amountMinor: p.amount_minor,
        currency: p.currency,
        status: p.status,
        orderId: p.order_id,
      })),
    });

    /* ------------------------------------------------------------------ */
    /* Fee backfill                                                        */
    /* ------------------------------------------------------------------ */
    // The one correction this sweep is allowed to make: filling in a fee the
    // provider had not reported at charge time. This adds knowledge, it does
    // not overwrite a contradicting local value.
    let feesBackfilled = 0;
    for (const remote of providerPayments) {
      if (remote.feeMinor === null) continue;
      const local = localPayments.find((p) => p.external_id === remote.externalId);
      if (!local || local.fee_minor !== null) continue;

      await this.deps.repos.commerce.payments.upsert({
        companyId,
        orderId: local.order_id,
        provider,
        externalId: remote.externalId,
        status: remote.status,
        amountMinor: remote.amountMinor,
        currency: remote.currency,
        feeMinor: remote.feeMinor,
        netMinor: remote.netMinor,
      });

      await this.ledger.postSpend({
        companyId,
        account: 'infrastructure_spend',
        amountMinor: remote.feeMinor,
        currency: remote.currency,
        description: `late-reported processor fee for ${remote.externalId}`,
        sourceType: 'payment_fee',
        sourceRefId: remote.externalId,
      });
      feesBackfilled += 1;
    }

    /* ------------------------------------------------------------------ */
    /* Escalation                                                          */
    /* ------------------------------------------------------------------ */
    if (!result.clean) {
      metrics.providerErrors.inc({ provider, category: 'reconciliation_discrepancy' }, discrepancyCount(result));

      // A local payment with no provider counterpart is the signature of
      // fabricated data. It is escalated at the highest severity available.
      if (result.missingAtProvider.length > 0) {
        log.error(
          { provider, missingAtProvider: result.missingAtProvider },
          'payments exist locally with no counterpart at the provider',
        );
      }
      if (result.missingLocally.length > 0) {
        log.error(
          { provider, missingLocally: result.missingLocally },
          'provider reports payments this system never booked',
        );
      }

      await this.deps.repos.audit.append({
        companyId,
        kind: 'compliance_check',
        actorId: 'service:reconciliation',
        actorKind: 'system_job',
        action: `reconciliation discrepancy against ${provider}`,
        subjectType: 'reconciliation',
        subjectRefId: `${provider}:${since.toISOString()}`,
        outcome: 'failure',
        detail: {
          matched: result.matched,
          missingLocally: result.missingLocally,
          missingAtProvider: result.missingAtProvider,
          amountMismatches: result.amountMismatches,
          statusMismatches: result.statusMismatches,
        },
      });
    } else {
      log.info({ provider, matched: result.matched, feesBackfilled }, 'reconciliation clean');
    }

    return { provider, windowDays, result, feesBackfilled };
  }

  /**
   * Verifies the ledger itself balances.
   *
   * Every transaction must sum to zero. A non-zero sum means an entry was
   * written outside `writeTransaction`, which the immutability triggers should
   * make impossible — so a hit here is a serious integrity finding, not a
   * rounding issue.
   */
  async verifyLedgerIntegrity(
    companyId: string,
  ): Promise<{ balanced: boolean; offenders: readonly { transactionId: string; netMinor: number }[] }> {
    const unbalanced = await this.deps.repos.ledger.findUnbalancedTransactions(companyId);
    if (unbalanced.length > 0) {
      getLogger().error({ companyId, unbalanced }, 'ledger contains unbalanced transactions');
      await this.deps.repos.audit.append({
        companyId,
        kind: 'compliance_check',
        actorId: 'service:reconciliation',
        actorKind: 'system_job',
        action: 'ledger integrity check',
        subjectType: 'ledger',
        subjectRefId: companyId,
        outcome: 'failure',
        detail: { unbalanced },
      });
    }
    return {
      balanced: unbalanced.length === 0,
      offenders: unbalanced.map((u) => ({ transactionId: u.transactionId, netMinor: u.netMinor })),
    };
  }
}

/**
 * The result of a reconciliation that could not run.
 *
 * `clean: false` is the important field. An unrun check is an unknown, and an
 * unknown must never read as a pass.
 */
function emptyUnrunResult(): ReconciliationResult {
  return {
    matched: 0,
    missingLocally: [],
    missingAtProvider: [],
    amountMismatches: [],
    statusMismatches: [],
    clean: false,
  };
}

function discrepancyCount(result: ReconciliationResult): number {
  return (
    result.missingLocally.length +
    result.missingAtProvider.length +
    result.amountMismatches.length +
    result.statusMismatches.length
  );
}
