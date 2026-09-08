import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, type PrivateKeyAccount } from 'viem';
import type {
  SignerProvider,
  SignerResult,
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
 * DEVELOPMENT ONLY signer.
 *
 * Holds a raw private key in process memory. This exists so the full persist-before-
 * broadcast pipeline can be exercised locally; it is not a custody solution. The key is
 * never logged, persisted, enqueued, or returned through any API - it is confined to
 * this class and consumed only by viem's signing routine.
 */
export class LocalSignerProvider implements SignerProvider {
  readonly name = 'local-dev';

  readonly #account: PrivateKeyAccount;
  private readonly chainId: number;

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

  async sign(
    request: UnsignedTransactionRequest,
    context: SigningPolicyContext,
  ): Promise<SignerResult> {
    // A real signer would apply custody policy here. The local adapter still refuses
    // anything that does not match its own identity, chain, or value policy, so a bug
    // upstream cannot turn this into a general-purpose signing oracle.
    if (request.chainId !== this.chainId) {
      return {
        kind: 'REJECTED',
        code: 'CHAIN_ID_NOT_PERMITTED',
        reason: `signer is bound to chain ${this.chainId}`,
      };
    }
    if (request.from.toLowerCase() !== this.#account.address.toLowerCase()) {
      return {
        kind: 'REJECTED',
        code: 'SIGNER_ADDRESS_MISMATCH',
        reason: 'requested signer address is not held by this provider',
      };
    }
    if (request.value !== 0n) {
      return {
        kind: 'REJECTED',
        code: 'VALUE_TRANSFER_NOT_PERMITTED',
        reason: 'this signer never authorises native value transfers',
      };
    }
    if (request.to === null && context.purpose !== 'DEPLOY_TOKEN') {
      return {
        kind: 'REJECTED',
        code: 'CONTRACT_CREATION_NOT_PERMITTED',
        reason: 'contract creation is only permitted for token deployment',
      };
    }

    const serializable = {
      type: 'eip1559' as const,
      chainId: request.chainId,
      nonce: request.nonce,
      gas: request.gasLimit,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
      value: request.value,
      data: request.data,
      ...(request.to === null ? {} : { to: request.to }),
    };

    const signedTransaction = await this.#account.signTransaction(serializable);

    return {
      kind: 'SIGNED',
      signerAddress: this.#account.address,
      signedTransaction,
      transactionHash: keccak256(signedTransaction),
    };
  }
}
