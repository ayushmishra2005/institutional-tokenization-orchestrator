import { and, eq } from 'drizzle-orm';
import type { Executor } from '../pool.js';
import { wallets } from '../schema/index.js';

export interface WalletRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly chainId: number;
  readonly address: string;
  readonly label: string | null;
  readonly investorReference: string;
  readonly status: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface InsertWalletInput {
  readonly organizationId: string;
  readonly chainId: number;
  readonly address: string;
  readonly label: string | null;
  readonly investorReference: string;
  readonly createdBy: string;
}

export async function insertWallet(
  executor: Executor,
  input: InsertWalletInput,
): Promise<WalletRecord> {
  const [row] = await executor
    .insert(wallets)
    .values({ ...input, address: input.address.toLowerCase() })
    .returning();
  if (row === undefined) throw new Error('failed to insert wallet');
  return row;
}

export async function findWalletById(
  executor: Executor,
  walletId: string,
): Promise<WalletRecord | null> {
  const [row] = await executor.select().from(wallets).where(eq(wallets.id, walletId)).limit(1);
  return row ?? null;
}

export async function findWalletByAddress(
  executor: Executor,
  chainId: number,
  address: string,
): Promise<WalletRecord | null> {
  const [row] = await executor
    .select()
    .from(wallets)
    .where(and(eq(wallets.chainId, chainId), eq(wallets.address, address.toLowerCase())))
    .limit(1);
  return row ?? null;
}
