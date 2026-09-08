import type { Database, Transaction } from '../../../db/pool.js';
import type { EvmGateway } from '../../../ports/evm-gateway.js';
import type { SignerProvider } from '../../../ports/signer-provider.js';
import type {
  ReconciliationReport,
  ReconciliationService,
} from '../../transactions/reconciliation-service.js';
import {
  AssetStatus,
  findAssetById,
  markAssetActive,
  type AssetRecord,
} from '../../../db/repositories/asset-repository.js';
import type { OperationRecord } from '../../../db/repositories/operation-repository.js';
import type { AttemptPurpose } from '../../../db/repositories/transaction-repository.js';
import { AppError, ErrorCode } from '../../../domain/errors.js';
import { hashAssetDeploymentIntent } from '../administrative-intent.js';
import type {
  OperationHandler,
  PreparedChainWrite,
  SettledOperation,
} from '../operation-handler.js';

export class AssetDeploymentHandler implements OperationHandler {
  readonly purpose: AttemptPurpose = 'DEPLOY_TOKEN';

  constructor(
    private readonly deps: {
      db: Database;
      gateway: EvmGateway;
      signer: SignerProvider;
      reconciliation: ReconciliationService;
    },
  ) {}

  async prepare(operation: OperationRecord): Promise<PreparedChainWrite> {
    const asset = await this.requireProvisioningAsset(operation);
    const signerAddress = await this.deps.signer.getSignerAddress();

    // The orchestrator's signer holds every on-chain role. These are EVM roles, unrelated
    // to the application roles held by human actors.
    return {
      call: this.deps.gateway.encodeTokenDeployment({
        name: asset.name,
        symbol: asset.symbol,
        decimals: asset.decimals,
        supplyCap: BigInt(asset.supplyCap),
        admin: signerAddress,
        minter: signerAddress,
        complianceOfficer: signerAddress,
        pauser: signerAddress,
      }),
      evidence: {
        assetId: asset.id,
        symbol: asset.symbol,
        supplyCap: asset.supplyCap,
        requestedBy: operation.requestedBy,
      },
    };
  }

  async reconcile(settled: SettledOperation): Promise<ReconciliationReport> {
    const asset = await findAssetById(this.deps.db, settled.operation.assetId);
    if (asset === null) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, 'asset disappeared');

    return this.deps.reconciliation.reconcileDeployment({
      operation: settled.operation,
      attemptId: settled.attemptId,
      receipt: settled.receipt,
      expected: {
        symbol: asset.symbol,
        decimals: asset.decimals,
        supplyCap: asset.supplyCap,
      },
    });
  }

  /**
   * The asset only becomes usable here, in the transaction that marks the operation
   * SUCCEEDED, so no mint can ever be requested against an unconfirmed contract.
   */
  async applySuccess(tx: Transaction, settled: SettledOperation): Promise<void> {
    const contractAddress = settled.receipt.contractAddress;
    if (contractAddress === null) {
      throw new AppError(
        ErrorCode.CHAIN_IDENTITY_MISMATCH,
        'deployment receipt has no contract address',
      );
    }
    await markAssetActive(tx, {
      assetId: settled.operation.assetId,
      contractAddress,
      deploymentTxHash: settled.receipt.transactionHash,
    });
  }

  private async requireProvisioningAsset(operation: OperationRecord): Promise<AssetRecord> {
    const asset = await findAssetById(this.deps.db, operation.assetId);
    if (asset === null) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, 'asset disappeared');

    if (asset.status !== AssetStatus.PROVISIONING || asset.contractAddress !== null) {
      throw new AppError(
        ErrorCode.OPERATION_CONFLICT,
        'asset is no longer awaiting deployment; refusing to deploy a second contract',
        { details: { assetId: asset.id, status: asset.status } },
      );
    }

    const intentHash = hashAssetDeploymentIntent(asset);
    if (intentHash !== operation.proposalHash) {
      throw new AppError(
        ErrorCode.OPERATION_CONFLICT,
        'asset definition changed after the deployment was requested',
        { details: { expected: operation.proposalHash, current: intentHash } },
      );
    }
    return asset;
  }
}
