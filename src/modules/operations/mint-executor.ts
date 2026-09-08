import type { Database, Transaction } from '../../db/pool.js';
import type { EvmGateway } from '../../ports/evm-gateway.js';
import type { ChainWriter } from '../transactions/chain-writer.js';
import { awaitConfirmation, type ConfirmationPolicy } from '../transactions/confirmation.js';
import type { ReconciliationService } from '../transactions/reconciliation-service.js';
import type { ComplianceService } from '../compliance/compliance-service.js';
import {
  claimReadyOperation,
  findOperationById,
  lockOperation,
  transitionOperation,
  type OperationRecord,
} from '../../db/repositories/operation-repository.js';
import { findAssetById } from '../../db/repositories/asset-repository.js';
import { findWalletById } from '../../db/repositories/wallet-repository.js';
import {
  AttemptStatus,
  findAttemptById,
  findLatestAttemptForOperation,
  recordObservation,
  recordReceipt,
  updateAttemptStatus,
} from '../../db/repositories/transaction-repository.js';
import { recordAuditEvent } from '../../db/repositories/audit-repository.js';
import { isTerminalOperationState, OperationState } from '../../domain/operation-state.js';
import { systemActor } from '../../domain/roles.js';
import { AppError, ErrorCode, isAppError } from '../../domain/errors.js';
import { rebuildMintProposal } from './mint-service.js';
import type { Metrics } from '../../platform/metrics/index.js';
import type { Logger } from '../../platform/logging/index.js';

export interface MintExecutorDeps {
  readonly db: Database;
  readonly gateway: EvmGateway;
  readonly chainWriter: ChainWriter;
  readonly compliance: ComplianceService;
  readonly reconciliation: ReconciliationService;
  readonly confirmation: ConfirmationPolicy;
  readonly chainId: number;
  readonly mintDeadlineSeconds: number;
  readonly metrics: Metrics;
  readonly logger: Logger;
}

export type MintExecutionResult =
  | { readonly kind: 'SKIPPED'; readonly reason: string }
  | { readonly kind: 'SUCCEEDED'; readonly transactionHash: string }
  | { readonly kind: 'REVERTED'; readonly transactionHash: string }
  | { readonly kind: 'PENDING'; readonly state: string }
  | { readonly kind: 'FAILED'; readonly code: string; readonly message: string };

/**
 * Executes an approved mint against the chain.
 *
 * Everything authoritative is reloaded from PostgreSQL: the queue message carries only
 * an operation id. The executor is safe to invoke twice for the same operation - the
 * second call finds the operation already claimed and does nothing.
 */
export class MintExecutor {
  private readonly actor = systemActor('mint-executor');

  constructor(private readonly deps: MintExecutorDeps) {}

  async execute(operationId: string, workerId: string): Promise<MintExecutionResult> {
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

    const log = logger.child({ operationId, correlationId: claimed.correlationId });

    try {
      return await this.runPipeline(claimed, log);
    } catch (error) {
      const code = isAppError(error) ? error.code : ErrorCode.INTERNAL_ERROR;
      const message = error instanceof Error ? error.message : 'unknown failure';
      log.error({ err: error, code }, 'mint execution failed');
      await this.failOperation(operationId, code, message);
      return { kind: 'FAILED', code, message };
    }
  }

  private async runPipeline(
    operation: OperationRecord,
    log: Logger,
  ): Promise<MintExecutionResult> {
    const { db, gateway, compliance } = this.deps;

    const asset = await findAssetById(db, operation.assetId);
    const wallet = await findWalletById(db, operation.walletId);
    if (asset === null || wallet === null || asset.contractAddress === null) {
      throw new AppError(ErrorCode.ASSET_NOT_ACTIVE, 'asset or wallet is unavailable for execution');
    }
    const contractAddress = asset.contractAddress as `0x${string}`;
    const recipient = wallet.address as `0x${string}`;

    // The approved intent must still describe what we are about to do.
    const rebuilt = rebuildMintProposal({ operation, asset, wallet });
    if (rebuilt.hash !== operation.proposalHash) {
      throw new AppError(
        ErrorCode.OPERATION_CONFLICT,
        'financial intent changed after approval; refusing to execute',
        { details: { expected: operation.proposalHash, current: rebuilt.hash } },
      );
    }

    // Fresh compliance re-check: the approval snapshot is not accepted as evidence here.
    const eligibility = await compliance.assertEligibleForExecution({
      walletId: wallet.id,
      walletAddress: wallet.address,
      chainId: asset.chainId,
      assetId: asset.id,
      amount: operation.amount,
      subjectReference: wallet.investorReference,
    });

    await gateway.getChainIdentity();
    await gateway.assertContractDeployed(contractAddress);

    // If the single-use reference is already consumed, this mint has happened. Minting
    // again is impossible by design, and declaring failure would be a lie about money
    // that may already exist, so this halts for human review with durable evidence.
    if (await gateway.readReferenceConsumed(contractAddress, operation.operationReference as `0x${string}`)) {
      await recordObservation(db, {
        operationId: operation.id,
        transactionAttemptId: null,
        kind: 'REFERENCE_CONSUMED',
        chainId: this.deps.chainId,
        blockNumber: null,
        transactionHash: null,
        matched: false,
        expected: { consumed: false },
        actual: { consumed: true },
        detail: 'operation reference was already consumed before this execution attempt',
      });
      throw new AppError(
        ErrorCode.OPERATION_CONFLICT,
        'operation reference is already consumed on chain',
        { details: { operationReference: operation.operationReference } },
      );
    }

    const chainState = await gateway.readTokenState(contractAddress);
    if (chainState.paused) {
      throw new AppError(ErrorCode.ASSET_PAUSED, 'token contract is paused');
    }
    if (chainState.totalSupply + BigInt(operation.amount) > chainState.supplyCap) {
      throw new AppError(ErrorCode.SUPPLY_CAP_EXCEEDED, 'mint would exceed the on-chain supply cap', {
        details: {
          totalSupply: chainState.totalSupply.toString(),
          supplyCap: chainState.supplyCap.toString(),
          amount: operation.amount,
        },
      });
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + this.deps.mintDeadlineSeconds);
    const call = gateway.encodeMintCall(contractAddress, {
      recipient,
      amount: BigInt(operation.amount),
      operationReference: operation.operationReference as `0x${string}`,
      deadline,
    });

    const outcome = await this.deps.chainWriter.execute(
      {
        purpose: 'MINT',
        call,
        operationId: operation.id,
        assetId: asset.id,
        walletId: wallet.id,
        correlationId: operation.correlationId,
        evidence: {
          proposalHash: operation.proposalHash,
          complianceDecisionId: eligibility.decisionId,
          requiredApprovals: operation.requiredApprovals,
          requestedBy: operation.requestedBy,
        },
      },
      this.operationHooks(operation.id),
    );

    if (outcome.kind === 'FAILED') {
      return { kind: 'FAILED', code: outcome.code, message: outcome.message };
    }
    if (outcome.kind === 'BROADCAST_UNKNOWN') {
      log.warn(
        { transactionHash: outcome.transactionHash },
        'mint broadcast unresolved; leaving for recovery',
      );
      return { kind: 'PENDING', state: OperationState.BROADCAST_UNKNOWN };
    }

    return this.observeAndFinalize({
      operationId: operation.id,
      attemptId: outcome.attemptId,
      transactionHash: outcome.transactionHash as `0x${string}`,
      contractAddress,
      recipient,
      log,
    });
  }

  /**
   * Moves operation state in lockstep with the transaction attempt, inside the same
   * transactions the ChainWriter uses for its durable steps.
   */
  private operationHooks(operationId: string) {
    const step = async (tx: Transaction, to: OperationState, patch?: { failureCode: string; failureReason: string }) => {
      const current = await lockOperation(tx, operationId);
      if (current === null) throw new Error(`operation ${operationId} disappeared`);
      await transitionOperation(tx, { operation: current, to, ...(patch === undefined ? {} : { patch }) });
      this.deps.metrics.operationTransitions.inc({ from: current.state, to, type: current.type });
    };

    return {
      onPrepared: (tx: Transaction) => step(tx, OperationState.SIGNING),
      onSigned: (tx: Transaction) => step(tx, OperationState.SIGNED),
      onBroadcasting: (tx: Transaction) => step(tx, OperationState.BROADCASTING),
      onSubmitted: (tx: Transaction) => step(tx, OperationState.SUBMITTED),
      onBroadcastUnknown: (tx: Transaction) => step(tx, OperationState.BROADCAST_UNKNOWN),
      onFailed: async (tx: Transaction, _attempt: unknown, failure: { code: string; message: string }) => {
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
    contractAddress: `0x${string}`;
    recipient: `0x${string}`;
    log: Logger;
  }): Promise<MintExecutionResult> {
    const { db, metrics } = this.deps;

    // The worker and the recovery sweep can both reach here for the same operation.
    // Once it has settled, re-running would overwrite the confirmed attempt record with
    // a stale observation, so finalization is idempotent by refusing to redo the work.
    const existing = await findOperationById(db, input.operationId);
    if (existing !== null && isTerminalOperationState(existing.state)) {
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

    const operation = await findOperationById(db, input.operationId);
    if (operation === null) throw new Error('operation disappeared');

    const report = await this.deps.reconciliation.reconcileMint({
      operation,
      attemptId: input.attemptId,
      contractAddress: input.contractAddress,
      recipient: input.recipient,
      receipt,
    });

    if (confirmation.kind === 'REVERTED') {
      metrics.transactionConfirmations.inc({ outcome: 'reverted' });
      await this.settle(input.operationId, OperationState.REVERTED, {
        failureCode: 'CHAIN_REVERTED',
        failureReason: 'transaction reverted on chain',
        attemptId: input.attemptId,
        attemptStatus: AttemptStatus.REVERTED,
        transactionHash: input.transactionHash,
        metadata: { findings: report.findings },
      });
      return { kind: 'REVERTED', transactionHash: input.transactionHash };
    }

    if (!report.consistent) {
      // Receipt succeeded but chain state contradicts our expectation. The operation is
      // deliberately left in INCLUDED: neither SUCCEEDED nor FAILED is a truthful claim.
      metrics.operationsFailed.inc({ reason: 'RECONCILIATION_MISMATCH' });
      input.log.error({ findings: report.findings }, 'mint reconciliation inconsistent');
      return { kind: 'PENDING', state: OperationState.INCLUDED };
    }

    metrics.transactionConfirmations.inc({ outcome: 'success' });
    await this.settle(input.operationId, OperationState.SUCCEEDED, {
      attemptId: input.attemptId,
      attemptStatus: AttemptStatus.CONFIRMED,
      transactionHash: input.transactionHash,
      metadata: {
        mintedAmount: report.mintedAmount,
        recipientBalance: report.recipientBalance,
        totalSupply: report.totalSupply,
        blockNumber: receipt.blockNumber,
      },
    });
    return { kind: 'SUCCEEDED', transactionHash: input.transactionHash };
  }

  private async settle(
    operationId: string,
    to: OperationState,
    input: {
      attemptId: string;
      attemptStatus: AttemptStatus;
      transactionHash: string;
      failureCode?: string;
      failureReason?: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const operation = await lockOperation(tx, operationId);
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
        attemptId: input.attemptId,
        status: input.attemptStatus,
      });
      await recordAuditEvent(tx, {
        actor: this.actor,
        action: to === OperationState.SUCCEEDED ? 'operation.succeeded' : 'operation.settled',
        resourceType: 'operation',
        resourceId: operationId,
        operationId,
        correlationId: operation.correlationId,
        metadata: {
          state: to,
          transactionHash: input.transactionHash,
          ...input.metadata,
        },
      });
    });
  }

  private async failOperation(operationId: string, code: string, message: string): Promise<void> {
    await this.deps.db
      .transaction(async (tx) => {
        const operation = await lockOperation(tx, operationId);
        if (operation === null) return;

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
        if (inFlight.includes(operation.state)) return;

        await transitionOperation(tx, {
          operation,
          to: OperationState.FAILED,
          patch: { failureCode: code, failureReason: message.slice(0, 500) },
        });
        this.deps.metrics.operationsFailed.inc({ reason: code });

        const latest = await findLatestAttemptForOperation(tx, operationId);
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
          resourceId: operationId,
          operationId,
          correlationId: operation.correlationId,
          metadata: { failureCode: code, failureReason: message.slice(0, 500) },
        });
      })
      .catch((error: unknown) => {
        this.deps.logger.error({ err: error, operationId }, 'failed to record operation failure');
      });
  }

  async loadAttempt(attemptId: string) {
    return findAttemptById(this.deps.db, attemptId);
  }
}
