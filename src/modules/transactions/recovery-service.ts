import type { Queue } from 'bullmq';
import type { Database } from '../../db/pool.js';
import type { EvmGateway } from '../../ports/evm-gateway.js';
import type { ChainWriter } from './chain-writer.js';
import type { OperationExecutor } from '../operations/operation-executor.js';
import {
  findStaleOperations,
  lockOperation,
  transitionOperation,
  type OperationRecord,
} from '../../db/repositories/operation-repository.js';
import {
  AttemptStatus,
  findLatestAttemptForOperation,
  updateAttemptStatus,
} from '../../db/repositories/transaction-repository.js';
import { findSignerRequestForAttempt } from '../../db/repositories/signer-request-repository.js';
import { recordAuditEvent } from '../../db/repositories/audit-repository.js';
import { OperationState } from '../../domain/operation-state.js';
import { systemActor } from '../../domain/roles.js';
import type { OperationJobData } from '../../platform/queue/index.js';
import type { Metrics } from '../../platform/metrics/index.js';
import type { Logger } from '../../platform/logging/index.js';

export interface RecoveryOptions {
  readonly staleAfterMs: number;
  readonly batchSize: number;
}

export interface RecoverySummary {
  readonly requeued: number;
  readonly rebroadcast: number;
  readonly resolved: number;
  readonly failed: number;
}

/**
 * Rebuilds work from PostgreSQL when Redis or a worker lets it slip. This is what makes
 * Redis pure delivery: every unfinished operation is discoverable from its own state, and
 * every signed transaction can be re-sent byte-for-byte rather than re-created.
 */
export class RecoveryService {
  private readonly actor = systemActor('recovery-sweep');

  constructor(
    private readonly deps: {
      db: Database;
      gateway: EvmGateway;
      chainWriter: ChainWriter;
      executor: OperationExecutor;
      queue: Queue<OperationJobData>;
      metrics: Metrics;
      logger: Logger;
      options: RecoveryOptions;
    },
  ) {}

  async sweep(): Promise<RecoverySummary> {
    const staleBefore = new Date(Date.now() - this.deps.options.staleAfterMs);
    const stale = await findStaleOperations(this.deps.db, {
      staleBefore,
      limit: this.deps.options.batchSize,
    });

    const summary = { requeued: 0, rebroadcast: 0, resolved: 0, failed: 0 };

    for (const operation of stale) {
      try {
        const result = await this.recoverOne(operation);
        if (result === 'REQUEUED') summary.requeued += 1;
        else if (result === 'REBROADCAST') summary.rebroadcast += 1;
        else if (result === 'RESOLVED') summary.resolved += 1;
        else if (result === 'FAILED') summary.failed += 1;
      } catch (error) {
        this.deps.logger.error(
          { err: error, operationId: operation.id, state: operation.state },
          'recovery failed for operation',
        );
      }
    }

    return summary;
  }

  private async recoverOne(
    operation: OperationRecord,
  ): Promise<'REQUEUED' | 'REBROADCAST' | 'RESOLVED' | 'FAILED' | 'NOOP'> {
    switch (operation.state) {
      case OperationState.READY:
        // The queue job was lost; the durable state says the work is still owed.
        await this.requeue(operation);
        return 'REQUEUED';

      case OperationState.SIGNING: {
        // An outstanding request means the signer may be about to authorise these exact
        // bytes; the previous worker's request is resumed rather than replaced.
        const resumed = await this.resumePendingSignature(operation);
        if (resumed !== null) return resumed;
        return (await this.abandonUnbroadcast(operation)) ? 'FAILED' : 'NOOP';
      }

      case OperationState.PREPARING:
        // Nothing was ever broadcast in these states - signed bytes are persisted
        // before BROADCASTING - so failing here cannot strand value on chain.
        return (await this.abandonUnbroadcast(operation)) ? 'FAILED' : 'NOOP';

      case OperationState.SIGNED:
      case OperationState.BROADCASTING:
      case OperationState.BROADCAST_UNKNOWN:
        return this.resolveInFlight(operation);

      case OperationState.SUBMITTED:
      case OperationState.INCLUDED:
        return (await this.finalize(operation)) ? 'RESOLVED' : 'NOOP';

      default:
        return 'NOOP';
    }
  }

  private async requeue(operation: OperationRecord): Promise<void> {
    await this.deps.queue.add(
      'operation.ready',
      { operationId: operation.id, outboxId: null, correlationId: operation.correlationId },
      { jobId: `recovery-${operation.id}-${Date.now()}` },
    );
    this.deps.logger.warn({ operationId: operation.id }, 'requeued lost mint job from PostgreSQL');
  }

  private async resumePendingSignature(
    operation: OperationRecord,
  ): Promise<'RESOLVED' | 'FAILED' | 'NOOP' | null> {
    const attempt = await findLatestAttemptForOperation(this.deps.db, operation.id);
    if (attempt === null || attempt.signedRawTransaction !== null) return null;

    const signerRequest = await findSignerRequestForAttempt(this.deps.db, attempt.id);
    if (signerRequest === null || signerRequest.status !== 'PENDING') return null;

    const log = this.deps.logger.child({
      operationId: operation.id,
      transactionAttemptId: attempt.id,
      providerRequestId: signerRequest.providerRequestId,
      recoveryAction: 'RESUME_SIGNATURE',
    });
    const result = await this.deps.executor.resumePendingSignature(operation.id, attempt, log);

    if (result.kind === 'PENDING' && result.state === OperationState.SIGNING) return 'NOOP';
    if (result.kind === 'FAILED') return 'FAILED';
    return 'RESOLVED';
  }

  private async abandonUnbroadcast(operation: OperationRecord): Promise<boolean> {
    const attempt = await findLatestAttemptForOperation(this.deps.db, operation.id);
    // If bytes exist the operation is not really unbroadcast; let the in-flight path run.
    if (attempt !== null && attempt.signedRawTransaction !== null) {
      return (await this.resolveInFlight(operation)) !== 'NOOP';
    }

    await this.deps.db.transaction(async (tx) => {
      const current = await lockOperation(tx, operation.id);
      if (current === null) return;
      if (current.state !== OperationState.PREPARING && current.state !== OperationState.SIGNING) {
        return;
      }
      await transitionOperation(tx, {
        operation: current,
        to: OperationState.FAILED,
        patch: {
          failureCode: 'ABANDONED_BEFORE_BROADCAST',
          failureReason: 'worker died before any transaction was broadcast',
        },
      });
      if (attempt !== null) {
        await updateAttemptStatus(tx, {
          attemptId: attempt.id,
          status: AttemptStatus.FAILED,
          errorCode: 'ABANDONED_BEFORE_BROADCAST',
        });
      }
      await recordAuditEvent(tx, {
        actor: this.actor,
        action: 'operation.failed',
        resourceType: 'operation',
        resourceId: operation.id,
        operationId: operation.id,
        correlationId: operation.correlationId,
        metadata: { failureCode: 'ABANDONED_BEFORE_BROADCAST', recoveredBy: 'sweep' },
      });
      this.deps.metrics.operationsFailed.inc({ reason: 'ABANDONED_BEFORE_BROADCAST' });
    });
    return true;
  }

  /**
   * Order matters: look the hash up first, because a receipt proves the transaction landed
   * and re-sending would be pointless. Only if the chain has never seen it are the
   * IDENTICAL persisted bytes re-sent. Constructing a new transaction here could mint twice.
   */
  private async resolveInFlight(
    operation: OperationRecord,
  ): Promise<'REBROADCAST' | 'RESOLVED' | 'FAILED' | 'NOOP'> {
    const attempt = await findLatestAttemptForOperation(this.deps.db, operation.id);
    if (attempt === null || attempt.signedRawTransaction === null || attempt.transactionHash === null) {
      return (await this.abandonUnbroadcast(operation)) ? 'FAILED' : 'NOOP';
    }
    // A superseded attempt's nonce now belongs to its replacement; the replacement sweep
    // owns getting that intent mined.
    if (attempt.status === AttemptStatus.REPLACED) return 'NOOP';

    const hash = attempt.transactionHash as `0x${string}`;
    const receipt = await this.deps.gateway.getTransactionReceipt(hash);

    if (receipt !== null) {
      await this.advanceToSubmitted(operation, hash);
      return (await this.finalize(operation)) ? 'RESOLVED' : 'NOOP';
    }

    // No receipt: re-send the exact bytes. Identical bytes produce an identical hash, so
    // this is idempotent even if the original broadcast did in fact reach a node.
    await this.deps.db.transaction(async (tx) => {
      const current = await lockOperation(tx, operation.id);
      if (current === null) return;
      if (current.state === OperationState.BROADCAST_UNKNOWN || current.state === OperationState.SIGNED) {
        await transitionOperation(tx, { operation: current, to: OperationState.BROADCASTING });
      }
      await updateAttemptStatus(tx, {
        attemptId: attempt.id,
        status: AttemptStatus.BROADCASTING,
        incrementBroadcastAttempts: true,
      });
    });

    this.deps.logger.warn(
      {
        operationId: operation.id,
        transactionAttemptId: attempt.id,
        transactionHash: hash,
        recoveryAction: 'REBROADCAST_IDENTICAL_BYTES',
      },
      'rebroadcasting identical signed bytes',
    );

    await this.deps.chainWriter.broadcast(attempt, attempt.signedRawTransaction, hash, {
      onSubmitted: async (tx) => {
        const current = await lockOperation(tx, operation.id);
        if (current !== null && current.state === OperationState.BROADCASTING) {
          await transitionOperation(tx, { operation: current, to: OperationState.SUBMITTED });
        }
      },
      onBroadcastUnknown: async (tx) => {
        const current = await lockOperation(tx, operation.id);
        if (current !== null && current.state === OperationState.BROADCASTING) {
          await transitionOperation(tx, { operation: current, to: OperationState.BROADCAST_UNKNOWN });
        }
      },
    });

    return 'REBROADCAST';
  }

  private async advanceToSubmitted(
    operation: OperationRecord,
    hash: `0x${string}`,
  ): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const current = await lockOperation(tx, operation.id);
      if (current === null) return;
      if (
        current.state === OperationState.BROADCAST_UNKNOWN ||
        current.state === OperationState.BROADCASTING
      ) {
        await transitionOperation(tx, { operation: current, to: OperationState.SUBMITTED });
        this.deps.logger.info(
          { operationId: operation.id, transactionHash: hash, recoveryAction: 'HASH_LOOKUP' },
          'resolved ambiguous broadcast: transaction found on chain',
        );
      }
    });
  }

  /** Drives a SUBMITTED/INCLUDED operation to its terminal state. */
  private async finalize(operation: OperationRecord): Promise<boolean> {
    const attempt = await findLatestAttemptForOperation(this.deps.db, operation.id);
    if (attempt === null || attempt.transactionHash === null) return false;

    const result = await this.deps.executor.observeAndFinalize({
      operationId: operation.id,
      attemptId: attempt.id,
      transactionHash: attempt.transactionHash as `0x${string}`,
      log: this.deps.logger.child({ operationId: operation.id, recoveryAction: 'FINALIZE' }),
    });
    return result.kind === 'SUCCEEDED' || result.kind === 'REVERTED';
  }
}
