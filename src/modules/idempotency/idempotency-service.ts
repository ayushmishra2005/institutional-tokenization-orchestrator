import type { Database, Transaction } from '../../db/pool.js';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  IdempotencyStatus,
  releaseIdempotencyKey,
  type IdempotencyIdentity,
} from '../../db/repositories/idempotency-repository.js';
import { AppError, ErrorCode } from '../../domain/errors.js';
import { canonicalHash, type JsonValue } from '../../domain/canonical.js';

export interface IdempotentResult {
  readonly status: number;
  readonly body: JsonValue;
  readonly resourceType: string;
  readonly resourceId: string;
}

export interface IdempotentOutcome extends IdempotentResult {
  /** True when the response was served from a previously stored result. */
  readonly replayed: boolean;
}

/**
 * PostgreSQL-backed idempotency for financial mutations.
 *
 * The key is bound to endpoint scope, organization, actor and a canonical hash of the
 * request body. Deliberately independent of Redis: losing the cache must never allow a
 * duplicate mint.
 */
export class IdempotencyService {
  constructor(private readonly db: Database) {}

  async execute(
    input: {
      identity: IdempotencyIdentity;
      request: JsonValue;
    },
    work: (tx: Transaction) => Promise<IdempotentResult>,
  ): Promise<IdempotentOutcome> {
    const requestHash = canonicalHash(input.request);

    // Claim in its own committed transaction so a concurrent request with the same key
    // immediately observes the winner instead of blocking behind the business work.
    const { claimed, record } = await claimIdempotencyKey(this.db, {
      ...input.identity,
      requestHash,
    });

    if (!claimed) {
      // Same key, different payload: never guess which one the caller meant.
      if (record.requestHash !== requestHash) {
        throw new AppError(
          ErrorCode.IDEMPOTENCY_CONFLICT,
          'idempotency key was already used with a different request payload',
          { details: { idempotencyKey: input.identity.idempotencyKey } },
        );
      }

      if (record.status === IdempotencyStatus.COMPLETED) {
        return {
          status: record.responseStatus ?? 200,
          body: (record.responseBody ?? null) as JsonValue,
          resourceType: record.resourceType ?? 'unknown',
          resourceId: record.resourceId ?? '',
          replayed: true,
        };
      }

      throw new AppError(
        ErrorCode.IDEMPOTENCY_IN_PROGRESS,
        'an identical request is currently being processed',
        { details: { idempotencyKey: input.identity.idempotencyKey }, retryable: true },
      );
    }

    try {
      // Business effect and stored response commit together, so a crash cannot leave a
      // created operation with no recorded idempotent result.
      const result = await this.db.transaction(async (tx) => {
        const produced = await work(tx);
        await completeIdempotencyKey(tx, {
          id: record.id,
          responseStatus: produced.status,
          responseBody: produced.body,
          resourceType: produced.resourceType,
          resourceId: produced.resourceId,
        });
        return produced;
      });
      return { ...result, replayed: false };
    } catch (error) {
      // Release the claim so the caller may retry the same key after fixing the cause.
      await releaseIdempotencyKey(this.db, record.id).catch(() => undefined);
      throw error;
    }
  }
}
