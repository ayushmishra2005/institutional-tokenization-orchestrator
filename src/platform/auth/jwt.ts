import { SignJWT, jwtVerify } from 'jose';
import { UnauthorizedError } from '../../domain/errors.js';

export interface JwtSettings {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
}

/** Identity asserted by a verified token, before roles are resolved from the database. */
export interface AuthenticatedSubject {
  readonly subject: string;
  readonly organizationId: string;
}

/**
 * Deterministic local development authentication.
 *
 * HS256 with a shared secret is adequate for a local reference implementation and
 * deliberately trivial to mint tokens for in tests and the demo script. A real
 * deployment would delegate to an external identity provider.
 */
export class DevJwtAuthenticator {
  private readonly key: Uint8Array;

  constructor(private readonly settings: JwtSettings) {
    this.key = new TextEncoder().encode(settings.secret);
  }

  async issue(input: {
    subject: string;
    organizationId: string;
    expiresIn?: string;
  }): Promise<string> {
    return new SignJWT({ org: input.organizationId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(input.subject)
      .setIssuer(this.settings.issuer)
      .setAudience(this.settings.audience)
      .setIssuedAt()
      .setExpirationTime(input.expiresIn ?? '2h')
      .sign(this.key);
  }

  /**
   * Verifies the token and returns only the asserted identity. Roles are deliberately
   * NOT taken from the token: PostgreSQL owns application roles, so a revocation takes
   * effect immediately rather than when the token happens to expire.
   */
  async verify(token: string): Promise<AuthenticatedSubject> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        issuer: this.settings.issuer,
        audience: this.settings.audience,
        algorithms: ['HS256'],
      }));
    } catch {
      // The underlying reason is intentionally not surfaced to the caller.
      throw new UnauthorizedError('invalid or expired token');
    }

    const subject = payload.sub;
    const organizationId = payload['org'];

    if (typeof subject !== 'string' || subject.length === 0) {
      throw new UnauthorizedError('token is missing a subject');
    }
    if (typeof organizationId !== 'string' || organizationId.length === 0) {
      throw new UnauthorizedError('token is missing an organization');
    }

    return { subject, organizationId };
  }

  /** Extracts the bearer token from an Authorization header value. */
  static parseBearer(header: string | undefined): string {
    if (header === undefined) throw new UnauthorizedError('missing Authorization header');
    const match = /^Bearer (.+)$/.exec(header.trim());
    if (match?.[1] === undefined) throw new UnauthorizedError('malformed Authorization header');
    return match[1];
  }
}
