import type { Logger } from '../platform/logging/index.js';
import type { Actor } from '../domain/roles.js';

/**
 * Ambient context for one unit of work. Carried explicitly rather than through async
 * local storage so every service signature shows what it depends on.
 */
export interface RequestContext {
  readonly actor: Actor;
  /** Stable across the whole workflow, including asynchronous worker execution. */
  readonly correlationId: string;
  readonly requestId: string;
  readonly logger: Logger;
}
