/**
 * There is deliberately no `sign(bytes)` operation. A caller may only ask for a signature
 * over a fully-specified EIP-1559 transaction whose destination and calldata this
 * application built from an allowlisted intent. Core code never touches key material.
 */

export interface UnsignedTransactionRequest {
  /** Durable transaction_attempts.id. Committed before signing so the request is auditable. */
  readonly attemptId: string;
  readonly chainId: number;
  readonly from: `0x${string}`;
  /** Null only for contract deployment. */
  readonly to: `0x${string}` | null;
  readonly nonce: number;
  readonly value: bigint;
  readonly data: `0x${string}`;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/** Non-secret context a policy-enforcing signer can evaluate before agreeing to sign. */
export interface SigningPolicyContext {
  readonly purpose: 'DEPLOY_TOKEN' | 'SET_ELIGIBILITY' | 'MINT' | 'NONCE_RECOVERY';
  readonly operationId?: string;
  readonly assetId?: string;
  readonly correlationId: string;
  /** Approvals and compliance evidence gathered before the request reached the signer. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

export const SignerRequestStatus = {
  PENDING: 'PENDING',
  SIGNED: 'SIGNED',
  REJECTED: 'REJECTED',
} as const;

export type SignerRequestStatus = (typeof SignerRequestStatus)[keyof typeof SignerRequestStatus];

/**
 * A signature request may outlive the call that submitted it: institutional signers queue
 * requests behind their own policy and human review.
 */
export type SignerRequestState =
  | { readonly status: 'PENDING'; readonly providerRequestId: string }
  | {
      readonly status: 'SIGNED';
      readonly providerRequestId: string;
      readonly signerAddress: `0x${string}`;
      readonly signedTransaction: `0x${string}`;
      readonly transactionHash: `0x${string}`;
    }
  | {
      readonly status: 'REJECTED';
      readonly providerRequestId: string;
      readonly reason: string;
      readonly code: string;
    };

export interface SignerProvider {
  readonly name: string;

  /** Address this signer will sign as. Callers verify the returned signature against it. */
  getSignerAddress(): Promise<`0x${string}`>;

  /**
   * Submits the request. Must be idempotent on `request.attemptId`: a retry after a lost
   * response has to resolve to the same provider request rather than a second signing
   * intent for the same money.
   */
  requestSignature(
    request: UnsignedTransactionRequest,
    context: SigningPolicyContext,
  ): Promise<SignerRequestState>;

  /** Current state of a request submitted earlier, possibly by a since-crashed worker. */
  fetchSignature(providerRequestId: string): Promise<SignerRequestState>;
}
