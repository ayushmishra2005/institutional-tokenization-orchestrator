import { describe, expect, it } from 'vitest';
import { classifyBroadcastError } from '../../src/modules/transactions/chain-writer.js';

describe('broadcast error classification', () => {
  it('treats a transaction the node already has as success', () => {
    expect(classifyBroadcastError(new Error('already known'))).toBe('ALREADY_KNOWN');
    expect(classifyBroadcastError(new Error('Transaction already exists'))).toBe('ALREADY_KNOWN');
  });

  it('treats structurally invalid transactions as deterministic rejections', () => {
    for (const message of [
      'intrinsic gas too low',
      'invalid sender',
      'insufficient funds for gas * price + value',
      'max fee per gas less than block base fee',
    ]) {
      expect(classifyBroadcastError(new Error(message)), message).toBe('DETERMINISTIC_REJECTION');
    }
  });

  it('treats a too-low nonce as ambiguous, not failed', () => {
    // Some transaction consumed the nonce. Whether it was ours can only be settled by
    // looking our hash up on chain, so this must never be reported as a failure.
    expect(classifyBroadcastError(new Error('nonce too low'))).toBe('AMBIGUOUS');
  });

  it('defaults to ambiguous for transport faults and unknown errors', () => {
    for (const message of [
      'socket hang up',
      'ETIMEDOUT',
      'fetch failed',
      'connection reset by peer',
      'something nobody anticipated',
    ]) {
      expect(classifyBroadcastError(new Error(message)), message).toBe('AMBIGUOUS');
    }
    expect(classifyBroadcastError('a bare string')).toBe('AMBIGUOUS');
    expect(classifyBroadcastError(undefined)).toBe('AMBIGUOUS');
  });
});
