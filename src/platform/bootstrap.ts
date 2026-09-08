import type { Database } from '../db/pool.js';
import { upsertUser, type UserRecord } from '../db/repositories/user-repository.js';
import { AppRole } from '../domain/roles.js';
import type { DevJwtAuthenticator } from './auth/jwt.js';

export const DEFAULT_ORGANIZATION = 'acme-issuer';

/** Development personas. Two distinct approvers exist so the four-eyes rule is testable. */
export const DEV_USERS = [
  { subject: 'dev-admin', displayName: 'Dev Admin', roles: [AppRole.ADMIN] },
  { subject: 'dev-issuer', displayName: 'Dev Issuer', roles: [AppRole.ISSUER] },
  {
    subject: 'dev-compliance',
    displayName: 'Dev Compliance Officer',
    roles: [AppRole.COMPLIANCE_OFFICER],
  },
  { subject: 'dev-approver-1', displayName: 'Dev Approver One', roles: [AppRole.APPROVER] },
  { subject: 'dev-approver-2', displayName: 'Dev Approver Two', roles: [AppRole.APPROVER] },
  { subject: 'dev-auditor', displayName: 'Dev Auditor', roles: [AppRole.AUDITOR] },
] as const;

export type DevUserSubject = (typeof DEV_USERS)[number]['subject'];

export interface BootstrappedUser {
  readonly record: UserRecord;
  readonly token: string;
}

/** Idempotently provisions the local personas and issues their tokens. Development only. */
export async function bootstrapDevUsers(
  db: Database,
  auth: DevJwtAuthenticator,
  organizationId: string = DEFAULT_ORGANIZATION,
): Promise<Record<DevUserSubject, BootstrappedUser>> {
  const entries = await Promise.all(
    DEV_USERS.map(async (user) => {
      const record = await upsertUser(db, {
        externalSubject: user.subject,
        organizationId,
        displayName: user.displayName,
        roles: user.roles,
      });
      const token = await auth.issue({ subject: user.subject, organizationId });
      return [user.subject, { record, token }] as const;
    }),
  );

  return Object.fromEntries(entries) as Record<DevUserSubject, BootstrappedUser>;
}
