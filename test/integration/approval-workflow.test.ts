import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createHarness,
  requestMint,
  seedAssetAndWallet,
  type SeededAsset,
  type TestHarness,
} from './helpers.js';
import { approvalDecisions, assets, operations, outbox } from '../../src/db/schema/index.js';
import { OperationState } from '../../src/domain/operation-state.js';

describe('two-person approval workflow', () => {
  let harness: TestHarness;
  let seed: SeededAsset;

  beforeAll(async () => {
    // No worker runs in this suite, so operations stay in READY and can be inspected.
    harness = await createHarness();
    seed = await seedAssetAndWallet(harness);
  });

  afterAll(async () => {
    await harness.close();
  });

  const decide = (
    requestId: string,
    subject: 'dev-approver-1' | 'dev-approver-2' | 'dev-compliance',
    decision: 'APPROVE' | 'REJECT' = 'APPROVE',
  ) =>
    harness.app.inject({
      method: 'POST',
      url: `/v1/approval-requests/${requestId}/decisions`,
      headers: harness.auth(subject),
      payload: { decision },
    });

  it('requires two distinct approvals before an operation becomes READY', async () => {
    const mint = await requestMint(harness, seed);

    const first = await decide(mint.approvalRequestId, 'dev-approver-1');
    expect(first.statusCode).toBe(200);
    expect(first.json<{ operationState: string }>().operationState).toBe(
      OperationState.PENDING_APPROVAL,
    );

    const second = await decide(mint.approvalRequestId, 'dev-approver-2');
    expect(second.statusCode).toBe(200);
    expect(second.json<{ operationState: string }>().operationState).toBe(OperationState.READY);
  });

  it('refuses a second decision from the same approver', async () => {
    const mint = await requestMint(harness, seed);
    expect((await decide(mint.approvalRequestId, 'dev-approver-1')).statusCode).toBe(200);

    const duplicate = await decide(mint.approvalRequestId, 'dev-approver-1');
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ error: { code: string } }>().error.code).toBe(
      'APPROVAL_ALREADY_RECORDED',
    );
  });

  it('refuses self-approval by the requester', async () => {
    const mint = await requestMint(harness, seed);
    // dev-issuer requested the mint and also holds no APPROVER role, but an ADMIN who
    // requested an operation must not be able to approve it either.
    const selfApproval = await harness.app.inject({
      method: 'POST',
      url: `/v1/approval-requests/${mint.approvalRequestId}/decisions`,
      headers: harness.auth('dev-issuer'),
      payload: { decision: 'APPROVE' },
    });
    expect(selfApproval.statusCode).toBe(403);
  });

  it('enforces the self-approval prohibition in the database itself', async () => {
    const mint = await requestMint(harness, seed);
    const [operation] = await harness.container.db
      .select()
      .from(operations)
      .where(eq(operations.id, mint.operationId));

    // Bypass the service entirely: the CHECK constraint must still refuse the row.
    await expect(
      harness.container.db.insert(approvalDecisions).values({
        approvalRequestId: mint.approvalRequestId,
        approverId: operation!.requestedBy,
        operationRequestedBy: operation!.requestedBy,
        decision: 'APPROVE',
        proposalHash: operation!.proposalHash,
        comment: null,
      }),
    ).rejects.toThrow(/approval_decisions_no_self_approval/);
  });

  it('cannot forge the recorded requester to sidestep the self-approval check', async () => {
    const mint = await requestMint(harness, seed);
    const [operation] = await harness.container.db
      .select()
      .from(operations)
      .where(eq(operations.id, mint.operationId));

    // Claiming a different requester breaks the composite foreign key back to
    // approval_requests(id, requested_by).
    await expect(
      harness.container.db.insert(approvalDecisions).values({
        approvalRequestId: mint.approvalRequestId,
        approverId: operation!.requestedBy,
        operationRequestedBy: harness.users['dev-approver-1']!.record.id,
        decision: 'APPROVE',
        proposalHash: operation!.proposalHash,
        comment: null,
      }),
    ).rejects.toThrow(/approval_decisions_requester_fk/);
  });

  it('records exactly one approval when two approvers decide simultaneously', async () => {
    const mint = await requestMint(harness, seed);

    const [first, second] = await Promise.all([
      decide(mint.approvalRequestId, 'dev-approver-1'),
      decide(mint.approvalRequestId, 'dev-approver-2'),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    // Whichever committed second observed the first one's row and closed the request.
    const states = [
      first.json<{ operationState: string }>().operationState,
      second.json<{ operationState: string }>().operationState,
    ];
    expect(states).toContain(OperationState.READY);
    expect(states.filter((state) => state === OperationState.READY)).toHaveLength(1);

    const decisions = await harness.container.db
      .select()
      .from(approvalDecisions)
      .where(eq(approvalDecisions.approvalRequestId, mint.approvalRequestId));
    expect(decisions).toHaveLength(2);

    // Exactly one outbox row was produced, so the mint can only be executed once.
    const rows = await harness.container.db
      .select()
      .from(outbox)
      .where(eq(outbox.aggregateId, mint.operationId));
    expect(rows).toHaveLength(1);
  });

  it('handles a burst of simultaneous approvals without over-approving', async () => {
    const mint = await requestMint(harness, seed);

    const responses = await Promise.all([
      decide(mint.approvalRequestId, 'dev-approver-1'),
      decide(mint.approvalRequestId, 'dev-approver-1'),
      decide(mint.approvalRequestId, 'dev-approver-2'),
      decide(mint.approvalRequestId, 'dev-approver-2'),
    ]);

    const ok = responses.filter((response) => response.statusCode === 200);
    expect(ok.length).toBeGreaterThanOrEqual(2);

    const decisions = await harness.container.db
      .select()
      .from(approvalDecisions)
      .where(eq(approvalDecisions.approvalRequestId, mint.approvalRequestId));
    // One row per approver at most, regardless of how many requests arrived.
    expect(decisions).toHaveLength(2);

    const rows = await harness.container.db
      .select()
      .from(outbox)
      .where(eq(outbox.aggregateId, mint.operationId));
    expect(rows).toHaveLength(1);
  });

  it('cancels the operation when an approver rejects', async () => {
    const mint = await requestMint(harness, seed);
    const rejection = await decide(mint.approvalRequestId, 'dev-approver-1', 'REJECT');

    expect(rejection.statusCode).toBe(200);
    expect(rejection.json<{ operationState: string }>().operationState).toBe(
      OperationState.CANCELLED,
    );

    const later = await decide(mint.approvalRequestId, 'dev-approver-2');
    expect(later.statusCode).toBe(409);
    expect(later.json<{ error: { code: string } }>().error.code).toBe('APPROVAL_REQUEST_CLOSED');
  });

  it('does not both approve and cancel when a rejection races the final approval', async () => {
    const mint = await requestMint(harness, seed);
    expect((await decide(mint.approvalRequestId, 'dev-approver-1')).statusCode).toBe(200);

    const [approval, rejection] = await Promise.all([
      decide(mint.approvalRequestId, 'dev-approver-2', 'APPROVE'),
      decide(mint.approvalRequestId, 'dev-approver-2', 'REJECT'),
    ]);

    const accepted = [approval, rejection].filter((response) => response.statusCode === 200);
    expect(accepted).toHaveLength(1);

    const [operation] = await harness.container.db
      .select()
      .from(operations)
      .where(eq(operations.id, mint.operationId));
    expect([OperationState.READY, OperationState.CANCELLED]).toContain(operation!.state);
    expect(accepted[0]!.json<{ operationState: string }>().operationState).toBe(operation!.state);
  });

  it('supersedes approvals when the financial intent changes', async () => {
    const mint = await requestMint(harness, seed);
    expect((await decide(mint.approvalRequestId, 'dev-approver-1')).statusCode).toBe(200);

    // Bump the policy version, which is part of the approved proposal snapshot.
    await harness.container.db
      .update(assets)
      .set({ policyVersion: 99 })
      .where(eq(assets.id, seed.assetId));

    const second = await decide(mint.approvalRequestId, 'dev-approver-2');
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('OPERATION_CONFLICT');

    const [operation] = await harness.container.db
      .select()
      .from(operations)
      .where(eq(operations.id, mint.operationId));
    expect(operation!.state).toBe(OperationState.PENDING_APPROVAL);

    await harness.container.db
      .update(assets)
      .set({ policyVersion: 1 })
      .where(eq(assets.id, seed.assetId));
  });

  it('rejects approval attempts from an actor without the APPROVER role', async () => {
    const mint = await requestMint(harness, seed);
    const response = await decide(mint.approvalRequestId, 'dev-compliance');
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
  });

  it('rejects unauthenticated approval attempts', async () => {
    const mint = await requestMint(harness, seed);
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/approval-requests/${mint.approvalRequestId}/decisions`,
      payload: { decision: 'APPROVE' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
  });
});
