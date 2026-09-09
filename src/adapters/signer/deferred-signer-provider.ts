import type {
  SignerProvider,
  SignerRequestState,
  SigningPolicyContext,
  UnsignedTransactionRequest,
} from '../../ports/signer-provider.js';

interface DeferredRequest {
  readonly request: UnsignedTransactionRequest;
  readonly context: SigningPolicyContext;
  pollsBeforeSigning: number;
  rejection: { code: string; reason: string } | null;
  settled: SignerRequestState | null;
}

export interface DeferredSignerOptions {
  /** Number of PENDING answers before the request is handed to the underlying signer. */
  readonly pollsBeforeSigning?: number;
}

/**
 * DEVELOPMENT ONLY signer that answers asynchronously.
 *
 * Institutional custody providers queue a request behind their own policy and release a
 * signature later, so the orchestrator must survive a worker exiting while a request is
 * still outstanding. This adapter reproduces that timing deterministically - a request
 * advances when it is polled, never on a timer - and delegates the actual signing to
 * `inner` so no additional key handling exists here.
 */
export class DeferredSignerProvider implements SignerProvider {
  readonly name: string;

  private readonly requests = new Map<string, DeferredRequest>();
  private pollsBeforeSigning: number;
  private fetchFailures = 0;

  constructor(
    private readonly inner: SignerProvider,
    options: DeferredSignerOptions = {},
  ) {
    this.name = `deferred-${inner.name}`;
    this.pollsBeforeSigning = options.pollsBeforeSigning ?? 1;
  }

  getSignerAddress(): Promise<`0x${string}`> {
    return this.inner.getSignerAddress();
  }

  async requestSignature(
    request: UnsignedTransactionRequest,
    context: SigningPolicyContext,
  ): Promise<SignerRequestState> {
    const providerRequestId = `deferred-${request.attemptId}`;
    const existing = this.requests.get(providerRequestId);
    if (existing !== undefined) {
      return existing.settled ?? { status: 'PENDING', providerRequestId };
    }

    this.requests.set(providerRequestId, {
      request,
      context,
      pollsBeforeSigning: this.pollsBeforeSigning,
      rejection: null,
      settled: null,
    });
    return this.advance(providerRequestId);
  }

  async fetchSignature(providerRequestId: string): Promise<SignerRequestState> {
    if (this.fetchFailures > 0) {
      this.fetchFailures -= 1;
      throw new Error('signer provider unavailable');
    }
    return this.advance(providerRequestId);
  }

  /** How many polls a newly submitted request waits before it is signed. */
  holdNewRequestsFor(polls: number): void {
    this.pollsBeforeSigning = polls;
  }

  /** Refuses the request the way a policy engine or a human reviewer would. */
  reject(attemptId: string, rejection: { code: string; reason: string }): void {
    const pending = this.requireRequest(`deferred-${attemptId}`);
    pending.rejection = rejection;
  }

  /** Releases the signature on the next poll. */
  release(attemptId: string): void {
    this.requireRequest(`deferred-${attemptId}`).pollsBeforeSigning = 0;
  }

  failNextFetches(count: number): void {
    this.fetchFailures = count;
  }

  private async advance(providerRequestId: string): Promise<SignerRequestState> {
    const pending = this.requireRequest(providerRequestId);
    if (pending.settled !== null) return pending.settled;

    if (pending.rejection !== null) {
      pending.settled = { status: 'REJECTED', providerRequestId, ...pending.rejection };
      return pending.settled;
    }

    if (pending.pollsBeforeSigning > 0) {
      pending.pollsBeforeSigning -= 1;
      return { status: 'PENDING', providerRequestId };
    }

    const signed = await this.inner.requestSignature(pending.request, pending.context);
    pending.settled = signed.status === 'PENDING' ? null : { ...signed, providerRequestId };
    return pending.settled ?? { status: 'PENDING', providerRequestId };
  }

  private requireRequest(providerRequestId: string): DeferredRequest {
    const pending = this.requests.get(providerRequestId);
    if (pending === undefined) throw new Error(`unknown signer request ${providerRequestId}`);
    return pending;
  }
}
