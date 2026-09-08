import type { Database } from '../../db/pool.js';
import {
  closeApprovalRequest,
  findApprovalRequestById,
  insertApprovalDecision,
  listDecisions,
  lockApprovalRequest,
} from '../../db/repositories/approval-repository.js';
import {
  findOperationById,
  lockOperation,
  transitionOperation,
} from '../../db/repositories/operation-repository.js';
import { findAssetById } from '../../db/repositories/asset-repository.js';
import { findWalletById } from '../../db/repositories/wallet-repository.js';
import { enqueueOutbox, OutboxTopic } from '../../db/repositories/outbox-repository.js';
import { recordAuditEvent } from '../../db/repositories/audit-repository.js';
import {
  ApprovalDecisionKind,
  ApprovalRequestState,
  evaluateApprovalOutcome,
} from '../../domain/approval-state.js';
import { OperationState } from '../../domain/operation-state.js';
import { AppError, ErrorCode, NotFoundError } from '../../domain/errors.js';
import { AppRole } from '../../domain/roles.js';
import { requireRole } from '../../platform/auth/authorize.js';
import { isCheckViolation, isUniqueViolation } from '../../db/errors.js';
import { rebuildMintProposal } from '../operations/mint-service.js';
import type { RequestContext } from '../context.js';
import type { Metrics } from '../../platform/metrics/index.js';

export interface RecordApprovalInput {
  readonly approvalRequestId: string;
  readonly decision: 'APPROVE' | 'REJECT';
  readonly comment?: string | undefined;
}

export interface RecordApprovalResult {
  readonly approvalRequestId: string;
  readonly operationId: string;
  readonly approvalRequestState: string;
  readonly operationState: string;
  readonly approvalsRecorded: number;
  readonly requiredApprovals: number;
}

/**
 * Two-person approval workflow for mint operations.
 *
 * Correctness rests on the database, not on this code being called carefully:
 *  - the request row is locked for the whole decision, so simultaneous approvals
 *    serialise and the threshold is evaluated exactly once;
 *  - UNIQUE (approval_request_id, approver_id) makes one actor unable to supply two
 *    approvals;
 *  - a CHECK backed by a composite foreign key makes self-approval impossible.
 */
export class ApprovalService {
  constructor(
    private readonly db: Database,
    private readonly metrics: Metrics,
  ) {}

  async recordDecision(
    ctx: RequestContext,
    input: RecordApprovalInput,
  ): Promise<RecordApprovalResult> {
    requireRole(ctx.actor, [AppRole.APPROVER, AppRole.ADMIN], 'record an approval decision');

    const preview = await findApprovalRequestById(this.db, input.approvalRequestId);
    if (preview === null) throw new NotFoundError('approval_request', input.approvalRequestId);

    const operationPreview = await findOperationById(this.db, preview.operationId);
    if (operationPreview === null || operationPreview.organizationId !== ctx.actor.organizationId) {
      throw new NotFoundError('approval_request', input.approvalRequestId);
    }

    return this.db.transaction(async (tx) => {
      const request = await lockApprovalRequest(tx, input.approvalRequestId);
      if (request === null) throw new NotFoundError('approval_request', input.approvalRequestId);

      if (request.state !== ApprovalRequestState.PENDING) {
        throw new AppError(
          ErrorCode.APPROVAL_REQUEST_CLOSED,
          'approval request is no longer open',
          { details: { approvalRequestId: request.id, state: request.state } },
        );
      }

      // Fail fast with the precise code; the database CHECK is the real guarantee.
      if (request.requestedBy === ctx.actor.id) {
        throw new AppError(
          ErrorCode.SELF_APPROVAL_NOT_ALLOWED,
          'the requester of an operation may not approve it',
          { details: { approvalRequestId: request.id } },
        );
      }

      const operation = await lockOperation(tx, request.operationId);
      if (operation === null) throw new NotFoundError('operation', request.operationId);
      if (operation.state !== OperationState.PENDING_APPROVAL) {
        throw new AppError(
          ErrorCode.INVALID_STATE_TRANSITION,
          'operation is no longer awaiting approval',
          { details: { operationId: operation.id, state: operation.state } },
        );
      }

      // The approval is bound to one exact financial intent. If the underlying asset or
      // wallet configuration changed, the snapshot no longer describes what would
      // happen, so the request is superseded instead of silently reused.
      const asset = await findAssetById(tx, operation.assetId);
      const wallet = await findWalletById(tx, operation.walletId);
      if (asset === null || wallet === null) {
        throw new NotFoundError('operation', operation.id);
      }
      const rebuilt = rebuildMintProposal({ operation, asset, wallet });
      if (rebuilt.hash !== request.proposalHash) {
        await closeApprovalRequest(tx, {
          id: request.id,
          state: ApprovalRequestState.SUPERSEDED,
        });
        await recordAuditEvent(tx, {
          actor: ctx.actor,
          action: 'approval.request_superseded',
          resourceType: 'approval_request',
          resourceId: request.id,
          operationId: operation.id,
          correlationId: ctx.correlationId,
          metadata: { expectedHash: request.proposalHash, currentHash: rebuilt.hash },
        });
        throw new AppError(
          ErrorCode.OPERATION_CONFLICT,
          'the financial intent changed; previous approvals are void',
          { details: { approvalRequestId: request.id } },
        );
      }

      try {
        await insertApprovalDecision(tx, {
          approvalRequestId: request.id,
          approverId: ctx.actor.id,
          operationRequestedBy: request.requestedBy,
          decision: input.decision,
          proposalHash: request.proposalHash,
          comment: input.comment ?? null,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'approval_decisions_one_per_approver')) {
          throw new AppError(
            ErrorCode.APPROVAL_ALREADY_RECORDED,
            'this approver has already recorded a decision for this request',
            { details: { approvalRequestId: request.id } },
          );
        }
        if (isCheckViolation(error, 'approval_decisions_no_self_approval')) {
          throw new AppError(
            ErrorCode.SELF_APPROVAL_NOT_ALLOWED,
            'the requester of an operation may not approve it',
            { details: { approvalRequestId: request.id } },
          );
        }
        throw error;
      }

      const decisions = await listDecisions(tx, request.id);
      const outcome = evaluateApprovalOutcome({
        requiredApprovals: request.requiredApprovals,
        approverIds: decisions
          .filter((decision) => decision.decision === ApprovalDecisionKind.APPROVE)
          .map((decision) => decision.approverId),
        hasRejection: decisions.some(
          (decision) => decision.decision === ApprovalDecisionKind.REJECT,
        ),
      });

      await recordAuditEvent(tx, {
        actor: ctx.actor,
        action: 'approval.decision_recorded',
        resourceType: 'approval_request',
        resourceId: request.id,
        operationId: operation.id,
        correlationId: ctx.correlationId,
        metadata: {
          decision: input.decision,
          proposalHash: request.proposalHash,
          outcome: outcome.kind,
          decisionsRecorded: decisions.length,
        },
      });

      let operationState: string = operation.state;
      let requestState: string = request.state;

      if (outcome.kind === 'APPROVED') {
        await closeApprovalRequest(tx, { id: request.id, state: ApprovalRequestState.APPROVED });
        const ready = await transitionOperation(tx, {
          operation,
          to: OperationState.READY,
        });
        this.metrics.operationTransitions.inc({
          from: operation.state,
          to: OperationState.READY,
          type: operation.type,
        });

        // Business state and the asynchronous work item commit together. If this
        // transaction rolls back, no job is ever produced; if it commits, the work
        // survives even with Redis wiped.
        await enqueueOutbox(tx, {
          topic: OutboxTopic.MINT_OPERATION_READY,
          aggregateType: 'operation',
          aggregateId: operation.id,
          payload: { operationId: operation.id },
          correlationId: operation.correlationId,
        });

        await recordAuditEvent(tx, {
          actor: ctx.actor,
          action: 'operation.approved',
          resourceType: 'operation',
          resourceId: operation.id,
          operationId: operation.id,
          correlationId: ctx.correlationId,
          metadata: { approvals: request.requiredApprovals },
        });

        operationState = ready.state;
        requestState = ApprovalRequestState.APPROVED;
      } else if (outcome.kind === 'REJECTED') {
        await closeApprovalRequest(tx, { id: request.id, state: ApprovalRequestState.REJECTED });
        const cancelled = await transitionOperation(tx, {
          operation,
          to: OperationState.CANCELLED,
          patch: { failureCode: 'APPROVAL_REJECTED', failureReason: 'an approver rejected' },
        });
        await recordAuditEvent(tx, {
          actor: ctx.actor,
          action: 'operation.cancelled',
          resourceType: 'operation',
          resourceId: operation.id,
          operationId: operation.id,
          correlationId: ctx.correlationId,
          metadata: { reason: 'APPROVAL_REJECTED' },
        });
        operationState = cancelled.state;
        requestState = ApprovalRequestState.REJECTED;
      }

      return {
        approvalRequestId: request.id,
        operationId: operation.id,
        approvalRequestState: requestState,
        operationState,
        approvalsRecorded: decisions.filter(
          (decision) => decision.decision === ApprovalDecisionKind.APPROVE,
        ).length,
        requiredApprovals: request.requiredApprovals,
      };
    });
  }
}
