import { eq, sql } from 'drizzle-orm';
import type { Executor } from '../pool.js';
import { signerRequests } from '../schema/index.js';

export const SignerRequestState = {
  PENDING: 'PENDING',
  SIGNED: 'SIGNED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
} as const;

export type SignerRequestState = (typeof SignerRequestState)[keyof typeof SignerRequestState];

export interface SignerRequestRecord {
  readonly id: string;
  readonly transactionAttemptId: string;
  readonly operationId: string | null;
  readonly provider: string;
  readonly providerRequestId: string;
  readonly status: string;
  readonly requestFingerprint: string;
  readonly requestedAt: Date;
  readonly lastCheckedAt: Date | null;
  readonly signedAt: Date | null;
  readonly rejectedAt: Date | null;
  readonly rejectionCode: string | null;
}

/**
 * One row per attempt. A retry after a lost provider response updates the existing row
 * instead of recording a second signing intent, which is what keeps the external side
 * effect single even though the network call is not.
 */
export async function recordSignerRequest(
  executor: Executor,
  input: {
    transactionAttemptId: string;
    operationId: string | null;
    provider: string;
    providerRequestId: string;
    status: SignerRequestState;
    requestFingerprint: string;
  },
): Promise<SignerRequestRecord> {
  const [row] = await executor
    .insert(signerRequests)
    .values(input)
    .onConflictDoUpdate({
      target: signerRequests.transactionAttemptId,
      set: {
        status: input.status,
        lastCheckedAt: sql`now()`,
        ...(input.status === SignerRequestState.SIGNED ? { signedAt: sql`now()` } : {}),
      },
    })
    .returning();
  if (row === undefined) throw new Error('failed to record signer request');
  return row;
}

export async function markSignerRequestSigned(executor: Executor, id: string): Promise<void> {
  await executor
    .update(signerRequests)
    .set({ status: SignerRequestState.SIGNED, signedAt: sql`now()`, lastCheckedAt: sql`now()` })
    .where(eq(signerRequests.id, id));
}

export async function markSignerRequestRefused(
  executor: Executor,
  input: { id: string; status: 'REJECTED' | 'EXPIRED'; rejectionCode: string },
): Promise<void> {
  await executor
    .update(signerRequests)
    .set({
      status: input.status,
      rejectedAt: sql`now()`,
      lastCheckedAt: sql`now()`,
      rejectionCode: input.rejectionCode,
    })
    .where(eq(signerRequests.id, input.id));
}

export async function touchSignerRequest(executor: Executor, id: string): Promise<void> {
  await executor
    .update(signerRequests)
    .set({ lastCheckedAt: sql`now()` })
    .where(eq(signerRequests.id, id));
}

export async function findSignerRequestForAttempt(
  executor: Executor,
  attemptId: string,
): Promise<SignerRequestRecord | null> {
  const [row] = await executor
    .select()
    .from(signerRequests)
    .where(eq(signerRequests.transactionAttemptId, attemptId))
    .limit(1);
  return row ?? null;
}

export async function countPendingSignerRequests(executor: Executor): Promise<number> {
  const [row] = await executor
    .select({ count: sql<string>`count(*)` })
    .from(signerRequests)
    .where(eq(signerRequests.status, SignerRequestState.PENDING));
  return Number(row?.count ?? 0);
}
