import type { Database, Transaction } from '../../db/pool.js';
import {
  AssetStatus,
  findAssetById,
  findAssetBySymbol,
  insertProvisioningAsset,
  type AssetRecord,
} from '../../db/repositories/asset-repository.js';
import {
  findLiveAdministrativeOperation,
  insertAdministrativeOperation,
  type OperationRecord,
} from '../../db/repositories/operation-repository.js';
import { enqueueOutbox, OutboxTopic } from '../../db/repositories/outbox-repository.js';
import { recordAuditEvent } from '../../db/repositories/audit-repository.js';
import { AppError, ErrorCode, NotFoundError, ValidationError } from '../../domain/errors.js';
import { AppRole } from '../../domain/roles.js';
import { requireRole } from '../../platform/auth/authorize.js';
import { isUniqueViolation } from '../../db/errors.js';
import { hashAssetDeploymentIntent } from '../operations/administrative-intent.js';
import type { RequestContext } from '../context.js';

export interface CreateAssetInput {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** Base units, decimal string. */
  readonly supplyCap: string;
}

export interface CreateAssetResult {
  readonly asset: AssetRecord;
  readonly operationId: string;
}

/**
 * Owns tokenized asset definitions. Contract deployment is a chain write like any other:
 * this service records the intent and hands it to the worker, so the HTTP request never
 * waits for a block.
 */
export class AssetService {
  constructor(private readonly deps: { db: Database; chainId: number }) {}

  async createAsset(ctx: RequestContext, input: CreateAssetInput): Promise<CreateAssetResult> {
    requireRole(ctx.actor, [AppRole.ISSUER, AppRole.ADMIN], 'create an asset');

    if (BigInt(input.supplyCap) <= 0n) {
      throw new ValidationError('supplyCap must be greater than zero');
    }

    return this.deps.db
      .transaction(async (tx) => {
        const asset = await insertProvisioningAsset(tx, {
          organizationId: ctx.actor.organizationId,
          symbol: input.symbol,
          name: input.name,
          decimals: input.decimals,
          supplyCap: input.supplyCap,
          chainId: this.deps.chainId,
          createdBy: ctx.actor.id,
        });

        const operation = await this.enqueueDeployment(tx, ctx, asset);

        await recordAuditEvent(tx, {
          actor: ctx.actor,
          action: 'asset.created',
          resourceType: 'asset',
          resourceId: asset.id,
          operationId: operation.id,
          correlationId: ctx.correlationId,
          metadata: {
            symbol: asset.symbol,
            decimals: asset.decimals,
            supplyCap: asset.supplyCap,
            chainId: asset.chainId,
          },
        });

        return { asset, operationId: operation.id };
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
  }

  /**
   * Re-requests deployment for an asset whose provisioning operation ended terminally.
   * Reuses the live operation when one already exists so a retry cannot deploy twice.
   */
  async requestDeployment(ctx: RequestContext, assetId: string): Promise<OperationRecord> {
    requireRole(ctx.actor, [AppRole.ISSUER, AppRole.ADMIN], 'deploy an asset contract');
    const asset = await this.getAsset(ctx, assetId);

    if (asset.contractAddress !== null) {
      throw new AppError(ErrorCode.OPERATION_CONFLICT, 'asset already has a deployed contract', {
        details: { assetId, contractAddress: asset.contractAddress },
      });
    }

    return this.deps.db.transaction(async (tx) => {
      const live = await findLiveAdministrativeOperation(tx, {
        type: 'DEPLOY_ASSET',
        assetId: asset.id,
      });
      if (live !== null) return live;
      return this.enqueueDeployment(tx, ctx, asset);
    });
  }

  private async enqueueDeployment(
    tx: Transaction,
    ctx: RequestContext,
    asset: AssetRecord,
  ): Promise<OperationRecord> {
    const operation = await insertAdministrativeOperation(tx, {
      type: 'DEPLOY_ASSET',
      organizationId: ctx.actor.organizationId,
      assetId: asset.id,
      proposalHash: hashAssetDeploymentIntent(asset),
      requestedBy: ctx.actor.id,
      correlationId: ctx.correlationId,
    });

    // Committed with the asset row, so the deployment cannot be lost even if this process
    // dies before the dispatcher runs.
    await enqueueOutbox(tx, {
      topic: OutboxTopic.OPERATION_READY,
      aggregateType: 'operation',
      aggregateId: operation.id,
      payload: { operationId: operation.id },
      correlationId: ctx.correlationId,
    });

    return operation;
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
