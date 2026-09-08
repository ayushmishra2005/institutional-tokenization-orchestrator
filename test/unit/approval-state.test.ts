import { describe, expect, it } from 'vitest';
import {
  APPROVAL_REQUEST_STATES,
  ApprovalRequestState,
  assertApprovalRequestTransition,
  canTransitionApprovalRequest,
  evaluateApprovalOutcome,
  isApprovalRequestOpen,
  REQUIRED_MINT_APPROVALS,
} from '../../src/domain/approval-state.js';
import { InvalidStateTransitionError } from '../../src/domain/errors.js';

describe('approval request state machine', () => {
  it('can close a pending request in each valid way', () => {
    for (const target of [
      ApprovalRequestState.APPROVED,
      ApprovalRequestState.REJECTED,
      ApprovalRequestState.SUPERSEDED,
      ApprovalRequestState.CANCELLED,
    ]) {
      expect(canTransitionApprovalRequest(ApprovalRequestState.PENDING, target)).toBe(true);
    }
  });

  it('cannot reopen a closed request', () => {
    for (const state of APPROVAL_REQUEST_STATES.filter(
      (candidate) => candidate !== ApprovalRequestState.PENDING,
    )) {
      expect(canTransitionApprovalRequest(state, ApprovalRequestState.PENDING)).toBe(false);
      expect(() =>
        assertApprovalRequestTransition(state, ApprovalRequestState.APPROVED),
      ).toThrow(InvalidStateTransitionError);
    }
  });

  it('reports open state only for PENDING', () => {
    expect(isApprovalRequestOpen(ApprovalRequestState.PENDING)).toBe(true);
    expect(isApprovalRequestOpen(ApprovalRequestState.APPROVED)).toBe(false);
  });
});

describe('approval threshold', () => {
  it('requires two approvals for a mint', () => {
    expect(REQUIRED_MINT_APPROVALS).toBe(2);
  });

  it('stays pending with a single approval', () => {
    const outcome = evaluateApprovalOutcome({
      requiredApprovals: 2,
      approverIds: ['approver-1'],
      hasRejection: false,
    });
    expect(outcome).toEqual({ kind: 'PENDING', remaining: 1 });
  });

  it('approves once two distinct approvers have signed off', () => {
    const outcome = evaluateApprovalOutcome({
      requiredApprovals: 2,
      approverIds: ['approver-1', 'approver-2'],
      hasRejection: false,
    });
    expect(outcome).toEqual({ kind: 'APPROVED' });
  });

  it('does not let one approver satisfy the threshold twice', () => {
    const outcome = evaluateApprovalOutcome({
      requiredApprovals: 2,
      approverIds: ['approver-1', 'approver-1'],
      hasRejection: false,
    });
    expect(outcome).toEqual({ kind: 'PENDING', remaining: 1 });
  });

  it('a rejection overrides collected approvals', () => {
    const outcome = evaluateApprovalOutcome({
      requiredApprovals: 2,
      approverIds: ['approver-1', 'approver-2'],
      hasRejection: true,
    });
    expect(outcome).toEqual({ kind: 'REJECTED' });
  });

  it('is pending with no decisions at all', () => {
    expect(
      evaluateApprovalOutcome({ requiredApprovals: 2, approverIds: [], hasRejection: false }),
    ).toEqual({ kind: 'PENDING', remaining: 2 });
  });
});
