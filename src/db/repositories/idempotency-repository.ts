import { and, eq } from 'drizzle-orm';
import type { Executor } from '../pool.js';
import { idempotencyKeys } from '../schema/index.js';

export const IdempotencyStatus = {
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type IdempotencyStatus = (typeof IdempotencyStatus)[keyof typeof IdempotencyStatus];

export interface IdempotencyRecord {
  readonly id: string;
  readonly scope: string;
  readonly organizationId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly status: string;
  readonly responseStatus: number | null;
  readonly responseBody: unknown;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface IdempotencyIdentity {
  readonly scope: string;
  readonly organizationId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
}

/**
 * Attempts to claim a key.
 *
 * Returns `{ claimed: true }` for the single winner of a concurrent race, and the
 * existing row for everybody else. The uniqueness of (scope, org, actor, key) in
 * PostgreSQL is what makes this safe - there is no Redis lock involved.
 */
export async function claimIdempotencyKey(
  executor: Executor,
  input: IdempotencyIdentity & { requestHash: string },
): Promise<{ claimed: boolean; record: IdempotencyRecord }> {
  const inserted = await executor
    .insert(idempotencyKeys)
    .values({ ...input, status: IdempotencyStatus.IN_PROGRESS })
    .onConflictDoNothing({
      target: [
        idempotencyKeys.scope,
        idempotencyKeys.organizationId,
        idempotencyKeys.actorId,
        idempotencyKeys.idempotencyKey,
      ],
    })
    .returning();

  const row = inserted[0];
  if (row !== undefined) return { claimed: true, record: row };

  const existing = await findIdempotencyRecord(executor, input);
  if (existing === null) throw new Error('idempotency key vanished after conflict');
  return { claimed: false, record: existing };
}

export async function findIdempotencyRecord(
  executor: Executor,
  identity: IdempotencyIdentity,
): Promise<IdempotencyRecord | null> {
  const [row] = await executor
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.scope, identity.scope),
        eq(idempotencyKeys.organizationId, identity.organizationId),
        eq(idempotencyKeys.actorId, identity.actorId),
        eq(idempotencyKeys.idempotencyKey, identity.idempotencyKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function completeIdempotencyKey(
  executor: Executor,
  input: {
    id: string;
    responseStatus: number;
    responseBody: unknown;
    resourceType: string;
    resourceId: string;
  },
): Promise<void> {
  await executor
    .update(idempotencyKeys)
    .set({
      status: IdempotencyStatus.COMPLETED,
      responseStatus: input.responseStatus,
      responseBody: input.responseBody,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      completedAt: new Date(),
    })
    .where(eq(idempotencyKeys.id, input.id));
}

/**
 * Releases a claim whose work failed, so the caller may retry with the same key.
 * Deleting rather than marking FAILED keeps the retry path simple and side-effect free.
 */
export async function releaseIdempotencyKey(executor: Executor, id: string): Promise<void> {
  await executor.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id));
}
