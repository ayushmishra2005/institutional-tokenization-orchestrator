import { describe, expect, it } from 'vitest';
import { canonicalHash, canonicalJson } from '../../src/domain/canonical.js';
import {
  deriveOperationReference,
  hashMintProposal,
  type MintProposalSnapshot,
} from '../../src/domain/mint-proposal.js';

const base: MintProposalSnapshot = {
  kind: 'MINT',
  assetId: 'asset-1',
  chainId: 31337,
  contractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  walletId: 'wallet-1',
  recipientAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  amount: '1000',
  operationReference: `0x${'ab'.repeat(32)}`,
  policyVersion: 1,
  requiredApprovals: 2,
};

describe('canonical json', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalHash({ b: 1, a: 2 })).toBe(canonicalHash({ a: 2, b: 1 }));
  });

  it('distinguishes different values and nesting', () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
    expect(canonicalHash({ a: [1, 2] })).not.toBe(canonicalHash({ a: [2, 1] }));
    expect(canonicalHash({ a: '1' })).not.toBe(canonicalHash({ a: 1 }));
  });
});

describe('mint proposal hashing', () => {
  it('is stable for the same intent', () => {
    expect(hashMintProposal(base)).toBe(hashMintProposal({ ...base }));
  });

  it('ignores address casing so a checksum change is not a new intent', () => {
    expect(hashMintProposal({ ...base, recipientAddress: base.recipientAddress.toLowerCase() })).toBe(
      hashMintProposal(base),
    );
  });

  it.each([
    ['amount', { amount: '1001' }],
    ['recipient', { recipientAddress: '0x0000000000000000000000000000000000000001' }],
    ['contract', { contractAddress: '0x0000000000000000000000000000000000000002' }],
    ['chain', { chainId: 1 }],
    ['operation reference', { operationReference: `0x${'cd'.repeat(32)}` }],
    ['policy version', { policyVersion: 2 }],
    ['required approvals', { requiredApprovals: 3 }],
  ])('changing the %s invalidates the hash', (_label, patch) => {
    expect(hashMintProposal({ ...base, ...patch })).not.toBe(hashMintProposal(base));
  });
});

describe('operation reference derivation', () => {
  it('is deterministic in the operation id', () => {
    expect(deriveOperationReference('op-1')).toBe(deriveOperationReference('op-1'));
  });

  it('differs per operation', () => {
    expect(deriveOperationReference('op-1')).not.toBe(deriveOperationReference('op-2'));
  });

  it('produces a 32-byte hex value suitable for bytes32', () => {
    expect(deriveOperationReference('op-1')).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
