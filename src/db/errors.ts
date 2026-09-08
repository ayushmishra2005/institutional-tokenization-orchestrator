/** PostgreSQL error-code helpers, so constraint violations become domain errors. */

export const PgErrorCode = {
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  FOREIGN_KEY_VIOLATION: '23503',
  RESTRICT_VIOLATION: '23001',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const;

interface PgErrorLike {
  readonly code?: string;
  readonly constraint?: string;
}

function asPgError(error: unknown): PgErrorLike | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as PgErrorLike & { cause?: unknown };
  if (typeof candidate.code === 'string') return candidate;
  // Drizzle wraps the driver error; unwrap one level.
  if (candidate.cause !== undefined) return asPgError(candidate.cause);
  return null;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = asPgError(error);
  if (pg?.code !== PgErrorCode.UNIQUE_VIOLATION) return false;
  return constraint === undefined || pg.constraint === constraint;
}

export function isCheckViolation(error: unknown, constraint?: string): boolean {
  const pg = asPgError(error);
  if (pg?.code !== PgErrorCode.CHECK_VIOLATION) return false;
  return constraint === undefined || pg.constraint === constraint;
}

export function constraintName(error: unknown): string | undefined {
  return asPgError(error)?.constraint;
}
