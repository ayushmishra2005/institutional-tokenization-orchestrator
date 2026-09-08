import { and, eq, inArray, lt, notInArray, or, sql, isNull } from 'drizzle-orm';
import type { Executor, Transaction } from '../pool.js';
import { operations, operationTransitions } from '../schema/index.js';
import {
  assertOperationTransition,
  isOperationState,
  OperationState,
} from '../../domain/operation-state.js';
import { AppError, ErrorCode } from '../../domain/errors.js';

const TERMINAL_STATES = [
  OperationState.SUCCEEDED,
  OperationState.REVERTED,
  OperationState.FAILED,
  OperationState.CANCELLED,
];

/**
 * Every chain write this system performs is an operation. Only MINT is approval-gated and
 * carries money; the administrative types exist so deployment and eligibility use the same
 * durable outbox, worker, recovery and reconciliation path.
 */
export const OperationType = {
  MINT: 'MINT',
  DEPLOY_ASSET: 'DEPLOY_ASSET',
  SYNC_ELIGIBILITY: 'SYNC_ELIGIBILITY',
} as const;

export type OperationType = (typeof OperationType)[keyof typeof OperationType];

export interface OperationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly type: string;
  readonly state: OperationState;
  readonly assetId: string;
  /** Null for DEPLOY_ASSET. */
  readonly walletId: string | null;
  /** Null for everything but MINT. */
  readonly amount: string | null;
  /** Null for everything but MINT. */
  readonly operationReference: string | null;
  /** Set only for SYNC_ELIGIBILITY. */
  readonly complianceDecisionId: string | null;
  readonly proposalHash: string;
  readonly requiredApprovals: number;
  readonly requestedBy: string;
  readonly correlationId: string;
  readonly failureCode: string | null;
  readonly failureReason: string | null;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly stateUpdatedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toRecord(row: typeof operations.$inferSelect): OperationRecord {
  if (!isOperationState(row.state)) {
    throw new Error(`operation ${row.id} has unknown state ${row.state}`);
  }
  return { ...row, state: row.state };
}

/**
 * Administrative operations need no approval, so they are born READY and the dispatcher
 * can hand them straight to a worker.
 */
export async function insertAdministrativeOperation(
  executor: Executor,
  input: {
    type: 'DEPLOY_ASSET' | 'SYNC_ELIGIBILITY';
    organizationId: string;
    assetId: string;
    walletId?: string;
    complianceDecisionId?: string;
    proposalHash: string;
    requestedBy: string;
    correlationId: string;
  },
): Promise<OperationRecord> {
  const [row] = await executor
    .insert(operations)
    .values({
      type: input.type,
      state: OperationState.READY,
      organizationId: input.organizationId,
      assetId: input.assetId,
      walletId: input.walletId ?? null,
      complianceDecisionId: input.complianceDecisionId ?? null,
      proposalHash: input.proposalHash,
      requiredApprovals: 0,
      requestedBy: input.requestedBy,
      correlationId: input.correlationId,
    })
    .returning();
  if (row === undefined) throw new Error('failed to insert operation');
  await recordOperationTransition(executor, {
    operationId: row.id,
    from: null,
    to: OperationState.READY,
  });
  return toRecord(row);
}

/** The live administrative operation for a target, if a previous request already created one. */
export async function findLiveAdministrativeOperation(
  executor: Executor,
  input: { type: 'DEPLOY_ASSET' | 'SYNC_ELIGIBILITY'; assetId: string; walletId?: string },
): Promise<OperationRecord | null> {
  const [row] = await executor
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.type, input.type),
        eq(operations.assetId, input.assetId),
        input.walletId === undefined
          ? isNull(operations.walletId)
          : eq(operations.walletId, input.walletId),
        notInArray(operations.state, TERMINAL_STATES),
      ),
    )
    .limit(1);
  return row === undefined ? null : toRecord(row);
}

export async function findOperationById(
  executor: Executor,
  id: string,
): Promise<OperationRecord | null> {
  const [row] = await executor.select().from(operations).where(eq(operations.id, id)).limit(1);
  return row === undefined ? null : toRecord(row);
}

/**
 * Row-level lock for a read-modify-write on operation state.
 *
 * Every state change goes through this, so two concurrent workers (or a worker and an
 * API request) serialise on the operation rather than racing on its state column.
 */
export async function lockOperation(
  tx: Transaction,
  id: string,
): Promise<OperationRecord | null> {
  const [row] = await tx
    .select()
    .from(operations)
    .where(eq(operations.id, id))
    .limit(1)
    .for('update');
  return row === undefined ? null : toRecord(row);
}

export interface TransitionPatch {
  readonly failureCode?: string | null;
  readonly failureReason?: string | null;
  readonly claimedBy?: string | null;
  readonly claimedAt?: Date | null;
}

/**
 * Appends to the durable timeline. Always called with the same executor as the state
 * change, so the history can never disagree with the operation row.
 */
export async function recordOperationTransition(
  executor: Executor,
  input: { operationId: string; from: OperationState | null; to: OperationState },
): Promise<void> {
  await executor
    .insert(operationTransitions)
    .values({ operationId: input.operationId, fromState: input.from, toState: input.to });
}

export interface OperationTransitionRow {
  readonly state: string;
  readonly at: Date;
}

export async function listOperationHistory(
  executor: Executor,
  operationId: string,
): Promise<OperationTransitionRow[]> {
  const rows = await executor
    .select({ state: operationTransitions.toState, at: operationTransitions.occurredAt })
    .from(operationTransitions)
    .where(eq(operationTransitions.operationId, operationId))
    .orderBy(operationTransitions.id);
  return rows;
}

/**
 * Applies a state transition, rejecting any edge the domain machine forbids.
 *
 * The UPDATE is additionally guarded on the observed `state`, so even without a prior
 * lock a lost update cannot silently overwrite a concurrent transition.
 */
export async function transitionOperation(
  executor: Executor,
  input: {
    operation: OperationRecord;
    to: OperationState;
    patch?: TransitionPatch;
  },
): Promise<OperationRecord> {
  assertOperationTransition(input.operation.state, input.to);

  const now = new Date();
  const [row] = await executor
    .update(operations)
    .set({
      state: input.to,
      stateUpdatedAt: now,
      updatedAt: now,
      ...(input.patch ?? {}),
    })
    .where(and(eq(operations.id, input.operation.id), eq(operations.state, input.operation.state)))
    .returning();

  if (row === undefined) {
    throw new AppError(
      ErrorCode.OPERATION_CONFLICT,
      'operation state changed concurrently; transition abandoned',
      { details: { operationId: input.operation.id, expectedState: input.operation.state } },
    );
  }

  await recordOperationTransition(executor, {
    operationId: input.operation.id,
    from: input.operation.state,
    to: input.to,
  });
  return toRecord(row);
}

/**
 * Takes the worker lease for an operation in READY, moving it to PREPARING.
 *
 * Returns null when another worker already holds it, which is the normal outcome of a
 * duplicated BullMQ delivery.
 */
export async function claimReadyOperation(
  tx: Transaction,
  input: { operationId: string; workerId: string },
): Promise<OperationRecord | null> {
  const operation = await lockOperation(tx, input.operationId);
  if (operation === null) return null;
  if (operation.state !== OperationState.READY) return null;

  return transitionOperation(tx, {
    operation,
    to: OperationState.PREPARING,
    patch: { claimedBy: input.workerId, claimedAt: new Date() },
  });
}

export async function releaseClaim(executor: Executor, operationId: string): Promise<void> {
  await executor
    .update(operations)
    .set({ claimedBy: null, claimedAt: null, updatedAt: new Date() })
    .where(eq(operations.id, operationId));
}

/**
 * Operations that need attention because their queue job was lost or a worker died
 * mid-flight. Used by the recovery sweep to rebuild work purely from PostgreSQL.
 */
export async function findStaleOperations(
  executor: Executor,
  input: { staleBefore: Date; limit: number },
): Promise<OperationRecord[]> {
  const rows = await executor
    .select()
    .from(operations)
    .where(
      and(
        inArray(operations.state, [
          OperationState.READY,
          OperationState.PREPARING,
          OperationState.SIGNING,
          OperationState.SIGNED,
          OperationState.BROADCASTING,
          OperationState.BROADCAST_UNKNOWN,
          OperationState.SUBMITTED,
          OperationState.INCLUDED,
        ]),
        lt(operations.stateUpdatedAt, input.staleBefore),
      ),
    )
    .orderBy(operations.stateUpdatedAt)
    .limit(input.limit);
  return rows.map(toRecord);
}

/** Unclaimed READY work, for the sweep that re-enqueues lost jobs. */
export async function findUnclaimedReadyOperations(
  executor: Executor,
  limit: number,
): Promise<OperationRecord[]> {
  const rows = await executor
    .select()
    .from(operations)
    .where(and(eq(operations.state, OperationState.READY), isNull(operations.claimedBy)))
    .limit(limit);
  return rows.map(toRecord);
}

export async function countOperationsByState(
  executor: Executor,
): Promise<{ state: string; count: number }[]> {
  const rows = await executor
    .select({ state: operations.state, count: sql<string>`count(*)` })
    .from(operations)
    .groupBy(operations.state);
  return rows.map((row) => ({ state: row.state, count: Number(row.count) }));
}

export async function findOperationsForAsset(
  executor: Executor,
  assetId: string,
  limit: number,
): Promise<OperationRecord[]> {
  const rows = await executor
    .select()
    .from(operations)
    .where(eq(operations.assetId, assetId))
    .orderBy(sql`${operations.createdAt} DESC`)
    .limit(limit);
  return rows.map(toRecord);
}

/** Operations whose chain outcome is still unresolved. */
export async function findInFlightOperations(
  executor: Executor,
  limit: number,
): Promise<OperationRecord[]> {
  const rows = await executor
    .select()
    .from(operations)
    .where(
      or(
        eq(operations.state, OperationState.BROADCAST_UNKNOWN),
        eq(operations.state, OperationState.SUBMITTED),
        eq(operations.state, OperationState.INCLUDED),
      ),
    )
    .limit(limit);
  return rows.map(toRecord);
}
