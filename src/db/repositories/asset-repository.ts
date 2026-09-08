import { and, eq } from 'drizzle-orm';
import type { Executor } from '../pool.js';
import { assets } from '../schema/index.js';

export interface AssetRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly supplyCap: string;
  readonly chainId: number;
  readonly contractAddress: string | null;
  readonly deploymentTxHash: string | null;
  readonly status: string;
  readonly policyVersion: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const AssetStatus = {
  PROVISIONING: 'PROVISIONING',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  FAILED: 'FAILED',
} as const;

export type AssetStatus = (typeof AssetStatus)[keyof typeof AssetStatus];

export interface InsertAssetInput {
  readonly organizationId: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly supplyCap: string;
  readonly chainId: number;
  readonly createdBy: string;
}

export async function insertProvisioningAsset(
  executor: Executor,
  input: InsertAssetInput,
): Promise<AssetRecord> {
  const [row] = await executor
    .insert(assets)
    .values({ ...input, status: AssetStatus.PROVISIONING })
    .returning();
  if (row === undefined) throw new Error('failed to insert asset');
  return row;
}

export async function markAssetActive(
  executor: Executor,
  input: { assetId: string; contractAddress: string; deploymentTxHash: string },
): Promise<void> {
  await executor
    .update(assets)
    .set({
      contractAddress: input.contractAddress.toLowerCase(),
      deploymentTxHash: input.deploymentTxHash.toLowerCase(),
      status: AssetStatus.ACTIVE,
      updatedAt: new Date(),
    })
    .where(eq(assets.id, input.assetId));
}

export async function markAssetFailed(
  executor: Executor,
  assetId: string,
): Promise<void> {
  await executor
    .update(assets)
    .set({ status: AssetStatus.FAILED, updatedAt: new Date() })
    .where(eq(assets.id, assetId));
}

export async function findAssetById(
  executor: Executor,
  assetId: string,
): Promise<AssetRecord | null> {
  const [row] = await executor.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  return row ?? null;
}

export async function findAssetBySymbol(
  executor: Executor,
  organizationId: string,
  symbol: string,
): Promise<AssetRecord | null> {
  const [row] = await executor
    .select()
    .from(assets)
    .where(and(eq(assets.organizationId, organizationId), eq(assets.symbol, symbol)))
    .limit(1);
  return row ?? null;
}
