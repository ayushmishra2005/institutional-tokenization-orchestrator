/**
 * Domain and module code depends on these plain types only; viem lives behind the adapter.
 * Operations are allowlisted - there is no "call any contract with any calldata" entry point.
 */

export interface ChainIdentity {
  readonly chainId: number;
  readonly latestBlockNumber: number;
}

export interface FeeEstimate {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export interface TokenDeploymentParams {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly supplyCap: bigint;
  readonly admin: `0x${string}`;
  readonly minter: `0x${string}`;
  readonly complianceOfficer: `0x${string}`;
  readonly pauser: `0x${string}`;
}

export interface MintCallParams {
  readonly recipient: `0x${string}`;
  readonly amount: bigint;
  readonly operationReference: `0x${string}`;
  readonly deadline: bigint;
}

export interface SetEligibilityParams {
  readonly account: `0x${string}`;
  readonly eligibleUntil: bigint;
}

/** A destination + calldata pair produced only by this application's encoders. */
export interface EncodedCall {
  readonly to: `0x${string}` | null;
  readonly data: `0x${string}`;
}

export interface SimulationSuccess {
  readonly ok: true;
  readonly gasEstimate: bigint;
}

export interface SimulationFailure {
  readonly ok: false;
  /** Decoded custom-error name when recognised, otherwise a short message. */
  readonly revertReason: string;
  readonly raw?: string;
}

export type SimulationResult = SimulationSuccess | SimulationFailure;

export interface TransactionReceiptView {
  readonly transactionHash: `0x${string}`;
  readonly status: 'success' | 'reverted';
  readonly blockNumber: number;
  readonly blockHash: `0x${string}`;
  readonly gasUsed: bigint;
  readonly contractAddress: `0x${string}` | null;
  readonly logs: readonly LogView[];
}

export interface LogView {
  readonly address: `0x${string}`;
  readonly topics: readonly `0x${string}`[];
  readonly data: `0x${string}`;
  readonly logIndex: number;
}

export interface MintExecutedEvent {
  readonly operationReference: `0x${string}`;
  readonly recipient: `0x${string}`;
  readonly amount: bigint;
  readonly newTotalSupply: bigint;
}

export interface TokenChainState {
  readonly paused: boolean;
  readonly totalSupply: bigint;
  readonly supplyCap: bigint;
  readonly decimals: number;
  readonly symbol: string;
}

export interface EvmGateway {
  getChainIdentity(): Promise<ChainIdentity>;
  /** Guards against pointing at an address with no code, or the wrong chain. */
  assertContractDeployed(address: `0x${string}`): Promise<void>;
  getFeeEstimate(): Promise<FeeEstimate>;
  getTransactionCount(address: `0x${string}`, blockTag: 'latest' | 'pending'): Promise<number>;

  encodeTokenDeployment(params: TokenDeploymentParams): EncodedCall;
  encodeMintCall(contract: `0x${string}`, params: MintCallParams): EncodedCall;
  encodeSetEligibilityCall(contract: `0x${string}`, params: SetEligibilityParams): EncodedCall;

  simulate(input: {
    from: `0x${string}`;
    to: `0x${string}` | null;
    data: `0x${string}`;
    value: bigint;
  }): Promise<SimulationResult>;

  /** Sends exactly the bytes it is given. Never re-encodes or re-signs. */
  broadcastRawTransaction(signed: `0x${string}`): Promise<`0x${string}`>;

  getTransactionReceipt(hash: `0x${string}`): Promise<TransactionReceiptView | null>;
  getLatestBlockNumber(): Promise<number>;
  /** Canonical hash at a height, or null if the chain has no such block. */
  getBlockHashAt(blockNumber: number): Promise<`0x${string}` | null>;
  /** Null when the chain exposes no finalized tag, as on a local development node. */
  getFinalizedBlockNumber(): Promise<number | null>;

  decodeMintExecutedEvents(
    contract: `0x${string}`,
    logs: readonly LogView[],
  ): readonly MintExecutedEvent[];

  readTokenState(contract: `0x${string}`): Promise<TokenChainState>;
  readBalanceOf(contract: `0x${string}`, account: `0x${string}`): Promise<bigint>;
  readReferenceConsumed(contract: `0x${string}`, reference: `0x${string}`): Promise<boolean>;
  readEligibleUntil(contract: `0x${string}`, account: `0x${string}`): Promise<bigint>;
}

/**
 * Thrown when a broadcast attempt neither succeeded nor definitively failed. The caller
 * must move the operation to BROADCAST_UNKNOWN, never to FAILED.
 */
export class AmbiguousBroadcastError extends Error {
  constructor(
    message: string,
    readonly expectedHash: `0x${string}`,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AmbiguousBroadcastError';
  }
}
