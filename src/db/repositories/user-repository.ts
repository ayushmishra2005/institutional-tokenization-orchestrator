import { eq, inArray } from 'drizzle-orm';
import type { Executor } from '../pool.js';
import { userRoles, users } from '../schema/index.js';
import { ActorType, isAppRole, type Actor, type AppRole } from '../../domain/roles.js';

export interface UserRecord {
  readonly id: string;
  readonly externalSubject: string;
  readonly organizationId: string;
  readonly displayName: string;
  readonly status: string;
  readonly roles: readonly AppRole[];
}

async function loadRoles(executor: Executor, userIds: string[]): Promise<Map<string, AppRole[]>> {
  if (userIds.length === 0) return new Map();
  const rows = await executor
    .select()
    .from(userRoles)
    .where(inArray(userRoles.userId, userIds));

  const byUser = new Map<string, AppRole[]>();
  for (const row of rows) {
    if (!isAppRole(row.role)) continue;
    const existing = byUser.get(row.userId);
    if (existing === undefined) byUser.set(row.userId, [row.role]);
    else existing.push(row.role);
  }
  return byUser;
}

/**
 * Resolves the identity asserted by a token into an application actor.
 *
 * Roles are read from PostgreSQL rather than taken from the token, so revoking a role
 * takes effect immediately instead of when the token happens to expire.
 */
export async function findUserBySubject(
  executor: Executor,
  externalSubject: string,
): Promise<UserRecord | null> {
  const [user] = await executor
    .select()
    .from(users)
    .where(eq(users.externalSubject, externalSubject))
    .limit(1);
  if (user === undefined) return null;

  const roles = (await loadRoles(executor, [user.id])).get(user.id) ?? [];
  return { ...user, roles };
}

export async function findUserById(executor: Executor, id: string): Promise<UserRecord | null> {
  const [user] = await executor.select().from(users).where(eq(users.id, id)).limit(1);
  if (user === undefined) return null;
  const roles = (await loadRoles(executor, [user.id])).get(user.id) ?? [];
  return { ...user, roles };
}

export function toActor(user: UserRecord): Actor {
  return {
    type: ActorType.USER,
    id: user.id,
    organizationId: user.organizationId,
    roles: user.roles,
  };
}

export interface CreateUserInput {
  readonly externalSubject: string;
  readonly organizationId: string;
  readonly displayName: string;
  readonly roles: readonly AppRole[];
}

/** Idempotent user provisioning, used by the local bootstrap and by tests. */
export async function upsertUser(
  executor: Executor,
  input: CreateUserInput,
): Promise<UserRecord> {
  const [user] = await executor
    .insert(users)
    .values({
      externalSubject: input.externalSubject,
      organizationId: input.organizationId,
      displayName: input.displayName,
    })
    .onConflictDoUpdate({
      target: users.externalSubject,
      set: { displayName: input.displayName, organizationId: input.organizationId },
    })
    .returning();

  if (user === undefined) throw new Error('failed to upsert user');

  await executor.delete(userRoles).where(eq(userRoles.userId, user.id));
  if (input.roles.length > 0) {
    await executor
      .insert(userRoles)
      .values(input.roles.map((role) => ({ userId: user.id, role })));
  }

  return { ...user, roles: input.roles };
}
