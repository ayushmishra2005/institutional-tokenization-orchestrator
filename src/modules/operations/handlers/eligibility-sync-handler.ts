import type { Database, Transaction } from '../../../db/pool.js';
import type { EvmGateway } from '../../../ports/evm-gateway.js';
import type {
  ReconciliationReport,
  ReconciliationService,
} from '../../transactions/reconciliation-service.js';
import {
  findDecisionById,
  markComplianceChainSynced,
} from '../../../db/repositories/compliance-repository.js';
import { findAssetById } from '../../../db/repositories/asset-repository.js';
import { findWalletById } from '../../../db/repositories/wallet-repository.js';
import type { OperationRecord } from '../../../db/repositories/operation-repository.js';
import type { AttemptPurpose } from '../../../db/repositories/transaction-repository.js';
import { AppError, ErrorCode } from '../../../domain/errors.js';
import { hashEligibilitySyncIntent } from '../administrative-intent.js';
import type {
  OperationHandler,
  PreparedChainWrite,
  SettledOperation,
} from '../operation-handler.js';

interface EligibilityTarget {
  readonly contractAddress: `0x${string}`;
  readonly account: `0x${string}`;
  readonly eligibleUntil: bigint;
  readonly decisionId: string;
}

/** Mirrors an approved compliance decision onto the token contract's eligibility mapping. */
export class EligibilitySyncHandler implements OperationHandler {
  readonly purpose: AttemptPurpose = 'SET_ELIGIBILITY';

  constructor(
    private readonly deps: {
      db: Database;
      gateway: EvmGateway;
      reconciliation: ReconciliationService;
    },
  ) {}

  async prepare(operation: OperationRecord): Promise<PreparedChainWrite> {
    const target = await this.resolveTarget(operation);
    await this.deps.gateway.getChainIdentity();
    await this.deps.gateway.assertContractDeployed(target.contractAddress);

    return {
      call: this.deps.gateway.encodeSetEligibilityCall(target.contractAddress, {
        account: target.account,
        eligibleUntil: target.eligibleUntil,
      }),
      evidence: {
        complianceDecisionId: target.decisionId,
        eligibleUntil: target.eligibleUntil.toString(),
        requestedBy: operation.requestedBy,
      },
    };
  }

  async reconcile(settled: SettledOperation): Promise<ReconciliationReport> {
    const target = await this.resolveTarget(settled.operation);
    return this.deps.reconciliation.reconcileEligibility({
      operation: settled.operation,
      attemptId: settled.attemptId,
      receipt: settled.receipt,
      contractAddress: target.contractAddress,
      account: target.account,
      expectedEligibleUntil: target.eligibleUntil,
    });
  }

  async applySuccess(tx: Transaction, settled: SettledOperation): Promise<void> {
    if (settled.operation.complianceDecisionId === null) return;
    await markComplianceChainSynced(tx, {
      decisionId: settled.operation.complianceDecisionId,
      transactionHash: settled.receipt.transactionHash,
    });
  }

  private async resolveTarget(operation: OperationRecord): Promise<EligibilityTarget> {
    const { db } = this.deps;
    const asset = await findAssetById(db, operation.assetId);
    const wallet = operation.walletId === null ? null : await findWalletById(db, operation.walletId);
    const decision =
      operation.complianceDecisionId === null
        ? null
        : await findDecisionById(db, operation.complianceDecisionId);

    if (asset === null || asset.contractAddress === null || wallet === null || decision === null) {
      throw new AppError(
        ErrorCode.ASSET_NOT_ACTIVE,
        'eligibility sync is missing its asset, wallet or compliance decision',
      );
    }
    if (decision.status !== 'APPROVED' || decision.supersededAt !== null) {
      throw new AppError(
        ErrorCode.COMPLIANCE_NOT_ELIGIBLE,
        'compliance decision is no longer live; refusing to write eligibility on chain',
        { details: { decisionId: decision.id, status: decision.status } },
      );
    }

    const eligibleUntil = BigInt(Math.floor(decision.validUntil.getTime() / 1000));
    const intentHash = hashEligibilitySyncIntent({
      assetId: asset.id,
      chainId: asset.chainId,
      walletId: wallet.id,
      walletAddress: wallet.address,
      complianceDecisionId: decision.id,
      eligibleUntil: eligibleUntil.toString(),
    });
    if (intentHash !== operation.proposalHash) {
      throw new AppError(
        ErrorCode.OPERATION_CONFLICT,
        'compliance decision changed after the sync was requested',
        { details: { expected: operation.proposalHash, current: intentHash } },
      );
    }

    return {
      contractAddress: asset.contractAddress as `0x${string}`,
      account: wallet.address as `0x${string}`,
      eligibleUntil,
      decisionId: decision.id,
    };
  }
}
