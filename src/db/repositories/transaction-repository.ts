import { and, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../pool.js';
import { chainObservations, signerNonces, transactionAttempts } from '../schema/index.js';
import { AppError, ErrorCode } from '../../domain/errors.js';

export const AttemptStatus = {
  PREPARED: 'PREPARED',
  SIGNED: 'SIGNED',
  BROADCASTING: 'BROADCASTING',
  BROADCAST_UNKNOWN: 'BROADCAST_UNKNOWN',
  SUBMITTED: 'SUBMITTED',
  INCLUDED: 'INCLUDED',
  CONFIRMED: 'CONFIRMED',
  REVERTED: 'REVERTED',
  FAILED: 'FAILED',
  /** Superseded by a replacement carrying the same nonce. */
  REPLACED: 'REPLACED',
} as const;

export type AttemptStatus = (typeof AttemptStatus)[keyof typeof AttemptStatus];

export type AttemptPurpose = 'DEPLOY_TOKEN' | 'SET_ELIGIBILITY' | 'MINT' | 'NONCE_RECOVERY';

export interface TransactionAttemptRecord {
  readonly id: string;
  readonly operationId: string | null;
  readonly assetId: string | null;
  readonly walletId: string | null;
  readonly purpose: string;
  readonly chainId: number;
  readonly fromAddress: string;
  readonly toAddress: string | null;
  readonly nonce: number;
  readonly value: string;
  readonly data: string;
  readonly gasLimit: number;
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
  readonly requestHash: string;
  readonly signedRawTransaction: string | null;
  readonly transactionHash: string | null;
  readonly status: string;
  readonly broadcastAttempts: number;
  readonly blockNumber: number | null;
  readonly blockHash: string | null;
  readonly gasUsed: number | null;
  readonly receiptStatus: number | null;
  readonly contractAddress: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly intentFingerprint: string | null;
  readonly replacesAttemptId: string | null;
  readonly replacedByAttemptId: string | null;
  readonly replacementReason: string | null;
  readonly replacementNumber: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Reserves the next nonce for a signer lane.
 *
 * Serialised in PostgreSQL: the row is locked, compared against the chain's own count,
 * and incremented in one transaction. Two concurrent reservations therefore always get
 * distinct nonces, and the UNIQUE (chain_id, from_address, nonce) constraint on
 * transaction_attempts catches any residual mistake.
 *
 * @param chainNonce `getTransactionCount(signer, 'latest')`, read *before* this
 *        transaction was opened - never fetch over RPC while holding a lock.
 */
export async function reserveNonce(
  tx: Transaction,
  input: { chainId: number; signerAddress: string; chainNonce: number },
): Promise<number> {
  const signerAddress = input.signerAddress.toLowerCase();

  // Create the lane first if it is missing. SELECT ... FOR UPDATE locks nothing when no
  // row exists, so without this every concurrent first-time reservation would race to
  // INSERT. Concurrent inserters block here and then observe the committed lane.
  await tx
    .insert(signerNonces)
    .values({ chainId: input.chainId, signerAddress, nextNonce: input.chainNonce })
    .onConflictDoNothing({ target: [signerNonces.chainId, signerNonces.signerAddress] });

  const [existing] = await tx
    .select()
    .from(signerNonces)
    .where(
      and(eq(signerNonces.chainId, input.chainId), eq(signerNonces.signerAddress, signerAddress)),
    )
    .limit(1)
    .for('update');

  if (existing === undefined) throw new Error('signer nonce lane vanished after insert');

  // The chain may legitimately be ahead of us after a restart with unrecorded
  // transactions, but it must never be behind: that would mean PostgreSQL believes it
  // issued nonces the chain has not seen, so an in-flight transaction is unaccounted
  // for. Halt rather than guess and risk double-spending a nonce.
  if (input.chainNonce > existing.nextNonce) {
    throw new AppError(
      ErrorCode.NONCE_DIVERGENCE,
      'chain nonce is ahead of the reserved nonce; the signer was used outside this application',
      {
        details: {
          chainNonce: input.chainNonce,
          reservedNextNonce: existing.nextNonce,
          signerAddress,
        },
      },
    );
  }

  const nonce = existing.nextNonce;
  await tx
    .update(signerNonces)
    .set({ nextNonce: nonce + 1, updatedAt: new Date() })
    .where(
      and(eq(signerNonces.chainId, input.chainId), eq(signerNonces.signerAddress, signerAddress)),
    );
  return nonce;
}

export async function readReservedNonce(
  executor: Executor,
  input: { chainId: number; signerAddress: string },
): Promise<number | null> {
  const [row] = await executor
    .select()
    .from(signerNonces)
    .where(
      and(
        eq(signerNonces.chainId, input.chainId),
        eq(signerNonces.signerAddress, input.signerAddress.toLowerCase()),
      ),
    )
    .limit(1);
  return row?.nextNonce ?? null;
}

export interface InsertAttemptInput {
  readonly operationId: string | null;
  readonly assetId: string | null;
  readonly walletId: string | null;
  readonly purpose: AttemptPurpose;
  readonly chainId: number;
  readonly fromAddress: string;
  readonly toAddress: string | null;
  readonly nonce: number;
  readonly data: string;
  readonly gasLimit: number;
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
  readonly requestHash: string;
  readonly intentFingerprint: string;
  readonly replacesAttemptId?: string;
  readonly replacementReason?: string;
  readonly replacementNumber?: number;
}

export async function insertPreparedAttempt(
  executor: Executor,
  input: InsertAttemptInput,
): Promise<TransactionAttemptRecord> {
  const [row] = await executor
    .insert(transactionAttempts)
    .values({
      ...input,
      fromAddress: input.fromAddress.toLowerCase(),
      toAddress: input.toAddress === null ? null : input.toAddress.toLowerCase(),
      data: input.data.toLowerCase(),
      value: '0',
      status: AttemptStatus.PREPARED,
    })
    .returning();
  if (row === undefined) throw new Error('failed to insert transaction attempt');
  return row;
}

/**
 * Persists the exact signed bytes and their hash.
 *
 * This must commit BEFORE any broadcast: if the process dies immediately afterwards,
 * recovery can look the hash up on chain or rebroadcast the identical bytes, instead of
 * constructing a second transaction for the same money.
 */
export async function persistSignedAttempt(
  executor: Executor,
  input: { attemptId: string; signedRawTransaction: string; transactionHash: string },
): Promise<void> {
  await executor
    .update(transactionAttempts)
    .set({
      signedRawTransaction: input.signedRawTransaction.toLowerCase(),
      transactionHash: input.transactionHash.toLowerCase(),
      status: AttemptStatus.SIGNED,
      updatedAt: new Date(),
    })
    .where(eq(transactionAttempts.id, input.attemptId));
}

export async function updateAttemptStatus(
  executor: Executor,
  input: {
    attemptId: string;
    status: AttemptStatus;
    errorCode?: string | null;
    errorMessage?: string | null;
    incrementBroadcastAttempts?: boolean;
  },
): Promise<void> {
  await executor
    .update(transactionAttempts)
    .set({
      status: input.status,
      updatedAt: new Date(),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.errorMessage === undefined
        ? {}
        : { errorMessage: input.errorMessage === null ? null : input.errorMessage.slice(0, 2000) }),
      ...(input.incrementBroadcastAttempts === true
        ? { broadcastAttempts: sql`${transactionAttempts.broadcastAttempts} + 1` }
        : {}),
    })
    .where(eq(transactionAttempts.id, input.attemptId));
}

/**
 * Records receipt data for an attempt.
 *
 * Guarded against downgrading an already-settled attempt: the worker and the recovery
 * sweep can observe the same receipt concurrently, and the later observation must not
 * roll CONFIRMED back to INCLUDED.
 */
export async function recordReceipt(
  executor: Executor,
  input: {
    attemptId: string;
    status: AttemptStatus;
    blockNumber: number;
    blockHash: string;
    gasUsed: number;
    receiptStatus: number;
    contractAddress: string | null;
  },
): Promise<void> {
  await executor
    .update(transactionAttempts)
    .set({
      status: input.status,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash.toLowerCase(),
      gasUsed: input.gasUsed,
      receiptStatus: input.receiptStatus,
      contractAddress: input.contractAddress === null ? null : input.contractAddress.toLowerCase(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(transactionAttempts.id, input.attemptId),
        notInArray(transactionAttempts.status, [AttemptStatus.CONFIRMED, AttemptStatus.REVERTED]),
      ),
    );
}

export async function findAttemptById(
  executor: Executor,
  id: string,
): Promise<TransactionAttemptRecord | null> {
  const [row] = await executor
    .select()
    .from(transactionAttempts)
    .where(eq(transactionAttempts.id, id))
    .limit(1);
  return row ?? null;
}

export async function findLatestAttemptForOperation(
  executor: Executor,
  operationId: string,
): Promise<TransactionAttemptRecord | null> {
  const [row] = await executor
    .select()
    .from(transactionAttempts)
    .where(eq(transactionAttempts.operationId, operationId))
    .orderBy(desc(transactionAttempts.createdAt))
    .limit(1);
  return row ?? null;
}

export async function listAttemptsForOperation(
  executor: Executor,
  operationId: string,
): Promise<TransactionAttemptRecord[]> {
  return executor
    .select()
    .from(transactionAttempts)
    .where(eq(transactionAttempts.operationId, operationId))
    .orderBy(transactionAttempts.createdAt);
}

export type ObservationKind =
  | 'RECEIPT'
  | 'BLOCK_CANONICALITY'
  | 'FINALITY'
  | 'MINT_EVENT'
  | 'REFERENCE_CONSUMED'
  | 'RECIPIENT_BALANCE'
  | 'TOTAL_SUPPLY'
  | 'CHAIN_IDENTITY'
  | 'CONTRACT_CODE'
  | 'TOKEN_METADATA'
  | 'ELIGIBILITY_WINDOW';

export type ObservationSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface ObservationInput {
  readonly operationId: string | null;
  readonly transactionAttemptId: string | null;
  readonly kind: ObservationKind;
  readonly chainId: number;
  readonly blockNumber: number | null;
  readonly blockHash: string | null;
  readonly transactionHash: string | null;
  readonly matched: boolean;
  /** False when the block this observation describes is not on the canonical chain. */
  readonly canonical?: boolean;
  readonly severity: ObservationSeverity;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly detail: string | null;
}

export async function recordObservation(
  executor: Executor,
  input: ObservationInput,
): Promise<void> {
  await executor.insert(chainObservations).values({
    ...input,
    transactionHash: input.transactionHash === null ? null : input.transactionHash.toLowerCase(),
    blockHash: input.blockHash === null ? null : input.blockHash.toLowerCase(),
    expected: input.expected ?? null,
    actual: input.actual ?? null,
    // A matched observation is evidence, not a finding, so it is closed on arrival.
    status: input.matched ? 'RESOLVED' : 'OPEN',
    resolvedAt: input.matched ? new Date() : null,
  });
}

/** Unresolved reconciliation findings, newest first. */
export async function listOpenFindings(
  executor: Executor,
  limit: number,
): Promise<(typeof chainObservations.$inferSelect)[]> {
  return executor
    .select()
    .from(chainObservations)
    .where(eq(chainObservations.status, 'OPEN'))
    .orderBy(desc(chainObservations.observedAt))
    .limit(limit);
}

export async function countOpenFindingsBySeverity(
  executor: Executor,
): Promise<{ severity: string; count: number }[]> {
  const rows = await executor
    .select({ severity: chainObservations.severity, count: sql<string>`count(*)` })
    .from(chainObservations)
    .where(eq(chainObservations.status, 'OPEN'))
    .groupBy(chainObservations.severity);
  return rows.map((row) => ({ severity: row.severity, count: Number(row.count) }));
}

export async function listObservations(
  executor: Executor,
  operationId: string,
): Promise<(typeof chainObservations.$inferSelect)[]> {
  return executor
    .select()
    .from(chainObservations)
    .where(eq(chainObservations.operationId, operationId))
    .orderBy(chainObservations.observedAt);
}

/**
 * Marks what was observed about a now-orphaned block as historical rather than deleting
 * it: the chain did claim this at the time, and that claim is part of the audit trail.
 */
export async function invalidateAttemptObservations(
  executor: Executor,
  attemptId: string,
): Promise<number> {
  const rows = await executor
    .update(chainObservations)
    .set({ canonical: false })
    .where(
      and(
        eq(chainObservations.transactionAttemptId, attemptId),
        eq(chainObservations.canonical, true),
      ),
    )
    .returning({ id: chainObservations.id });
  return rows.length;
}

/**
 * Drops inclusion evidence for an attempt whose block was replaced. The signed bytes,
 * hash and nonce are untouched: the same transaction may still be mined in a new block.
 */
export async function clearAttemptInclusion(executor: Executor, attemptId: string): Promise<void> {
  await executor
    .update(transactionAttempts)
    .set({
      status: AttemptStatus.SUBMITTED,
      blockNumber: null,
      blockHash: null,
      gasUsed: null,
      receiptStatus: null,
      updatedAt: new Date(),
    })
    .where(eq(transactionAttempts.id, attemptId));
}

/** The live attempt holding a nonce, if the lane is occupied. */
export async function findLiveAttemptAtNonce(
  executor: Executor,
  input: { chainId: number; signerAddress: string; nonce: number },
): Promise<TransactionAttemptRecord | null> {
  const [row] = await executor
    .select()
    .from(transactionAttempts)
    .where(
      and(
        eq(transactionAttempts.chainId, input.chainId),
        eq(transactionAttempts.fromAddress, input.signerAddress.toLowerCase()),
        eq(transactionAttempts.nonce, input.nonce),
        ne(transactionAttempts.status, AttemptStatus.REPLACED),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Retires an attempt so its nonce can be reused by a replacement. The lane's partial
 * unique index only ignores REPLACED rows, so this must commit before the new attempt is
 * inserted; returning false means another dispatcher got there first.
 */
export async function retireAttemptForReplacement(
  executor: Executor,
  input: { attemptId: string; reason: string },
): Promise<boolean> {
  const rows = await executor
    .update(transactionAttempts)
    .set({
      status: AttemptStatus.REPLACED,
      replacementReason: input.reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(transactionAttempts.id, input.attemptId),
        ne(transactionAttempts.status, AttemptStatus.REPLACED),
      ),
    )
    .returning({ id: transactionAttempts.id });
  return rows.length > 0;
}

export async function linkAttemptReplacement(
  executor: Executor,
  input: { attemptId: string; replacementId: string },
): Promise<void> {
  await executor
    .update(transactionAttempts)
    .set({ replacedByAttemptId: input.replacementId })
    .where(eq(transactionAttempts.id, input.attemptId));
}

/**
 * Attempts broadcast but still without a receipt after the chain profile's stuck window.
 * The window is measured with PostgreSQL time because `updated_at` is written by
 * PostgreSQL; a worker clock behind the database would replace transactions too eagerly.
 */
export async function findStuckAttempts(
  executor: Executor,
  input: { chainId: number; stuckAfterMs: number; maxReplacements: number; limit: number },
): Promise<TransactionAttemptRecord[]> {
  return executor
    .select()
    .from(transactionAttempts)
    .where(
      and(
        eq(transactionAttempts.chainId, input.chainId),
        inArray(transactionAttempts.status, [
          AttemptStatus.SUBMITTED,
          AttemptStatus.BROADCASTING,
          AttemptStatus.BROADCAST_UNKNOWN,
        ]),
        isNull(transactionAttempts.blockNumber),
        sql`${transactionAttempts.replacementNumber} < ${input.maxReplacements}`,
        sql`${transactionAttempts.updatedAt} + make_interval(secs => ${input.stuckAfterMs / 1000}) <= now()`,
      ),
    )
    .orderBy(transactionAttempts.updatedAt)
    .limit(input.limit);
}
