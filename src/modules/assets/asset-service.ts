import type { Database } from '../../db/pool.js';
import type { EvmGateway } from '../../ports/evm-gateway.js';
import type { SignerProvider } from '../../ports/signer-provider.js';
import type { ChainWriter } from '../transactions/chain-writer.js';
import { awaitConfirmation, type ConfirmationPolicy } from '../transactions/confirmation.js';
import {
  AssetStatus,
  findAssetById,
  findAssetBySymbol,
  insertProvisioningAsset,
  markAssetActive,
  markAssetFailed,
  type AssetRecord,
} from '../../db/repositories/asset-repository.js';
import { recordAuditEvent } from '../../db/repositories/audit-repository.js';
import { AppError, ErrorCode, NotFoundError, ValidationError } from '../../domain/errors.js';
import { AppRole } from '../../domain/roles.js';
import { requireRole } from '../../platform/auth/authorize.js';
import { isUniqueViolation } from '../../db/errors.js';
import type { RequestContext } from '../context.js';

export interface CreateAssetInput {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** Base units, decimal string. */
  readonly supplyCap: string;
}

export interface AssetServiceDeps {
  readonly db: Database;
  readonly gateway: EvmGateway;
  readonly signer: SignerProvider;
  readonly chainWriter: ChainWriter;
  readonly chainId: number;
  readonly confirmation: ConfirmationPolicy;
}

/**
 * Owns tokenized asset definitions and their one-time contract provisioning.
 *
 * Deployment is a privileged administrative action rather than a monetary one, so it
 * runs synchronously; the mint path is the one that goes through the durable outbox.
 */
export class AssetService {
  constructor(private readonly deps: AssetServiceDeps) {}

  async createAsset(ctx: RequestContext, input: CreateAssetInput): Promise<AssetRecord> {
    requireRole(ctx.actor, [AppRole.ISSUER, AppRole.ADMIN], 'create an asset');

    if (BigInt(input.supplyCap) <= 0n) {
      throw new ValidationError('supplyCap must be greater than zero');
    }

    // Step 1: record the intent. The asset exists in PROVISIONING before any chain
    // interaction, so a deployment that succeeds while we crash is still traceable.
    const asset = await this.deps.db
      .transaction(async (tx) => {
        const created = await insertProvisioningAsset(tx, {
          organizationId: ctx.actor.organizationId,
          symbol: input.symbol,
          name: input.name,
          decimals: input.decimals,
          supplyCap: input.supplyCap,
          chainId: this.deps.chainId,
          createdBy: ctx.actor.id,
        });
        await recordAuditEvent(tx, {
          actor: ctx.actor,
          action: 'asset.created',
          resourceType: 'asset',
          resourceId: created.id,
          correlationId: ctx.correlationId,
          metadata: {
            symbol: created.symbol,
            decimals: created.decimals,
            supplyCap: created.supplyCap,
            chainId: created.chainId,
          },
        });
        return created;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new AppError(
            ErrorCode.OPERATION_CONFLICT,
            'an asset with this symbol already exists for the organization',
            { details: { symbol: input.symbol } },
          );
        }
        throw error;
      });

    try {
      return await this.provision(ctx, asset);
    } catch (error) {
      await this.deps.db.transaction(async (tx) => {
        await markAssetFailed(tx, asset.id);
        await recordAuditEvent(tx, {
          actor: ctx.actor,
          action: 'asset.provisioning_failed',
          resourceType: 'asset',
          resourceId: asset.id,
          correlationId: ctx.correlationId,
          metadata: { reason: error instanceof Error ? error.message : 'unknown' },
        });
      });
      throw error;
    }
  }

  private async provision(ctx: RequestContext, asset: AssetRecord): Promise<AssetRecord> {
    const signerAddress = await this.deps.signer.getSignerAddress();

    // The orchestrator's signer holds every on-chain role for the MVP. These are EVM
    // roles and are unrelated to the application roles held by human actors.
    const call = this.deps.gateway.encodeTokenDeployment({
      name: asset.name,
      symbol: asset.symbol,
      decimals: asset.decimals,
      supplyCap: BigInt(asset.supplyCap),
      admin: signerAddress,
      minter: signerAddress,
      complianceOfficer: signerAddress,
      pauser: signerAddress,
    });

    const outcome = await this.deps.chainWriter.execute({
      purpose: 'DEPLOY_TOKEN',
      call,
      operationId: null,
      assetId: asset.id,
      walletId: null,
      correlationId: ctx.correlationId,
      evidence: { assetId: asset.id, symbol: asset.symbol, actorId: ctx.actor.id },
    });

    if (outcome.kind !== 'SUBMITTED') {
      throw new AppError(ErrorCode.CHAIN_UNAVAILABLE, 'token deployment could not be submitted', {
        details: { assetId: asset.id, outcome: outcome.kind },
      });
    }

    const confirmation = await awaitConfirmation(
      this.deps.gateway,
      outcome.transactionHash as `0x${string}`,
      this.deps.confirmation,
    );
    if (confirmation.kind !== 'CONFIRMED') {
      throw new AppError(ErrorCode.CHAIN_UNAVAILABLE, 'token deployment did not confirm', {
        details: { assetId: asset.id, outcome: confirmation.kind },
      });
    }

    const contractAddress = confirmation.receipt.contractAddress;
    if (contractAddress === null) {
      throw new AppError(ErrorCode.CHAIN_IDENTITY_MISMATCH, 'deployment receipt has no contract address');
    }
    // Independent confirmation that code actually exists at the reported address.
    await this.deps.gateway.assertContractDeployed(contractAddress);

    return this.deps.db.transaction(async (tx) => {
      await markAssetActive(tx, {
        assetId: asset.id,
        contractAddress,
        deploymentTxHash: outcome.transactionHash,
      });
      await recordAuditEvent(tx, {
        actor: ctx.actor,
        action: 'asset.deployed',
        resourceType: 'asset',
        resourceId: asset.id,
        correlationId: ctx.correlationId,
        metadata: {
          contractAddress,
          transactionHash: outcome.transactionHash,
          blockNumber: confirmation.receipt.blockNumber,
        },
      });

      const updated = await findAssetById(tx, asset.id);
      if (updated === null) throw new Error('asset disappeared during provisioning');
      return updated;
    });
  }

  async getAsset(ctx: RequestContext, assetId: string): Promise<AssetRecord> {
    requireRole(
      ctx.actor,
      [AppRole.ISSUER, AppRole.ADMIN, AppRole.APPROVER, AppRole.COMPLIANCE_OFFICER, AppRole.AUDITOR],
      'read an asset',
    );
    const asset = await findAssetById(this.deps.db, assetId);
    if (asset === null || asset.organizationId !== ctx.actor.organizationId) {
      throw new NotFoundError('asset', assetId);
    }
    return asset;
  }

  async requireActiveAsset(assetId: string, organizationId: string): Promise<AssetRecord> {
    const asset = await findAssetById(this.deps.db, assetId);
    if (asset === null || asset.organizationId !== organizationId) {
      throw new NotFoundError('asset', assetId);
    }
    if (asset.status === AssetStatus.PAUSED) {
      throw new AppError(ErrorCode.ASSET_PAUSED, 'asset is paused', { details: { assetId } });
    }
    if (asset.status !== AssetStatus.ACTIVE || asset.contractAddress === null) {
      throw new AppError(ErrorCode.ASSET_NOT_ACTIVE, 'asset is not active', {
        details: { assetId, status: asset.status },
      });
    }
    return asset;
  }

  async findBySymbol(organizationId: string, symbol: string): Promise<AssetRecord | null> {
    return findAssetBySymbol(this.deps.db, organizationId, symbol);
  }
}
