/**
 * Signing port.
 *
 * There is deliberately no `sign(bytes)` operation. A caller may only ask for a
 * signature over a fully-specified EIP-1559 transaction whose destination and calldata
 * were constructed by this application from an allowlisted intent. Core application code
 * never touches key material; a future HSM/KMS/MPC adapter implements this same shape.
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
  readonly purpose: 'DEPLOY_TOKEN' | 'SET_ELIGIBILITY' | 'MINT';
  readonly operationId?: string;
  readonly assetId?: string;
  readonly correlationId: string;
  /** Approvals and compliance evidence gathered before the request reached the signer. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

export const SignerResultKind = {
  SIGNED: 'SIGNED',
  REJECTED: 'REJECTED',
} as const;

export type SignerResultKind = (typeof SignerResultKind)[keyof typeof SignerResultKind];

export type SignerResult =
  | {
      readonly kind: 'SIGNED';
      readonly signerAddress: `0x${string}`;
      readonly signedTransaction: `0x${string}`;
      readonly transactionHash: `0x${string}`;
    }
  | {
      readonly kind: 'REJECTED';
      readonly reason: string;
      readonly code: string;
    };

export interface SignerProvider {
  readonly name: string;

  /** Address this signer will sign as. Callers verify the returned signature against it. */
  getSignerAddress(): Promise<`0x${string}`>;

  sign(
    request: UnsignedTransactionRequest,
    context: SigningPolicyContext,
  ): Promise<SignerResult>;
}
