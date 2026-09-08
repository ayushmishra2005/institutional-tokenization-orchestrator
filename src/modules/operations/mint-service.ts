import { randomUUID } from 'node:crypto';
import type { Database } from '../../db/pool.js';
import { operations } from '../../db/schema/index.js';
import type { IdempotencyService } from '../idempotency/idempotency-service.js';
import type { AssetService } from '../assets/asset-service.js';
import { findWalletById } from '../../db/repositories/wallet-repository.js';
import { findActiveApproval } from '../../db/repositories/compliance-repository.js';
import { insertApprovalRequest } from '../../db/repositories/approval-repository.js';
import {
  findOperationById,
  recordOperationTransition,
  type OperationRecord,
} from '../../db/repositories/operation-repository.js';
import { recordAuditEvent } from '../../db/repositories/audit-repository.js';
import { AppError, ErrorCode, NotFoundError, ValidationError } from '../../domain/errors.js';
import { AppRole } from '../../domain/roles.js';
import { requireRole } from '../../platform/auth/authorize.js';
import { OperationState } from '../../domain/operation-state.js';
import { REQUIRED_MINT_APPROVALS } from '../../domain/approval-state.js';
import {
  deriveOperationReference,
  hashMintProposal,
  type MintProposalSnapshot,
} from '../../domain/mint-proposal.js';
import type { RequestContext } from '../context.js';

export const MINT_IDEMPOTENCY_SCOPE = 'POST /v1/assets/{assetId}/mints';

export interface RequestMintInput {
  readonly assetId: string;
  readonly walletId: string;
  /** Base units, decimal string. */
  readonly amount: string;
  readonly idempotencyKey: string;
}

export interface RequestMintResult {
  readonly operationId: string;
  readonly approvalRequestId: string;
  readonly state: string;
  readonly requiredApprovals: number;
  readonly replayed: boolean;
  readonly httpStatus: number;
}

/**
 * Creates mint operations and the approval request that gates them.
 *
 * Nothing here touches the chain. The API's job is to durably record an approved-by-
 * nobody-yet intent; execution is the worker's responsibility once approvals land.
 */
export class MintService {
  constructor(
    private readonly db: Database,
    private readonly idempotency: IdempotencyService,
    private readonly assets: AssetService,
  ) {}

  async requestMint(ctx: RequestContext, input: RequestMintInput): Promise<RequestMintResult> {
    requireRole(ctx.actor, [AppRole.ISSUER, AppRole.ADMIN], 'request a mint');

    let amount: bigint;
    try {
      amount = BigInt(input.amount);
    } catch {
      throw new ValidationError('amount must be an integer string in base units');
    }
    if (amount <= 0n) throw new ValidationError('amount must be greater than zero');

    const asset = await this.assets.requireActiveAsset(input.assetId, ctx.actor.organizationId);

    const wallet = await findWalletById(this.db, input.walletId);
    if (wallet === null || wallet.organizationId !== ctx.actor.organizationId) {
      throw new NotFoundError('wallet', input.walletId);
    }
    if (wallet.chainId !== asset.chainId) {
      throw new ValidationError('wallet and asset are on different chains');
    }
    if (wallet.status !== 'REGISTERED') {
      throw new AppError(ErrorCode.COMPLIANCE_NOT_ELIGIBLE, 'wallet is blocked', {
        details: { walletId: wallet.id, status: wallet.status },
      });
    }

    // A mint may only be proposed for a wallet that is currently approved. Eligibility
    // is checked again, freshly, by the worker before anything is signed.
    const decision = await findActiveApproval(this.db, {
      walletId: wallet.id,
      assetId: asset.id,
      at: new Date(),
    });
    if (decision === null) {
      throw new AppError(
        ErrorCode.COMPLIANCE_NOT_ELIGIBLE,
        'wallet has no valid compliance approval',
        { details: { walletId: wallet.id, assetId: asset.id } },
      );
    }

    const outcome = await this.idempotency.execute(
      {
        identity: {
          scope: MINT_IDEMPOTENCY_SCOPE,
          organizationId: ctx.actor.organizationId,
          actorId: ctx.actor.id,
          idempotencyKey: input.idempotencyKey,
        },
        request: {
          assetId: input.assetId,
          walletId: input.walletId,
          amount: amount.toString(),
        },
      },
      async (tx) => {
        const operationId = randomUUID();
        const operationReference = deriveOperationReference(operationId);

        const snapshot: MintProposalSnapshot = {
          kind: 'MINT',
          assetId: asset.id,
          chainId: asset.chainId,
          contractAddress: asset.contractAddress ?? '',
          walletId: wallet.id,
          recipientAddress: wallet.address,
          amount: amount.toString(),
          operationReference,
          policyVersion: asset.policyVersion,
          requiredApprovals: REQUIRED_MINT_APPROVALS,
        };
        const proposalHash = hashMintProposal(snapshot);

        const [operation] = await tx
          .insert(operations)
          .values({
            id: operationId,
            organizationId: ctx.actor.organizationId,
            type: 'MINT',
            state: OperationState.PENDING_APPROVAL,
            assetId: asset.id,
            walletId: wallet.id,
            amount: amount.toString(),
            operationReference,
            proposalHash,
            requiredApprovals: REQUIRED_MINT_APPROVALS,
            requestedBy: ctx.actor.id,
            correlationId: ctx.correlationId,
          })
          .returning();
        if (operation === undefined) throw new Error('failed to create mint operation');

        await recordOperationTransition(tx, {
          operationId: operation.id,
          from: null,
          to: OperationState.PENDING_APPROVAL,
        });

        const approvalRequest = await insertApprovalRequest(tx, {
          operationId: operation.id,
          requiredApprovals: REQUIRED_MINT_APPROVALS,
          proposalSnapshot: snapshot,
          proposalHash,
          requestedBy: ctx.actor.id,
        });

        await recordAuditEvent(tx, {
          actor: ctx.actor,
          action: 'operation.mint_requested',
          resourceType: 'operation',
          resourceId: operation.id,
          operationId: operation.id,
          correlationId: ctx.correlationId,
          metadata: {
            assetId: asset.id,
            walletId: wallet.id,
            amount: amount.toString(),
            operationReference,
            proposalHash,
            approvalRequestId: approvalRequest.id,
            complianceDecisionId: decision.id,
          },
        });

        return {
          status: 202,
          body: {
            operationId: operation.id,
            approvalRequestId: approvalRequest.id,
            state: operation.state,
            requiredApprovals: REQUIRED_MINT_APPROVALS,
          },
          resourceType: 'operation',
          resourceId: operation.id,
        };
      },
    );

    const body = outcome.body as {
      operationId: string;
      approvalRequestId: string;
      state: string;
      requiredApprovals: number;
    };
    return {
      operationId: body.operationId,
      approvalRequestId: body.approvalRequestId,
      state: body.state,
      requiredApprovals: body.requiredApprovals,
      replayed: outcome.replayed,
      httpStatus: outcome.status,
    };
  }

  async getOperation(ctx: RequestContext, operationId: string): Promise<OperationRecord> {
    const operation = await findOperationById(this.db, operationId);
    if (operation === null || operation.organizationId !== ctx.actor.organizationId) {
      throw new NotFoundError('operation', operationId);
    }
    return operation;
  }
}

/**
 * Rebuilds the approval proposal from current asset/wallet/operation state.
 *
 * Used at approval and execution time: if the recomputed hash no longer matches the one
 * the approvers signed off on, the financial intent has changed and the collected
 * approvals must not be reused.
 */
export function rebuildMintProposal(input: {
  operation: OperationRecord;
  asset: { id: string; chainId: number; contractAddress: string | null; policyVersion: number };
  wallet: { id: string; address: string };
}): { snapshot: MintProposalSnapshot; hash: string } {
  const snapshot: MintProposalSnapshot = {
    kind: 'MINT',
    assetId: input.asset.id,
    chainId: input.asset.chainId,
    contractAddress: input.asset.contractAddress ?? '',
    walletId: input.wallet.id,
    recipientAddress: input.wallet.address,
    amount: input.operation.amount ?? '',
    operationReference: input.operation.operationReference ?? '',
    policyVersion: input.asset.policyVersion,
    requiredApprovals: input.operation.requiredApprovals,
  };
  return { snapshot, hash: hashMintProposal(snapshot) };
}
