import type { EvmGateway, TransactionReceiptView } from '../../ports/evm-gateway.js';

export interface ConfirmationPolicy {
  /** Blocks that must sit on top of the including block before we call it final. */
  readonly confirmations: number;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export type ConfirmationOutcome =
  | { readonly kind: 'CONFIRMED'; readonly receipt: TransactionReceiptView }
  | { readonly kind: 'REVERTED'; readonly receipt: TransactionReceiptView }
  /** No receipt within the timeout: the transaction may still be pending. */
  | { readonly kind: 'PENDING' };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Inclusion and finality are separate: a receipt only proves the transaction was in *a*
 * block. On Anvil a small confirmation depth is a deterministic stand-in for finality and
 * nothing more - it does not model reorg risk.
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

  while (Date.now() < deadline) {
    const latest = await gateway.getLatestBlockNumber();
    if (latest - receipt.blockNumber + 1 >= policy.confirmations) {
      return receipt.status === 'success'
        ? { kind: 'CONFIRMED', receipt }
        : { kind: 'REVERTED', receipt };
    }
    await sleep(policy.pollIntervalMs);
  }

  // Included but not yet deep enough. The caller keeps the operation in INCLUDED and
  // lets the recovery sweep finish the job rather than guessing an outcome.
  return { kind: 'PENDING' };
}
