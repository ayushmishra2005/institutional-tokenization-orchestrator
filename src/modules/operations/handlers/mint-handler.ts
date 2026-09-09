import type { Database } from '../../../db/pool.js';
import type { EvmGateway } from '../../../ports/evm-gateway.js';
import type { ComplianceService } from '../../compliance/compliance-service.js';
import type {
  ReconciliationReport,
  ReconciliationService,
} from '../../transactions/reconciliation-service.js';
import { findAssetById, type AssetRecord } from '../../../db/repositories/asset-repository.js';
import { findWalletById, type WalletRecord } from '../../../db/repositories/wallet-repository.js';
import {
  recordObservation,
  type AttemptPurpose,
} from '../../../db/repositories/transaction-repository.js';
import type { OperationRecord } from '../../../db/repositories/operation-repository.js';
import { AppError, ErrorCode } from '../../../domain/errors.js';
import { rebuildMintProposal } from '../mint-service.js';
import type {
  OperationHandler,
  PreparedChainWrite,
  SettledOperation,
} from '../operation-handler.js';

interface MintTarget {
  readonly asset: AssetRecord;
  readonly wallet: WalletRecord;
  readonly contractAddress: `0x${string}`;
  readonly recipient: `0x${string}`;
  readonly amount: string;
  readonly operationReference: `0x${string}`;
}

export class MintHandler implements OperationHandler {
  readonly purpose: AttemptPurpose = 'MINT';

  constructor(
    private readonly deps: {
      db: Database;
      gateway: EvmGateway;
      compliance: ComplianceService;
      reconciliation: ReconciliationService;
      chainId: number;
      mintDeadlineSeconds: number;
    },
  ) {}

  async prepare(operation: OperationRecord): Promise<PreparedChainWrite> {
    const { gateway } = this.deps;
    const target = await this.resolveTarget(operation);

    // The approved intent must still describe what is about to happen.
    const rebuilt = rebuildMintProposal({
      operation,
      asset: target.asset,
      wallet: target.wallet,
    });
    if (rebuilt.hash !== operation.proposalHash) {
      throw new AppError(
        ErrorCode.OPERATION_CONFLICT,
        'financial intent changed after approval; refusing to execute',
        { details: { expected: operation.proposalHash, current: rebuilt.hash } },
      );
    }

    // Fresh compliance re-check: the approval snapshot is not accepted as evidence here.
    const eligibility = await this.deps.compliance.assertEligibleForExecution({
      walletId: target.wallet.id,
      walletAddress: target.wallet.address,
      chainId: target.asset.chainId,
      assetId: target.asset.id,
      amount: target.amount,
      subjectReference: target.wallet.investorReference,
    });

    await gateway.getChainIdentity();
    await gateway.assertContractDeployed(target.contractAddress);

    // If the single-use reference is already consumed, this mint has happened. Minting
    // again is impossible by design, and declaring failure would be a lie about money that
    // may already exist, so this halts for review with a durable finding.
    if (await gateway.readReferenceConsumed(target.contractAddress, target.operationReference)) {
      await recordObservation(this.deps.db, {
        operationId: operation.id,
        transactionAttemptId: null,
        kind: 'REFERENCE_CONSUMED',
        chainId: this.deps.chainId,
        blockNumber: null,
        blockHash: null,
        transactionHash: null,
        matched: false,
        severity: 'CRITICAL',
        expected: { consumed: false },
        actual: { consumed: true },
        detail: 'operation reference was already consumed before this execution attempt',
      });
      throw new AppError(
        ErrorCode.OPERATION_CONFLICT,
        'operation reference is already consumed on chain',
        { details: { operationReference: target.operationReference } },
      );
    }

    const token = await gateway.readTokenState(target.contractAddress);
    if (token.paused) throw new AppError(ErrorCode.ASSET_PAUSED, 'token contract is paused');
    if (token.totalSupply + BigInt(target.amount) > token.supplyCap) {
      throw new AppError(ErrorCode.SUPPLY_CAP_EXCEEDED, 'mint would exceed the on-chain supply cap', {
        details: {
          totalSupply: token.totalSupply.toString(),
          supplyCap: token.supplyCap.toString(),
          amount: target.amount,
        },
      });
    }

    return {
      call: gateway.encodeMintCall(target.contractAddress, {
        recipient: target.recipient,
        amount: BigInt(target.amount),
        operationReference: target.operationReference,
        deadline: BigInt(Math.floor(Date.now() / 1000) + this.deps.mintDeadlineSeconds),
      }),
      evidence: {
        proposalHash: operation.proposalHash,
        complianceDecisionId: eligibility.decisionId,
        requiredApprovals: operation.requiredApprovals,
        requestedBy: operation.requestedBy,
      },
    };
  }

  /**
   * A signature can arrive long after `prepare` ran. Compliance is therefore checked once
   * more against the same rules, immediately before the transaction would leave.
   */
  async assertStillExecutable(operation: OperationRecord): Promise<void> {
    const target = await this.resolveTarget(operation);
    await this.deps.compliance.assertEligibleForExecution({
      walletId: target.wallet.id,
      walletAddress: target.wallet.address,
      chainId: target.asset.chainId,
      assetId: target.asset.id,
      amount: target.amount,
      subjectReference: target.wallet.investorReference,
    });
  }

  async reconcile(settled: SettledOperation): Promise<ReconciliationReport> {
    const target = await this.resolveTarget(settled.operation);
    return this.deps.reconciliation.reconcileMint({
      operation: settled.operation,
      attemptId: settled.attemptId,
      receipt: settled.receipt,
      contractAddress: target.contractAddress,
      recipient: target.recipient,
      amount: target.amount,
      operationReference: target.operationReference,
    });
  }

  private async resolveTarget(operation: OperationRecord): Promise<MintTarget> {
    const asset = await findAssetById(this.deps.db, operation.assetId);
    const wallet =
      operation.walletId === null ? null : await findWalletById(this.deps.db, operation.walletId);

    if (
      asset === null ||
      asset.contractAddress === null ||
      wallet === null ||
      operation.amount === null ||
      operation.operationReference === null
    ) {
      throw new AppError(ErrorCode.ASSET_NOT_ACTIVE, 'mint operation is missing its chain target');
    }

    return {
      asset,
      wallet,
      contractAddress: asset.contractAddress as `0x${string}`,
      recipient: wallet.address as `0x${string}`,
      amount: operation.amount,
      operationReference: operation.operationReference as `0x${string}`,
    };
  }
}
