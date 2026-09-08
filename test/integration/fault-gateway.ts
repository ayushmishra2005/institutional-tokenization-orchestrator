import {
  AmbiguousBroadcastError,
  type ChainIdentity,
  type EncodedCall,
  type EvmGateway,
  type FeeEstimate,
  type LogView,
  type MintCallParams,
  type MintExecutedEvent,
  type SetEligibilityParams,
  type SimulationResult,
  type TokenChainState,
  type TokenDeploymentParams,
  type TransactionReceiptView,
} from '../../src/ports/evm-gateway.js';

export interface BroadcastCall {
  readonly signed: `0x${string}`;
  readonly attempt: number;
}

/**
 * Behaviour a test wants from the next broadcast.
 *
 * - `pass`: forward to the real chain.
 * - `ambiguous-after-send`: send for real, then pretend the RPC response was lost.
 *   The transaction *is* on chain, so recovery must find it by hash.
 * - `ambiguous-before-send`: drop the bytes and pretend the response was lost.
 *   Nothing reached the chain, so recovery must rebroadcast the identical bytes.
 */
export type BroadcastBehaviour = 'pass' | 'ambiguous-after-send' | 'ambiguous-before-send';

export interface FaultGatewayControls {
  /** Consumed in order; once exhausted every broadcast passes through. */
  broadcastPlan: BroadcastBehaviour[];
  /** Forces every simulation to report success, so a real revert can be observed. */
  forceSimulationSuccess: boolean;
  /** Invoked immediately before the broadcast decision is applied. */
  beforeBroadcast?: () => Promise<void>;
  /**
   * Encodes the mint with a deadline already in the past, so the contract reverts with
   * MintDeadlineExpired. Combined with forceSimulationSuccess this reaches a real
   * on-chain revert rather than a pre-flight rejection.
   */
  expireMintDeadline: boolean;
  /** Number of receipt lookups to fail with a transport error before passing through. */
  failReceiptLookups: number;
}

/**
 * Delegating EvmGateway that injects transport faults. Only broadcast and simulation are
 * altered; everything else hits the real node, so assertions still check canonical state.
 */
export class FaultInjectingGateway implements EvmGateway {
  readonly broadcasts: BroadcastCall[] = [];

  readonly controls: FaultGatewayControls = {
    broadcastPlan: [],
    forceSimulationSuccess: false,
    expireMintDeadline: false,
    failReceiptLookups: 0,
  };

  constructor(private readonly inner: EvmGateway) {}

  reset(): void {
    this.broadcasts.length = 0;
    this.controls.broadcastPlan = [];
    this.controls.forceSimulationSuccess = false;
    this.controls.expireMintDeadline = false;
    this.controls.failReceiptLookups = 0;
    delete this.controls.beforeBroadcast;
  }

  async broadcastRawTransaction(signed: `0x${string}`): Promise<`0x${string}`> {
    const attempt = this.broadcasts.length + 1;
    this.broadcasts.push({ signed, attempt });

    if (this.controls.beforeBroadcast !== undefined) {
      await this.controls.beforeBroadcast();
    }

    const behaviour = this.controls.broadcastPlan.shift() ?? 'pass';
    if (behaviour === 'pass') return this.inner.broadcastRawTransaction(signed);

    // The hash is derived from the signed bytes, so it is known even when the RPC
    // acknowledgement is lost. That is exactly what recovery relies on.
    const expectedHash = await this.hashOf(signed);

    if (behaviour === 'ambiguous-after-send') {
      await this.inner.broadcastRawTransaction(signed);
    }

    throw new AmbiguousBroadcastError('injected RPC timeout', expectedHash, {
      cause: new Error('socket hang up'),
    });
  }

  private async hashOf(signed: `0x${string}`): Promise<`0x${string}`> {
    const { keccak256 } = await import('viem');
    return keccak256(signed);
  }

  async simulate(input: {
    from: `0x${string}`;
    to: `0x${string}` | null;
    data: `0x${string}`;
    value: bigint;
  }): Promise<SimulationResult> {
    if (this.controls.forceSimulationSuccess) {
      return { ok: true, gasEstimate: 500_000n };
    }
    return this.inner.simulate(input);
  }

  getChainIdentity(): Promise<ChainIdentity> {
    return this.inner.getChainIdentity();
  }

  assertContractDeployed(address: `0x${string}`): Promise<void> {
    return this.inner.assertContractDeployed(address);
  }

  getFeeEstimate(): Promise<FeeEstimate> {
    return this.inner.getFeeEstimate();
  }

  getTransactionCount(address: `0x${string}`, blockTag: 'latest' | 'pending'): Promise<number> {
    return this.inner.getTransactionCount(address, blockTag);
  }

  encodeTokenDeployment(params: TokenDeploymentParams): EncodedCall {
    return this.inner.encodeTokenDeployment(params);
  }

  encodeMintCall(contract: `0x${string}`, params: MintCallParams): EncodedCall {
    if (!this.controls.expireMintDeadline) return this.inner.encodeMintCall(contract, params);
    return this.inner.encodeMintCall(contract, {
      ...params,
      deadline: BigInt(Math.floor(Date.now() / 1000) - 60),
    });
  }

  encodeSetEligibilityCall(contract: `0x${string}`, params: SetEligibilityParams): EncodedCall {
    return this.inner.encodeSetEligibilityCall(contract, params);
  }

  getTransactionReceipt(hash: `0x${string}`): Promise<TransactionReceiptView | null> {
    if (this.controls.failReceiptLookups > 0) {
      this.controls.failReceiptLookups -= 1;
      return Promise.reject(new Error('injected RPC timeout on receipt lookup'));
    }
    return this.inner.getTransactionReceipt(hash);
  }

  getLatestBlockNumber(): Promise<number> {
    return this.inner.getLatestBlockNumber();
  }

  decodeMintExecutedEvents(
    contract: `0x${string}`,
    logs: readonly LogView[],
  ): readonly MintExecutedEvent[] {
    return this.inner.decodeMintExecutedEvents(contract, logs);
  }

  readTokenState(contract: `0x${string}`): Promise<TokenChainState> {
    return this.inner.readTokenState(contract);
  }

  readBalanceOf(contract: `0x${string}`, account: `0x${string}`): Promise<bigint> {
    return this.inner.readBalanceOf(contract, account);
  }

  readReferenceConsumed(contract: `0x${string}`, reference: `0x${string}`): Promise<boolean> {
    return this.inner.readReferenceConsumed(contract, reference);
  }

  readEligibleUntil(contract: `0x${string}`, account: `0x${string}`): Promise<bigint> {
    return this.inner.readEligibleUntil(contract, account);
  }
}
