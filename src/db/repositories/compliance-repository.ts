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
    .set({ supersededAt: new Date() })
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

/** The single live approval covering a wallet, if one exists and has not expired. */
export async function findActiveApproval(
  executor: Executor,
  input: { walletId: string; assetId: string | null; at: Date },
): Promise<ComplianceDecisionRecord | null> {
  const [row] = await executor
    .select()
    .from(complianceDecisions)
    .where(
      and(
        eq(complianceDecisions.walletId, input.walletId),
        eq(complianceDecisions.status, 'APPROVED'),
        isNull(complianceDecisions.supersededAt),
        sql`${complianceDecisions.validFrom} <= ${input.at}`,
        sql`${complianceDecisions.validUntil} > ${input.at}`,
        input.assetId === null
          ? isNull(complianceDecisions.assetId)
          : sql`(${complianceDecisions.assetId} IS NULL OR ${complianceDecisions.assetId} = ${input.assetId})`,
      ),
    )
    .orderBy(desc(complianceDecisions.decidedAt))
    .limit(1);
  return row ?? null;
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
