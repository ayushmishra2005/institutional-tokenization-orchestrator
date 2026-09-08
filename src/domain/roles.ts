/**
 * Application roles. These are entirely separate from the on-chain AccessControl roles
 * held by the orchestrator's signer address: an APPROVER can authorise a mint in the
 * workflow but holds no EVM authority whatsoever.
 */
export const AppRole = {
  ADMIN: 'ADMIN',
  ISSUER: 'ISSUER',
  COMPLIANCE_OFFICER: 'COMPLIANCE_OFFICER',
  APPROVER: 'APPROVER',
  AUDITOR: 'AUDITOR',
} as const;

export type AppRole = (typeof AppRole)[keyof typeof AppRole];

export const APP_ROLES = Object.values(AppRole);

export function isAppRole(value: string): value is AppRole {
  return (APP_ROLES as readonly string[]).includes(value);
}

export const ActorType = {
  USER: 'USER',
  SYSTEM: 'SYSTEM',
} as const;

export type ActorType = (typeof ActorType)[keyof typeof ActorType];

export interface Actor {
  readonly type: ActorType;
  readonly id: string;
  readonly organizationId: string;
  readonly roles: readonly AppRole[];
}

/** The worker acts under this identity when it advances operations on its own. */
export function systemActor(id = 'worker'): Actor {
  return { type: ActorType.SYSTEM, id, organizationId: 'system', roles: [AppRole.ADMIN] };
}

export function hasRole(actor: Actor, role: AppRole): boolean {
  return actor.roles.includes(role);
}

export function hasAnyRole(actor: Actor, roles: readonly AppRole[]): boolean {
  return roles.some((role) => actor.roles.includes(role));
}
