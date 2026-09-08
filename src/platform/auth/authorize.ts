import { ForbiddenError } from '../../domain/errors.js';
import { ActorType, hasAnyRole, type Actor, type AppRole } from '../../domain/roles.js';

/**
 * Authorization guard invoked by application services, not by HTTP routes.
 *
 * Keeping the check inside the service means the worker, the demo script and any future
 * transport all go through the same rule; an unauthenticated code path cannot bypass it
 * by simply not registering a route hook.
 */
export function requireRole(actor: Actor, allowed: readonly AppRole[], action: string): void {
  // The worker's system actor is trusted: it never originates from a request.
  if (actor.type === ActorType.SYSTEM) return;

  if (!hasAnyRole(actor, allowed)) {
    throw new ForbiddenError(`actor is not permitted to ${action}`, {
      action,
      requiredAnyOf: allowed,
    });
  }
}
