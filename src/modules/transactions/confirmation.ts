import type { EvmGateway, TransactionReceiptView } from '../../ports/evm-gateway.js';
import type { FinalityTag } from '../../platform/config/chain-profile.js';

export interface ConfirmationPolicy {
  /** Depth required when the chain has no finality tag, or as the fallback when it has. */
  readonly confirmations: number;
  readonly finalityTag: FinalityTag;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export type ConfirmationOutcome =
  /** Receipt succeeded, the including block is canonical, and finality policy is met. */
  | { readonly kind: 'FINALIZED'; readonly receipt: TransactionReceiptView }
  | { readonly kind: 'REVERTED'; readonly receipt: TransactionReceiptView }
  /** The block that carried the receipt is no longer part of the canonical chain. */
  | { readonly kind: 'ORPHANED'; readonly receipt: TransactionReceiptView }
  /** Canonical but not yet deep or finalized enough to settle. */
  | { readonly kind: 'INCLUDED'; readonly receipt: TransactionReceiptView }
  /** No receipt within the bounded wait: the transaction may still be pending. */
  | { readonly kind: 'PENDING' };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Inclusion, canonicality and finality are three separate questions. A receipt only
 * proves the transaction was in *a* block; that block can still be replaced until the
 * chain profile's finality condition holds.
 */
export async function awaitConfirmation(
  gateway: EvmGateway,
  transactionHash: `0x${string}`,
  policy: ConfirmationPolicy,
): Promise<ConfirmationOutcome> {
  const deadline = Date.now() + policy.timeoutMs;

  let receipt: TransactionReceiptView | null = null;
  while (Date.now() < deadline) {
    receipt = await gateway.getTransactionReceipt(transactionHash);
    if (receipt !== null) break;
    await sleep(policy.pollIntervalMs);
  }
  if (receipt === null) return { kind: 'PENDING' };

  let observed = receipt;
  while (Date.now() < deadline) {
    // Re-read rather than trust the first observation: a reorg either drops the receipt
    // or re-publishes the same transaction in a different block, and both must be seen.
    const current = await gateway.getTransactionReceipt(transactionHash);
    if (current === null) return { kind: 'ORPHANED', receipt: observed };
    observed = current;

    const canonicalHash = await gateway.getBlockHashAt(observed.blockNumber);
    if (canonicalHash === null || canonicalHash.toLowerCase() !== observed.blockHash.toLowerCase()) {
      return { kind: 'ORPHANED', receipt: observed };
    }

    if (observed.status === 'reverted') return { kind: 'REVERTED', receipt: observed };
    if (await isFinal(gateway, observed.blockNumber, policy)) {
      return { kind: 'FINALIZED', receipt: observed };
    }
    await sleep(policy.pollIntervalMs);
  }

  return { kind: 'INCLUDED', receipt: observed };
}

async function isFinal(
  gateway: EvmGateway,
  blockNumber: number,
  policy: ConfirmationPolicy,
): Promise<boolean> {
  if (policy.finalityTag !== 'latest') {
    const finalized = await gateway.getFinalizedBlockNumber();
    if (finalized !== null) return finalized >= blockNumber;
  }

  const latest = await gateway.getLatestBlockNumber();
  return latest - blockNumber + 1 >= policy.confirmations;
}
