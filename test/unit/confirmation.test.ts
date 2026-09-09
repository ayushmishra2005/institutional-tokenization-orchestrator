import { describe, expect, it } from 'vitest';
import { awaitConfirmation, type ConfirmationPolicy } from '../../src/modules/transactions/confirmation.js';
import type { EvmGateway, TransactionReceiptView } from '../../src/ports/evm-gateway.js';

const HASH = `0x${'ab'.repeat(32)}` as const;

function receipt(overrides: Partial<TransactionReceiptView> = {}): TransactionReceiptView {
  return {
    transactionHash: HASH,
    status: 'success',
    blockNumber: 100,
    blockHash: `0x${'11'.repeat(32)}`,
    gasUsed: 21_000n,
    contractAddress: null,
    logs: [],
    ...overrides,
  };
}

/**
 * Scripted chain view. Each field is consumed in order where a sequence is given, which is
 * how a reorg is expressed: the same lookup answers differently on the next poll.
 */
function chain(script: {
  receipts?: (TransactionReceiptView | null)[];
  /** Canonical hash per height. Heights left out answer with the receipt's own hash. */
  canonical?: Record<number, `0x${string}` | null>;
  latest?: number;
  finalized?: number | null;
}): EvmGateway {
  const receipts = script.receipts ?? [receipt()];
  let lastReceipt = receipts[0];
  const next = <T>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]!);

  return {
    getTransactionReceipt: async () => {
      lastReceipt = next(receipts);
      return lastReceipt;
    },
    getBlockHashAt: async (blockNumber: number) => {
      if (script.canonical !== undefined && blockNumber in script.canonical) {
        return script.canonical[blockNumber]!;
      }
      return lastReceipt?.blockHash ?? null;
    },
    getLatestBlockNumber: async () => script.latest ?? 100,
    getFinalizedBlockNumber: async () => script.finalized ?? null,
  } as unknown as EvmGateway;
}

const policy = (overrides: Partial<ConfirmationPolicy> = {}): ConfirmationPolicy => ({
  confirmations: 3,
  finalityTag: 'latest',
  timeoutMs: 60,
  pollIntervalMs: 1,
  ...overrides,
});

describe('inclusion, canonicality and finality', () => {
  it('reports PENDING while no receipt exists', async () => {
    const outcome = await awaitConfirmation(chain({ receipts: [null] }), HASH, policy());
    expect(outcome.kind).toBe('PENDING');
  });

  it('finalizes once the required depth is reached', async () => {
    const outcome = await awaitConfirmation(chain({ latest: 102 }), HASH, policy());
    expect(outcome.kind).toBe('FINALIZED');
  });

  it('stays INCLUDED while the receipt is canonical but too shallow', async () => {
    const outcome = await awaitConfirmation(chain({ latest: 100 }), HASH, policy());
    expect(outcome.kind).toBe('INCLUDED');
  });

  it('reports ORPHANED when the canonical hash at that height differs', async () => {
    const outcome = await awaitConfirmation(
      chain({ canonical: { 100: `0x${'99'.repeat(32)}` }, latest: 102 }),
      HASH,
      policy(),
    );
    expect(outcome.kind).toBe('ORPHANED');
  });

  it('reports ORPHANED when the receipt disappears from the chain', async () => {
    const outcome = await awaitConfirmation(
      chain({ receipts: [receipt(), null], latest: 102 }),
      HASH,
      policy(),
    );
    expect(outcome.kind).toBe('ORPHANED');
  });

  it('finalizes the same transaction after it is re-included in a new canonical block', async () => {
    const reorganised = receipt({ blockNumber: 101, blockHash: `0x${'22'.repeat(32)}` });
    const outcome = await awaitConfirmation(
      chain({
        receipts: [receipt(), reorganised],
        canonical: { 100: `0x${'99'.repeat(32)}` },
        latest: 103,
      }),
      HASH,
      policy(),
    );
    expect(outcome).toMatchObject({ kind: 'FINALIZED', receipt: { blockNumber: 101 } });
  });

  it('reports REVERTED only for a receipt in a canonical block', async () => {
    const reverted = receipt({ status: 'reverted' });
    expect(
      (await awaitConfirmation(chain({ receipts: [reverted], latest: 102 }), HASH, policy())).kind,
    ).toBe('REVERTED');
    expect(
      (
        await awaitConfirmation(
          chain({ receipts: [reverted], canonical: { 100: `0x${'99'.repeat(32)}` } }),
          HASH,
          policy(),
        )
      ).kind,
    ).toBe('ORPHANED');
  });

  it("defers to the chain's finalized height when the profile has one", async () => {
    const finalityPolicy = policy({ finalityTag: 'finalized' });
    expect(
      (await awaitConfirmation(chain({ latest: 100_000, finalized: 99 }), HASH, finalityPolicy))
        .kind,
    ).toBe('INCLUDED');
    expect(
      (await awaitConfirmation(chain({ latest: 100, finalized: 100 }), HASH, finalityPolicy)).kind,
    ).toBe('FINALIZED');
  });

  it('falls back to depth when the chain exposes no finalized height', async () => {
    const outcome = await awaitConfirmation(
      chain({ latest: 102, finalized: null }),
      HASH,
      policy({ finalityTag: 'finalized' }),
    );
    expect(outcome.kind).toBe('FINALIZED');
  });
});
