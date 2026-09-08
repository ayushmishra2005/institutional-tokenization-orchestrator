import { canonicalHash, sha256Hex } from './canonical.js';

/**
 * The immutable financial intent an approver signs off on.
 *
 * Approvals are bound to the hash of this snapshot. If any element of the intent
 * changes - a different recipient, a different amount, a redeployed contract, a new
 * approval policy version - the recomputed hash no longer matches and previously
 * collected approvals are superseded rather than silently reused.
 */
export interface MintProposalSnapshot {
  readonly kind: 'MINT';
  readonly assetId: string;
  readonly chainId: number;
  readonly contractAddress: string;
  readonly walletId: string;
  readonly recipientAddress: string;
  /** Base units, decimal string. Never a JS number. */
  readonly amount: string;
  readonly operationReference: string;
  readonly policyVersion: number;
  readonly requiredApprovals: number;
}

export function hashMintProposal(snapshot: MintProposalSnapshot): string {
  return canonicalHash({
    kind: snapshot.kind,
    assetId: snapshot.assetId,
    chainId: snapshot.chainId,
    contractAddress: snapshot.contractAddress.toLowerCase(),
    walletId: snapshot.walletId,
    recipientAddress: snapshot.recipientAddress.toLowerCase(),
    amount: snapshot.amount,
    operationReference: snapshot.operationReference.toLowerCase(),
    policyVersion: snapshot.policyVersion,
    requiredApprovals: snapshot.requiredApprovals,
  });
}

/**
 * Derives the bytes32 handed to `mintWithReference`. Deterministic in the operation id,
 * so a retry of the same operation always targets the same single-use on-chain slot and
 * a duplicate delivery can never mint twice.
 */
export function deriveOperationReference(operationId: string): `0x${string}` {
  return `0x${sha256Hex(`ito:mint:${operationId}`)}`;
}
