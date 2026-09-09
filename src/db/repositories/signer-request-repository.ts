import { and, eq, sql } from 'drizzle-orm';
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

export async function markSignerRequestRejected(
  executor: Executor,
  input: { id: string; rejectionCode: string },
): Promise<void> {
  await executor
    .update(signerRequests)
    .set({
      status: SignerRequestState.REJECTED,
      rejectedAt: sql`now()`,
      lastCheckedAt: sql`now()`,
      rejectionCode: input.rejectionCode,
    })
    .where(eq(signerRequests.id, input.id));
}

/**
 * Retires a request the signer never decided. `requested_at` is written by PostgreSQL, so
 * the deadline is evaluated against PostgreSQL's clock too: an application clock running
 * behind or ahead of the database must not decide when a signing intent lapses.
 *
 * Returns true only for the caller whose UPDATE moved the row out of PENDING.
 */
export async function expireLapsedSignerRequest(
  executor: Executor,
  input: { id: string; timeoutMs: number },
): Promise<boolean> {
  const rows = await executor
    .update(signerRequests)
    .set({
      status: SignerRequestState.EXPIRED,
      rejectedAt: sql`now()`,
      lastCheckedAt: sql`now()`,
      rejectionCode: 'SIGNER_REQUEST_TIMEOUT',
    })
    .where(
      and(
        eq(signerRequests.id, input.id),
        eq(signerRequests.status, SignerRequestState.PENDING),
        sql`${signerRequests.requestedAt} + make_interval(secs => ${input.timeoutMs / 1000}) <= now()`,
      ),
    )
    .returning({ id: signerRequests.id });
  return rows.length > 0;
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
