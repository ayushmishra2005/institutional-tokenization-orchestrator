import type { Database, Transaction } from '../../db/pool.js';
import type { EvmGateway, TransactionReceiptView } from '../../ports/evm-gateway.js';
import type { ChainWriter } from '../transactions/chain-writer.js';
import { awaitConfirmation, type ConfirmationPolicy } from '../transactions/confirmation.js';
import {
  claimReadyOperation,
  findOperationById,
  lockOperation,
  transitionOperation,
  type OperationRecord,
} from '../../db/repositories/operation-repository.js';
import {
  AttemptStatus,
  clearAttemptInclusion,
  findAttemptById,
  findLatestAttemptForOperation,
  invalidateAttemptObservations,
  recordObservation,
  recordReceipt,
  updateAttemptStatus,
  type TransactionAttemptRecord,
} from '../../db/repositories/transaction-repository.js';
import { recordAuditEvent } from '../../db/repositories/audit-repository.js';
import {
  canTransitionOperation,
  isTerminalOperationState,
  OperationState,
} from '../../domain/operation-state.js';
import { systemActor } from '../../domain/roles.js';
import { AppError, ErrorCode, isAppError } from '../../domain/errors.js';
import type { OperationHandler, SettledOperation } from './operation-handler.js';
import type { Metrics } from '../../platform/metrics/index.js';
import type { Logger } from '../../platform/logging/index.js';

export interface OperationExecutorDeps {
  readonly db: Database;
  readonly gateway: EvmGateway;
  readonly chainId: number;
  readonly chainWriter: ChainWriter;
  readonly confirmation: ConfirmationPolicy;
  readonly handlers: Readonly<Record<string, OperationHandler>>;
  readonly metrics: Metrics;
  readonly logger: Logger;
}

export type OperationExecutionResult =
  | { readonly kind: 'SKIPPED'; readonly reason: string }
  | { readonly kind: 'SUCCEEDED'; readonly transactionHash: string }
  | { readonly kind: 'REVERTED'; readonly transactionHash: string }
  | { readonly kind: 'PENDING'; readonly state: string }
  | { readonly kind: 'FAILED'; readonly code: string; readonly message: string };

/**
 * Drives an operation from READY to a terminal state.
 *
 * Everything authoritative is reloaded from PostgreSQL; the queue message carries only an
 * operation id. Calling this twice for the same operation is safe: the second call loses
 * the claim race and does nothing.
 */
export class OperationExecutor {
  private readonly actor = systemActor('operation-executor');

  constructor(private readonly deps: OperationExecutorDeps) {}

  async execute(operationId: string, workerId: string): Promise<OperationExecutionResult> {
    const { db, logger } = this.deps;

    // A duplicated BullMQ delivery loses this race and returns null: exactly one worker
    // ever drives an operation from READY into the signing pipeline.
    const claimed = await db.transaction((tx) =>
      claimReadyOperation(tx, { operationId, workerId }),
    );
    if (claimed === null) {
      const current = await findOperationById(db, operationId);
      return {
        kind: 'SKIPPED',
        reason: `operation is ${current?.state ?? 'missing'}, not claimable`,
      };
    }

    const log = logger.child({
      operationId,
      operationType: claimed.type,
      correlationId: claimed.correlationId,
    });

    try {
      return await this.runPipeline(claimed, log);
    } catch (error) {
      const code = isAppError(error) ? error.code : ErrorCode.INTERNAL_ERROR;
      const message = error instanceof Error ? error.message : 'unknown failure';
      log.error({ err: error, code }, 'operation execution failed');
      await this.failOperation(claimed, code, message);
      return { kind: 'FAILED', code, message };
    }
  }

  private handlerFor(operation: OperationRecord): OperationHandler {
    const handler = this.deps.handlers[operation.type];
    if (handler === undefined) {
      throw new Error(`no handler registered for operation type ${operation.type}`);
    }
    return handler;
  }

  private async runPipeline(
    operation: OperationRecord,
    log: Logger,
  ): Promise<OperationExecutionResult> {
    const handler = this.handlerFor(operation);
    const prepared = await handler.prepare(operation, log);

    const outcome = await this.deps.chainWriter.execute(
      {
        purpose: handler.purpose,
        call: prepared.call,
        operationId: operation.id,
        assetId: operation.assetId,
        walletId: operation.walletId,
        correlationId: operation.correlationId,
        evidence: prepared.evidence,
      },
      this.operationHooks(operation.id),
    );

    if (outcome.kind === 'FAILED') {
      return { kind: 'FAILED', code: outcome.code, message: outcome.message };
    }
    if (outcome.kind === 'SIGNATURE_PENDING') {
      log.info(
        { transactionAttemptId: outcome.attemptId, providerRequestId: outcome.providerRequestId },
        'awaiting signer decision; the recovery sweep will resume this attempt',
      );
      return { kind: 'PENDING', state: OperationState.SIGNING };
    }
    if (outcome.kind === 'BROADCAST_UNKNOWN') {
      log.warn(
        { transactionAttemptId: outcome.attemptId, transactionHash: outcome.transactionHash },
        'broadcast unresolved; leaving for recovery',
      );
      return { kind: 'PENDING', state: OperationState.BROADCAST_UNKNOWN };
    }

    return this.observeAndFinalize({
      operationId: operation.id,
      attemptId: outcome.attemptId,
      transactionHash: outcome.transactionHash as `0x${string}`,
      log,
    });
  }

  /**
   * Resumes an attempt left in SIGNING by a worker that exited while the signer still
   * held the request.
   */
  async resumePendingSignature(
    operationId: string,
    attempt: TransactionAttemptRecord,
    log: Logger,
  ): Promise<OperationExecutionResult> {
    const outcome = await this.deps.chainWriter.resumeSignature(
      attempt,
      this.operationHooks(operationId),
    );

    if (outcome.kind === 'SIGNATURE_PENDING') {
      return { kind: 'PENDING', state: OperationState.SIGNING };
    }
    if (outcome.kind === 'FAILED') {
      return { kind: 'FAILED', code: outcome.code, message: outcome.message };
    }
    if (outcome.kind === 'BROADCAST_UNKNOWN') {
      return { kind: 'PENDING', state: OperationState.BROADCAST_UNKNOWN };
    }

    return this.observeAndFinalize({
      operationId,
      attemptId: outcome.attemptId,
      transactionHash: outcome.transactionHash as `0x${string}`,
      log,
    });
  }

  /**
   * State moves for a replacement of an already in-flight attempt.
   *
   * The operation stays where it is while the replacement is prepared and signed - it is
   * not going backwards through SIGNING for a transaction it has already authorised - but
   * the broadcast outcome and the withheld check still apply.
   */
  replacementHooks(operationId: string) {
    const advance = async (tx: Transaction, to: OperationState) => {
      const current = await lockOperation(tx, operationId);
      if (current === null || !canTransitionOperation(current.state as OperationState, to)) return;
      await transitionOperation(tx, { operation: current, to });
      this.deps.metrics.operationTransitions.inc({
        from: current.state,
        to,
        type: current.type,
      });
    };

    return {
      assertBroadcastAllowed: this.operationHooks(operationId).assertBroadcastAllowed,
      onSubmitted: (tx: Transaction) => advance(tx, OperationState.SUBMITTED),
      onBroadcastUnknown: (tx: Transaction) => advance(tx, OperationState.BROADCAST_UNKNOWN),
    };
  }

  /**
   * Moves operation state in lockstep with the transaction attempt, inside the same
   * transactions the ChainWriter uses for its durable steps.
   */
  private operationHooks(operationId: string) {
    const step = async (
      tx: Transaction,
      to: OperationState,
      patch?: { failureCode: string; failureReason: string },
    ) => {
      const current = await lockOperation(tx, operationId);
      if (current === null) throw new Error(`operation ${operationId} disappeared`);
      await transitionOperation(tx, {
        operation: current,
        to,
        ...(patch === undefined ? {} : { patch }),
      });
      this.deps.metrics.operationTransitions.inc({ from: current.state, to, type: current.type });
    };

    return {
      assertBroadcastAllowed: async () => {
        const operation = await findOperationById(this.deps.db, operationId);
        if (operation === null) throw new Error(`operation ${operationId} disappeared`);
        try {
          if (operation.state === OperationState.CANCELLED) {
            throw new AppError(
              ErrorCode.OPERATION_CONFLICT,
              'operation was cancelled before the signature was broadcast',
            );
          }
          await this.handlerFor(operation).assertStillExecutable?.(operation);
        } catch (error) {
          await recordAuditEvent(this.deps.db, {
            actor: this.actor,
            action: 'operation.execution_withheld',
            resourceType: 'operation',
            resourceId: operation.id,
            operationId: operation.id,
            correlationId: operation.correlationId,
            metadata: {
              state: operation.state,
              reason: isAppError(error) ? error.code : ErrorCode.INTERNAL_ERROR,
            },
          });
          throw error;
        }
      },
      onPrepared: (tx: Transaction) => step(tx, OperationState.SIGNING),
      onSigned: (tx: Transaction) => step(tx, OperationState.SIGNED),
      onBroadcasting: (tx: Transaction) => step(tx, OperationState.BROADCASTING),
      onSubmitted: (tx: Transaction) => step(tx, OperationState.SUBMITTED),
      onBroadcastUnknown: (tx: Transaction) => step(tx, OperationState.BROADCAST_UNKNOWN),
      onFailed: async (
        tx: Transaction,
        _attempt: unknown,
        failure: { code: string; message: string },
      ) => {
        this.deps.metrics.operationsFailed.inc({ reason: failure.code });
        await step(tx, OperationState.FAILED, {
          failureCode: failure.code,
          failureReason: failure.message.slice(0, 500),
        });
      },
    };
  }

  /**
   * Waits for inclusion, reconciles against canonical chain state and settles the
   * operation. Safe to call again for the same attempt during recovery.
   */
  async observeAndFinalize(input: {
    operationId: string;
    attemptId: string;
    transactionHash: `0x${string}`;
    log: Logger;
  }): Promise<OperationExecutionResult> {
    const { db, metrics } = this.deps;

    // The worker and the recovery sweep can both reach here for the same operation. Once
    // it has settled, re-running would overwrite the confirmed attempt with a stale
    // observation, so finalization refuses to redo the work.
    const existing = await findOperationById(db, input.operationId);
    if (existing === null) throw new Error(`operation ${input.operationId} disappeared`);
    if (isTerminalOperationState(existing.state)) {
      return existing.state === OperationState.SUCCEEDED
        ? { kind: 'SUCCEEDED', transactionHash: input.transactionHash }
        : { kind: 'PENDING', state: existing.state };
    }

    const confirmation = await awaitConfirmation(
      this.deps.gateway,
      input.transactionHash,
      this.deps.confirmation,
    );
    if (confirmation.kind === 'PENDING') {
      return { kind: 'PENDING', state: OperationState.SUBMITTED };
    }

    const receipt = confirmation.receipt;
    const log = input.log.child({
      transactionAttemptId: input.attemptId,
      transactionHash: input.transactionHash,
    });

    if (confirmation.kind === 'ORPHANED') {
      return this.recordReorg(input.operationId, input.attemptId, receipt, log);
    }

    // Inclusion is recorded before any success/failure judgement is made.
    await db.transaction(async (tx) => {
      const operation = await lockOperation(tx, input.operationId);
      if (operation === null) throw new Error('operation disappeared');
      if (operation.state === OperationState.SUBMITTED) {
        await transitionOperation(tx, { operation, to: OperationState.INCLUDED });
        metrics.operationTransitions.inc({
          from: operation.state,
          to: OperationState.INCLUDED,
          type: operation.type,
        });
      }
      await recordReceipt(tx, {
        attemptId: input.attemptId,
        status: receipt.status === 'success' ? AttemptStatus.INCLUDED : AttemptStatus.REVERTED,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        gasUsed: Number(receipt.gasUsed),
        receiptStatus: receipt.status === 'success' ? 1 : 0,
        contractAddress: receipt.contractAddress,
      });
    });

    // Canonical inclusion is recorded, but only finality justifies a terminal claim about
    // money. Until then the sweep keeps re-observing this attempt.
    if (confirmation.kind === 'INCLUDED') {
      log.info({ blockNumber: receipt.blockNumber }, 'included; awaiting finality');
      return { kind: 'PENDING', state: OperationState.INCLUDED };
    }

    const operation = await findOperationById(db, input.operationId);
    if (operation === null) throw new Error('operation disappeared');

    const settled: SettledOperation = { operation, attemptId: input.attemptId, receipt };
    const handler = this.handlerFor(operation);
    const report = await handler.reconcile(settled);
    metrics.reconciliationFindings.inc(
      { type: operation.type, outcome: report.consistent ? 'consistent' : 'conflict' },
      1,
    );

    if (confirmation.kind === 'REVERTED') {
      metrics.transactionConfirmations.inc({ outcome: 'reverted' });
      await this.settle(settled, OperationState.REVERTED, {
        failureCode: 'CHAIN_REVERTED',
        failureReason: 'transaction reverted on chain',
        attemptStatus: AttemptStatus.REVERTED,
        metadata: { findings: report.findings },
      });
      return { kind: 'REVERTED', transactionHash: input.transactionHash };
    }

    if (!report.consistent) {
      // The receipt succeeded but chain state contradicts our expectation. The operation
      // stays in INCLUDED: neither SUCCEEDED nor FAILED would be a truthful claim, and the
      // open findings recorded by the handler are the durable evidence.
      metrics.operationsFailed.inc({ reason: 'RECONCILIATION_MISMATCH' });
      log.error({ findings: report.findings }, 'reconciliation inconsistent; awaiting review');
      return { kind: 'PENDING', state: OperationState.INCLUDED };
    }

    metrics.transactionConfirmations.inc({ outcome: 'success' });
    await this.settle(settled, OperationState.SUCCEEDED, {
      attemptStatus: AttemptStatus.CONFIRMED,
      metadata: { ...report.evidence, blockNumber: receipt.blockNumber },
    });
    return { kind: 'SUCCEEDED', transactionHash: input.transactionHash };
  }

  /**
   * A block that carried the receipt has left the canonical chain before finality.
   *
   * The signed transaction, its hash and its nonce all remain valid, so nothing is
   * re-signed and no nonce is allocated: only the inclusion evidence is retired, and the
   * operation goes back to observing.
   */
  private async recordReorg(
    operationId: string,
    attemptId: string,
    receipt: TransactionReceiptView,
    log: Logger,
  ): Promise<OperationExecutionResult> {
    const { db, metrics } = this.deps;

    await db.transaction(async (tx) => {
      const operation = await lockOperation(tx, operationId);
      if (operation === null) throw new Error('operation disappeared');

      const invalidated = await invalidateAttemptObservations(tx, attemptId);
      await clearAttemptInclusion(tx, attemptId);
      await recordObservation(tx, {
        operationId,
        transactionAttemptId: attemptId,
        kind: 'BLOCK_CANONICALITY',
        chainId: this.deps.chainId,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionHash: receipt.transactionHash,
        matched: false,
        canonical: false,
        severity: 'WARNING',
        expected: { canonicalBlockHash: receipt.blockHash },
        actual: { canonical: false },
        detail: 'including block is no longer canonical; inclusion evidence retired',
      });

      if (operation.state === OperationState.INCLUDED) {
        await transitionOperation(tx, { operation, to: OperationState.SUBMITTED });
        metrics.operationTransitions.inc({
          from: operation.state,
          to: OperationState.SUBMITTED,
          type: operation.type,
        });
      }

      await recordAuditEvent(tx, {
        actor: this.actor,
        action: 'operation.reorg_observed',
        resourceType: 'operation',
        resourceId: operationId,
        operationId,
        correlationId: operation.correlationId,
        metadata: {
          transactionHash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          invalidatedObservations: invalidated,
        },
      });
    });

    metrics.reorgObservations.inc();
    log.warn(
      { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash },
      'included block is no longer canonical; continuing to observe',
    );
    return { kind: 'PENDING', state: OperationState.SUBMITTED };
  }

  private async settle(
    settled: SettledOperation,
    to: OperationState,
    input: {
      attemptStatus: AttemptStatus;
      failureCode?: string;
      failureReason?: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    const handler = this.handlerFor(settled.operation);

    await this.deps.db.transaction(async (tx) => {
      const operation = await lockOperation(tx, settled.operation.id);
      if (operation === null) throw new Error('operation disappeared');
      if (operation.state === to) return;

      await transitionOperation(tx, {
        operation,
        to,
        ...(input.failureCode === undefined
          ? {}
          : {
              patch: {
                failureCode: input.failureCode,
                failureReason: input.failureReason ?? null,
              },
            }),
      });
      this.deps.metrics.operationTransitions.inc({
        from: operation.state,
        to,
        type: operation.type,
      });
      await updateAttemptStatus(tx, {
        attemptId: settled.attemptId,
        status: input.attemptStatus,
      });

      // The business effect of a successful administrative operation lands in the same
      // transaction as the state change, so an asset can never be ACTIVE without a
      // SUCCEEDED deployment behind it.
      if (to === OperationState.SUCCEEDED) await handler.applySuccess?.(tx, settled);

      this.deps.metrics.operationDuration.observe(
        { type: operation.type, outcome: to },
        (Date.now() - operation.createdAt.getTime()) / 1000,
      );

      await recordAuditEvent(tx, {
        actor: this.actor,
        action: to === OperationState.SUCCEEDED ? 'operation.succeeded' : 'operation.settled',
        resourceType: 'operation',
        resourceId: operation.id,
        operationId: operation.id,
        correlationId: operation.correlationId,
        metadata: {
          state: to,
          type: operation.type,
          transactionHash: settled.receipt.transactionHash,
          ...input.metadata,
        },
      });
    });
  }

  private async failOperation(
    operation: OperationRecord,
    code: string,
    message: string,
  ): Promise<void> {
    await this.deps.db
      .transaction(async (tx) => {
        const current = await lockOperation(tx, operation.id);
        if (current === null) return;

        // Never overwrite a state that may correspond to value already in flight.
        const inFlight: string[] = [
          OperationState.BROADCASTING,
          OperationState.BROADCAST_UNKNOWN,
          OperationState.SUBMITTED,
          OperationState.INCLUDED,
          OperationState.SUCCEEDED,
          OperationState.REVERTED,
          OperationState.FAILED,
          OperationState.CANCELLED,
        ];
        if (inFlight.includes(current.state)) return;

        await transitionOperation(tx, {
          operation: current,
          to: OperationState.FAILED,
          patch: { failureCode: code, failureReason: message.slice(0, 500) },
        });
        this.deps.metrics.operationsFailed.inc({ reason: code });

        const latest = await findLatestAttemptForOperation(tx, operation.id);
        if (latest !== null && latest.status === AttemptStatus.PREPARED) {
          await updateAttemptStatus(tx, {
            attemptId: latest.id,
            status: AttemptStatus.FAILED,
            errorCode: code,
            errorMessage: message,
          });
        }

        await recordAuditEvent(tx, {
          actor: this.actor,
          action: 'operation.failed',
          resourceType: 'operation',
          resourceId: operation.id,
          operationId: operation.id,
          correlationId: operation.correlationId,
          metadata: { type: operation.type, failureCode: code, failureReason: message.slice(0, 500) },
        });
      })
      .catch((error: unknown) => {
        this.deps.logger.error(
          { err: error, operationId: operation.id },
          'failed to record operation failure',
        );
      });
  }

  async loadAttempt(attemptId: string) {
    return findAttemptById(this.deps.db, attemptId);
  }
}
