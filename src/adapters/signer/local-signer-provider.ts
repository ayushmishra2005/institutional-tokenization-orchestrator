import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toFunctionSelector, type PrivateKeyAccount } from 'viem';
import { institutionalTokenAbi } from '../evm/token-artifact.js';
import type {
  SignerProvider,
  SignerRequestState,
  SigningPolicyContext,
  UnsignedTransactionRequest,
} from '../../ports/signer-provider.js';

export interface LocalSignerOptions {
  readonly privateKey: `0x${string}`;
  /** Address the operator expects this key to correspond to; verified at construction. */
  readonly expectedAddress: `0x${string}`;
  readonly chainId: number;
}

/**
 * Calls this signer will authorise. An upstream bug that produced arbitrary calldata is
 * stopped here rather than at the gateway that built it.
 */
const ALLOWED_SELECTORS = new Set(
  institutionalTokenAbi
    .filter(
      (entry): entry is Extract<typeof entry, { type: 'function'; name: string }> =>
        entry.type === 'function' &&
        (entry.name === 'mintWithReference' || entry.name === 'setEligibility'),
    )
    .map((entry) => toFunctionSelector(entry)),
);

/**
 * DEVELOPMENT ONLY signer.
 *
 * Holds a raw private key in process memory. This exists so the full persist-before-
 * broadcast pipeline can be exercised locally; it is not a custody solution. The key is
 * never logged, persisted, enqueued, or returned through any API - it is confined to
 * this class and consumed only by viem's signing routine.
 *
 * It decides synchronously, so a request is either SIGNED or REJECTED by the time
 * `requestSignature` returns.
 */
export class LocalSignerProvider implements SignerProvider {
  readonly name = 'local-dev';

  readonly #account: PrivateKeyAccount;
  private readonly chainId: number;
  private readonly decided = new Map<string, SignerRequestState>();

  constructor(options: LocalSignerOptions) {
    this.#account = privateKeyToAccount(options.privateKey);
    this.chainId = options.chainId;

    if (this.#account.address.toLowerCase() !== options.expectedAddress.toLowerCase()) {
      // Deliberately does not echo the derived address alongside the key material config.
      throw new Error('LOCAL_SIGNER_PRIVATE_KEY does not correspond to LOCAL_SIGNER_ADDRESS');
    }
  }

  async getSignerAddress(): Promise<`0x${string}`> {
    return this.#account.address;
  }

  async requestSignature(
    request: UnsignedTransactionRequest,
    context: SigningPolicyContext,
  ): Promise<SignerRequestState> {
    // Derived from the attempt rather than generated, so a retry after a lost response
    // resolves to the same request instead of a second signing intent.
    const providerRequestId = `local-${request.attemptId}`;

    const rejection = this.evaluatePolicy(request, context);
    if (rejection !== null) {
      const state: SignerRequestState = { ...rejection, providerRequestId };
      this.decided.set(providerRequestId, state);
      return state;
    }

    const signedTransaction = await this.#account.signTransaction({
      type: 'eip1559' as const,
      chainId: request.chainId,
      nonce: request.nonce,
      gas: request.gasLimit,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
      value: request.value,
      data: request.data,
      ...(request.to === null ? {} : { to: request.to }),
    });

    const state: SignerRequestState = {
      status: 'SIGNED',
      providerRequestId,
      signerAddress: this.#account.address,
      signedTransaction,
      transactionHash: keccak256(signedTransaction),
    };
    this.decided.set(providerRequestId, state);
    return state;
  }

  async fetchSignature(providerRequestId: string): Promise<SignerRequestState> {
    const state = this.decided.get(providerRequestId);
    if (state === undefined) {
      throw new Error(`unknown signer request ${providerRequestId}`);
    }
    return state;
  }

  private evaluatePolicy(
    request: UnsignedTransactionRequest,
    context: SigningPolicyContext,
  ): Omit<Extract<SignerRequestState, { status: 'REJECTED' }>, 'providerRequestId'> | null {
    if (request.chainId !== this.chainId) {
      return {
        status: 'REJECTED',
        code: 'CHAIN_ID_NOT_PERMITTED',
        reason: `signer is bound to chain ${this.chainId}`,
      };
    }
    if (request.from.toLowerCase() !== this.#account.address.toLowerCase()) {
      return {
        status: 'REJECTED',
        code: 'SIGNER_ADDRESS_MISMATCH',
        reason: 'requested signer address is not held by this provider',
      };
    }
    if (request.value !== 0n) {
      return {
        status: 'REJECTED',
        code: 'VALUE_TRANSFER_NOT_PERMITTED',
        reason: 'this signer never authorises native value transfers',
      };
    }
    if (request.to === null) {
      return context.purpose === 'DEPLOY_TOKEN'
        ? null
        : {
            status: 'REJECTED',
            code: 'CONTRACT_CREATION_NOT_PERMITTED',
            reason: 'contract creation is only permitted for token deployment',
          };
    }
    if (!ALLOWED_SELECTORS.has(request.data.slice(0, 10) as `0x${string}`)) {
      return {
        status: 'REJECTED',
        code: 'FUNCTION_NOT_PERMITTED',
        reason: 'calldata does not select an allowlisted token function',
      };
    }
    return null;
  }
}
