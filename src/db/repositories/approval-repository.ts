import { and, eq } from 'drizzle-orm';
import type { Executor, Transaction } from '../pool.js';
import { approvalDecisions, approvalRequests } from '../schema/index.js';
import { ApprovalRequestState } from '../../domain/approval-state.js';
import type { MintProposalSnapshot } from '../../domain/mint-proposal.js';

export interface ApprovalRequestRecord {
  readonly id: string;
  readonly operationId: string;
  readonly state: string;
  readonly requiredApprovals: number;
  readonly proposalSnapshot: unknown;
  readonly proposalHash: string;
  readonly requestedBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly closedAt: Date | null;
}

export interface ApprovalDecisionRecord {
  readonly id: string;
  readonly approvalRequestId: string;
  readonly approverId: string;
  readonly operationRequestedBy: string;
  readonly decision: string;
  readonly proposalHash: string;
  readonly comment: string | null;
  readonly createdAt: Date;
}

export async function insertApprovalRequest(
  executor: Executor,
  input: {
    operationId: string;
    requiredApprovals: number;
    proposalSnapshot: MintProposalSnapshot;
    proposalHash: string;
    requestedBy: string;
  },
): Promise<ApprovalRequestRecord> {
  const [row] = await executor
    .insert(approvalRequests)
    .values({ ...input, state: ApprovalRequestState.PENDING })
    .returning();
  if (row === undefined) throw new Error('failed to insert approval request');
  return row;
}

export async function findApprovalRequestById(
  executor: Executor,
  id: string,
): Promise<ApprovalRequestRecord | null> {
  const [row] = await executor
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Locks the approval request for the duration of a decision.
 *
 * Two approvers submitting simultaneously serialise here, so the second one observes
 * the first one's decision and the threshold is evaluated exactly once.
 */
export async function lockApprovalRequest(
  tx: Transaction,
  id: string,
): Promise<ApprovalRequestRecord | null> {
  const [row] = await tx
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id))
    .limit(1)
    .for('update');
  return row ?? null;
}

export async function findOpenApprovalRequestForOperation(
  executor: Executor,
  operationId: string,
): Promise<ApprovalRequestRecord | null> {
  const [row] = await executor
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.operationId, operationId),
        eq(approvalRequests.state, ApprovalRequestState.PENDING),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function closeApprovalRequest(
  executor: Executor,
  input: { id: string; state: ApprovalRequestState },
): Promise<void> {
  const now = new Date();
  await executor
    .update(approvalRequests)
    .set({ state: input.state, updatedAt: now, closedAt: now })
    .where(eq(approvalRequests.id, input.id));
}

export async function insertApprovalDecision(
  executor: Executor,
  input: {
    approvalRequestId: string;
    approverId: string;
    operationRequestedBy: string;
    decision: string;
    proposalHash: string;
    comment: string | null;
  },
): Promise<ApprovalDecisionRecord> {
  const [row] = await executor.insert(approvalDecisions).values(input).returning();
  if (row === undefined) throw new Error('failed to insert approval decision');
  return row;
}

export async function listDecisions(
  executor: Executor,
  approvalRequestId: string,
): Promise<ApprovalDecisionRecord[]> {
  return executor
    .select()
    .from(approvalDecisions)
    .where(eq(approvalDecisions.approvalRequestId, approvalRequestId))
    .orderBy(approvalDecisions.createdAt);
}
