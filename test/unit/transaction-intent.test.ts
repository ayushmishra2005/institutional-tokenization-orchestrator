import { describe, expect, it } from 'vitest';
import {
  assertFeeOnlyReplacement,
  bumpFees,
  fingerprintOf,
  intentFingerprint,
} from '../../src/modules/transactions/transaction-intent.js';
import type { TransactionAttemptRecord } from '../../src/db/repositories/transaction-repository.js';

const SIGNER = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';

const intent = {
  chainId: 31337,
  from: SIGNER,
  to: TOKEN,
  data: '0xdeadbeef',
  value: '0',
  purpose: 'MINT',
  operationId: 'a2f6d9c4-0000-4000-8000-000000000001',
};

function attempt(overrides: Partial<TransactionAttemptRecord> = {}): TransactionAttemptRecord {
  const base: TransactionAttemptRecord = {
    id: 'f0000000-0000-4000-8000-000000000001',
    operationId: intent.operationId,
    assetId: null,
    walletId: null,
    purpose: intent.purpose,
    chainId: intent.chainId,
    fromAddress: SIGNER,
    toAddress: TOKEN,
    nonce: 7,
    value: '0',
    data: intent.data,
    gasLimit: 500_000,
    maxFeePerGas: '1000000000',
    maxPriorityFeePerGas: '1000000',
    requestHash: 'a'.repeat(64),
    signedRawTransaction: null,
    transactionHash: null,
    status: 'SUBMITTED',
    broadcastAttempts: 1,
    blockNumber: null,
    blockHash: null,
    gasUsed: null,
    receiptStatus: null,
    contractAddress: null,
    errorCode: null,
    errorMessage: null,
    intentFingerprint: intentFingerprint(intent),
    replacesAttemptId: null,
    replacedByAttemptId: null,
    replacementReason: null,
    replacementNumber: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return { ...base, ...overrides };
}

/** The candidate a fee-only replacement builds from the row it supersedes. */
function candidateFor(previous: TransactionAttemptRecord) {
  return {
    chainId: previous.chainId,
    fromAddress: previous.fromAddress,
    toAddress: previous.toAddress,
    data: previous.data,
    value: previous.value,
    nonce: previous.nonce,
    purpose: previous.purpose,
    operationId: previous.operationId,
  };
}

describe('transaction intent fingerprint', () => {
  it('ignores nonce, gas limit and fee fields', () => {
    const original = attempt();
    const repriced = attempt({
      nonce: 7,
      gasLimit: 900_000,
      maxFeePerGas: '5000000000',
      maxPriorityFeePerGas: '9000000',
    });
    expect(fingerprintOf(repriced)).toBe(fingerprintOf(original));
  });

  it.each([
    ['calldata', { data: '0xfeedface' }],
    ['destination', { toAddress: '0x3333333333333333333333333333333333333333' }],
    ['chain', { chainId: 1 }],
    ['signer', { fromAddress: '0x4444444444444444444444444444444444444444' }],
    ['purpose', { purpose: 'SET_ELIGIBILITY' }],
    ['operation', { operationId: 'a2f6d9c4-0000-4000-8000-000000000009' }],
  ])('changes when %s changes', (_field, overrides) => {
    expect(fingerprintOf(attempt(overrides))).not.toBe(fingerprintOf(attempt()));
  });

  it('is insensitive to address and calldata casing', () => {
    expect(fingerprintOf(attempt({ toAddress: TOKEN.toUpperCase(), data: '0xDEADBEEF' }))).toBe(
      fingerprintOf(attempt()),
    );
  });
});

describe('fee-only replacement guard', () => {
  it('accepts a candidate that differs only in fees', () => {
    const previous = attempt();
    expect(() => assertFeeOnlyReplacement(previous, candidateFor(previous))).not.toThrow();
  });

  it.each([
    ['calldata', { data: '0xfeedface' }],
    ['destination', { toAddress: '0x3333333333333333333333333333333333333333' }],
    ['nonce', { nonce: 8 }],
    ['chainId', { chainId: 1 }],
    ['signer', { fromAddress: '0x4444444444444444444444444444444444444444' }],
    ['purpose', { purpose: 'SET_ELIGIBILITY' }],
    ['operation', { operationId: 'a2f6d9c4-0000-4000-8000-000000000009' }],
  ])('rejects a candidate that changes %s', (_field, overrides) => {
    const previous = attempt();
    expect(() =>
      assertFeeOnlyReplacement(previous, { ...candidateFor(previous), ...overrides }),
    ).toThrow(/only fee fields may differ/);
  });

  it('rejects a previous attempt whose recorded fingerprint no longer matches its columns', () => {
    const tampered = attempt({ intentFingerprint: 'c'.repeat(64) });
    expect(() => assertFeeOnlyReplacement(tampered, candidateFor(tampered))).toThrow(
      /intentFingerprint/,
    );
  });
});

describe('replacement fee bump', () => {
  const current = { maxFeePerGas: 1_100_000_000n, maxPriorityFeePerGas: 1_100_000n };

  it('raises both fee fields above the attempt being replaced', () => {
    const bumped = bumpFees(
      { maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' },
      current,
      25,
    );
    expect(bumped.maxFeePerGas).toBeGreaterThan(1_250_000_000n);
    expect(bumped.maxPriorityFeePerGas).toBeGreaterThan(1_250_000n);
  });

  it('never prices below the current market estimate', () => {
    const bumped = bumpFees(
      { maxFeePerGas: '1000', maxPriorityFeePerGas: '10' },
      current,
      25,
    );
    expect(bumped.maxFeePerGas).toBe(current.maxFeePerGas);
    expect(bumped.maxPriorityFeePerGas).toBe(current.maxPriorityFeePerGas);
  });
});
