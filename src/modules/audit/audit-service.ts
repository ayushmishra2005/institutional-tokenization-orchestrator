import type { Database } from '../../db/pool.js';
import {
  listAuditEvents,
  type AuditEventRow,
} from '../../db/repositories/audit-repository.js';
import { AppRole } from '../../domain/roles.js';
import { requireRole } from '../../platform/auth/authorize.js';
import type { RequestContext } from '../context.js';

export interface AuditQueryInput {
  readonly operationId?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface AuditPage {
  readonly events: readonly AuditEventRow[];
  readonly nextCursor: string | null;
}

/** Read-only access to the append-only audit trail. */
export class AuditService {
  constructor(private readonly db: Database) {}

  async query(ctx: RequestContext, input: AuditQueryInput): Promise<AuditPage> {
    requireRole(ctx.actor, [AppRole.AUDITOR, AppRole.ADMIN], 'read audit events');

    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const events = await listAuditEvents(this.db, {
      operationId: input.operationId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      cursor: input.cursor,
      limit: limit + 1,
    });

    const page = events.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      events.length > limit && last !== undefined
        ? `${last.occurredAt.toISOString()}|${last.id}`
        : null;

    return { events: page, nextCursor };
  }
}
