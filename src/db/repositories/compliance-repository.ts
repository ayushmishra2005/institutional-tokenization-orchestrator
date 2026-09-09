import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Executor } from '../pool.js';
import { complianceDecisions } from '../schema/index.js';

export interface ComplianceDecisionRecord {
  readonly id: string;
  readonly walletId: string;
  readonly assetId: string | null;
  readonly status: string;
  readonly subjectReference: string;
  readonly provider: string;
  readonly providerReference: string;
  readonly validFrom: Date;
  readonly validUntil: Date;
  readonly decidedAt: Date;
  readonly decidedBy: string;
  readonly chainSyncStatus: string;
  readonly chainSyncTxHash: string | null;
  readonly supersededAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revocationReason: string | null;
  readonly createdAt: Date;
}

export interface InsertComplianceDecisionInput {
  readonly walletId: string;
  readonly assetId: string | null;
  readonly status: string;
  readonly subjectReference: string;
  readonly provider: string;
  readonly providerReference: string;
  readonly validFrom: Date;
  readonly validUntil: Date;
  readonly decidedAt: Date;
  readonly decidedBy: string;
  readonly revokedAt?: Date;
  readonly revocationReason?: string;
}

/**
 * Supersedes any live APPROVED decision for the wallet scope before inserting the new
 * one. The partial unique index permits only one live approval at a time, so this must
 * happen inside the caller's transaction.
 */
export async function supersedeActiveDecisions(
  executor: Executor,
  walletId: string,
  assetId: string | null,
): Promise<void> {
  await executor
    .update(complianceDecisions)
    .set({ supersededAt: sql`now()` })
    .where(
      and(
        eq(complianceDecisions.walletId, walletId),
        assetId === null
          ? isNull(complianceDecisions.assetId)
          : eq(complianceDecisions.assetId, assetId),
        eq(complianceDecisions.status, 'APPROVED'),
        isNull(complianceDecisions.supersededAt),
      ),
    );
}

export async function insertComplianceDecision(
  executor: Executor,
  input: InsertComplianceDecisionInput,
): Promise<ComplianceDecisionRecord> {
  const [row] = await executor.insert(complianceDecisions).values(input).returning();
  if (row === undefined) throw new Error('failed to insert compliance decision');
  return row;
}

export async function markComplianceChainSynced(
  executor: Executor,
  input: { decisionId: string; transactionHash: string },
): Promise<void> {
  await executor
    .update(complianceDecisions)
    .set({ chainSyncStatus: 'SYNCED', chainSyncTxHash: input.transactionHash.toLowerCase() })
    .where(eq(complianceDecisions.id, input.decisionId));
}

export async function markComplianceChainSyncFailed(
  executor: Executor,
  decisionId: string,
): Promise<void> {
  await executor
    .update(complianceDecisions)
    .set({ chainSyncStatus: 'FAILED' })
    .where(eq(complianceDecisions.id, decisionId));
}

/**
 * The single live approval covering a wallet, if one exists and has not expired.
 *
 * Validity is a half-open window, `valid_from <= now() < valid_until`, evaluated by
 * PostgreSQL: the timestamps are database-generated, so an application clock drifting
 * from the database must not decide whether an approval may authorise execution.
 */
export async function findActiveApproval(
  executor: Executor,
  input: { walletId: string; assetId: string | null },
): Promise<ComplianceDecisionRecord | null> {
  const [row] = await executor
    .select()
    .from(complianceDecisions)
    .where(
      and(
        eq(complianceDecisions.walletId, input.walletId),
        eq(complianceDecisions.status, 'APPROVED'),
        isNull(complianceDecisions.supersededAt),
        sql`${complianceDecisions.validFrom} <= now()`,
        sql`now() < ${complianceDecisions.validUntil}`,
        input.assetId === null
          ? isNull(complianceDecisions.assetId)
          : sql`(${complianceDecisions.assetId} IS NULL OR ${complianceDecisions.assetId} = ${input.assetId})`,
      ),
    )
    .orderBy(desc(complianceDecisions.decidedAt))
    .limit(1);
  return row ?? null;
}

export async function findLatestRevocation(
  executor: Executor,
  walletId: string,
  assetId: string | null,
): Promise<ComplianceDecisionRecord | null> {
  const [row] = await executor
    .select()
    .from(complianceDecisions)
    .where(
      and(
        eq(complianceDecisions.walletId, walletId),
        eq(complianceDecisions.status, 'REVOKED'),
        assetId === null
          ? isNull(complianceDecisions.assetId)
          : eq(complianceDecisions.assetId, assetId),
      ),
    )
    .orderBy(desc(complianceDecisions.decidedAt))
    .limit(1);
  return row ?? null;
}

/** Live approvals whose validity window has closed, judged by the same database clock. */
export async function findLapsedApprovals(
  executor: Executor,
  limit: number,
): Promise<ComplianceDecisionRecord[]> {
  return executor
    .select()
    .from(complianceDecisions)
    .where(
      and(
        eq(complianceDecisions.status, 'APPROVED'),
        isNull(complianceDecisions.supersededAt),
        sql`${complianceDecisions.validUntil} <= now()`,
      ),
    )
    .limit(limit);
}

export async function markDecisionExpired(executor: Executor, decisionId: string): Promise<void> {
  await executor
    .update(complianceDecisions)
    .set({ status: 'EXPIRED', supersededAt: sql`now()` })
    .where(eq(complianceDecisions.id, decisionId));
}

export async function findDecisionById(
  executor: Executor,
  id: string,
): Promise<ComplianceDecisionRecord | null> {
  const [row] = await executor
    .select()
    .from(complianceDecisions)
    .where(eq(complianceDecisions.id, id))
    .limit(1);
  return row ?? null;
}
