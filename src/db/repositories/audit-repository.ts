import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { Executor } from '../pool.js';
import { auditEvents } from '../schema/index.js';
import type { Actor } from '../../domain/roles.js';

export interface AuditEventInput {
  readonly actor: Actor;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly correlationId: string;
  readonly operationId?: string | undefined;
  readonly metadata?: Record<string, unknown>;
}

export interface AuditEventRow {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actorType: string;
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly operationId: string | null;
  readonly correlationId: string;
  readonly metadata: unknown;
}

/**
 * Appends an audit event.
 *
 * Callers must pass the same executor as the state mutation being audited, so evidence
 * and effect commit together or not at all. The table is append-only at the database
 * level; there is intentionally no update or delete here.
 */
export async function recordAuditEvent(
  executor: Executor,
  input: AuditEventInput,
): Promise<string> {
  const [row] = await executor
    .insert(auditEvents)
    .values({
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      operationId: input.operationId ?? null,
      correlationId: input.correlationId,
      metadata: input.metadata ?? {},
    })
    .returning({ id: auditEvents.id });

  if (row === undefined) throw new Error('failed to append audit event');
  return row.id;
}

export interface AuditQuery {
  readonly operationId?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly limit: number;
  /** Keyset cursor: `${occurredAtIso}|${id}`. */
  readonly cursor?: string | undefined;
}

export async function listAuditEvents(
  executor: Executor,
  query: AuditQuery,
): Promise<AuditEventRow[]> {
  const filters = [];
  if (query.operationId !== undefined) {
    filters.push(eq(auditEvents.operationId, query.operationId));
  }
  if (query.resourceType !== undefined) {
    filters.push(eq(auditEvents.resourceType, query.resourceType));
  }
  if (query.resourceId !== undefined) filters.push(eq(auditEvents.resourceId, query.resourceId));

  if (query.cursor !== undefined) {
    const [occurredAt, id] = query.cursor.split('|');
    if (occurredAt !== undefined && id !== undefined) {
      const cursorDate = new Date(occurredAt);
      filters.push(
        or(
          lt(auditEvents.occurredAt, cursorDate),
          and(eq(auditEvents.occurredAt, cursorDate), lt(auditEvents.id, id)),
        )!,
      );
    }
  }

  const rows = await executor
    .select()
    .from(auditEvents)
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(query.limit);

  return rows;
}

export async function countAuditEventsForOperation(
  executor: Executor,
  operationId: string,
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<string>`count(*)` })
    .from(auditEvents)
    .where(eq(auditEvents.operationId, operationId));
  return Number(row?.count ?? 0);
}
