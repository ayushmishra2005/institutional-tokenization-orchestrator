import {
  createPublicClient,
  decodeEventLog,
  encodeDeployData,
  encodeFunctionData,
  http,
  BaseError,
  ContractFunctionRevertedError,
  type Abi,
  type PublicClient,
} from 'viem';
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
} from '../../ports/evm-gateway.js';
import { AppError, ChainUnavailableError, ErrorCode } from '../../domain/errors.js';
import { institutionalTokenAbi, institutionalTokenBytecode } from './token-artifact.js';
import type { Metrics } from '../../platform/metrics/index.js';

export interface ViemGatewayOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly metrics?: Metrics;
}

/**
 * The only module permitted to import viem for chain access. Exposes explicit allowlisted
 * operations rather than a generic contract-call facade.
 */
export class ViemEvmGateway implements EvmGateway {
  private readonly client: PublicClient;
  private readonly expectedChainId: number;
  private readonly metrics: Metrics | undefined;

  constructor(options: ViemGatewayOptions) {
    this.expectedChainId = options.chainId;
    this.metrics = options.metrics;
    this.client = createPublicClient({
      transport: http(options.rpcUrl, { retryCount: 2, timeout: 15_000 }),
    });
  }

  private async instrument<T>(method: string, fn: () => Promise<T>): Promise<T> {
    const stop = this.metrics?.rpcDuration.startTimer({ method });
    try {
      const result = await fn();
      this.metrics?.rpcRequests.inc({ method, result: 'success' });
      return result;
    } catch (error) {
      this.metrics?.rpcRequests.inc({ method, result: 'failure' });
      throw error;
    } finally {
      stop?.();
    }
  }

  private async rpc<T>(method: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.instrument(method, fn);
    } catch (error) {
      throw new ChainUnavailableError(`EVM RPC call ${method} failed`, error);
    }
  }

  async getChainIdentity(): Promise<ChainIdentity> {
    const [chainId, blockNumber] = await Promise.all([
      this.rpc('eth_chainId', () => this.client.getChainId()),
      this.rpc('eth_blockNumber', () => this.client.getBlockNumber()),
    ]);

    // Never trust an RPC endpoint to be the chain we think it is.
    if (chainId !== this.expectedChainId) {
      throw new AppError(
        ErrorCode.CHAIN_IDENTITY_MISMATCH,
        `RPC endpoint reports chain ${chainId}, expected ${this.expectedChainId}`,
        { details: { expected: this.expectedChainId, actual: chainId } },
      );
    }
    return { chainId, latestBlockNumber: Number(blockNumber) };
  }

  async assertContractDeployed(address: `0x${string}`): Promise<void> {
    const code = await this.rpc('eth_getCode', () => this.client.getCode({ address }));
    if (code === undefined || code === '0x') {
      throw new AppError(ErrorCode.CHAIN_IDENTITY_MISMATCH, 'no contract code at address', {
        details: { address },
      });
    }
  }

  async getFeeEstimate(): Promise<FeeEstimate> {
    const fees = await this.rpc('eth_feeHistory', () => this.client.estimateFeesPerGas());
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 1_000_000_000n;
    const maxFeePerGas = fees.maxFeePerGas ?? maxPriorityFeePerGas * 2n;
    return {
      maxFeePerGas: maxFeePerGas > maxPriorityFeePerGas ? maxFeePerGas : maxPriorityFeePerGas,
      maxPriorityFeePerGas,
    };
  }

  async getTransactionCount(
    address: `0x${string}`,
    blockTag: 'latest' | 'pending',
  ): Promise<number> {
    return this.rpc('eth_getTransactionCount', () =>
      this.client.getTransactionCount({ address, blockTag }),
    );
  }

  encodeTokenDeployment(params: TokenDeploymentParams): EncodedCall {
    return {
      to: null,
      data: encodeDeployData({
        abi: institutionalTokenAbi,
        bytecode: institutionalTokenBytecode,
        args: [
          params.name,
          params.symbol,
          params.decimals,
          params.supplyCap,
          params.admin,
          params.minter,
          params.complianceOfficer,
          params.pauser,
        ],
      }),
    };
  }

  encodeMintCall(contract: `0x${string}`, params: MintCallParams): EncodedCall {
    return {
      to: contract,
      data: encodeFunctionData({
        abi: institutionalTokenAbi,
        functionName: 'mintWithReference',
        args: [params.recipient, params.amount, params.operationReference, params.deadline],
      }),
    };
  }

  encodeSetEligibilityCall(contract: `0x${string}`, params: SetEligibilityParams): EncodedCall {
    return {
      to: contract,
      data: encodeFunctionData({
        abi: institutionalTokenAbi,
        functionName: 'setEligibility',
        args: [params.account, params.eligibleUntil],
      }),
    };
  }

  async simulate(input: {
    from: `0x${string}`;
    to: `0x${string}` | null;
    data: `0x${string}`;
    value: bigint;
  }): Promise<SimulationResult> {
    try {
      const gasEstimate = await this.instrument('eth_estimateGas', () =>
        this.client.estimateGas({
          account: input.from,
          data: input.data,
          value: input.value,
          ...(input.to === null ? {} : { to: input.to }),
        }),
      );
      return { ok: true, gasEstimate };
    } catch (error) {
      const decoded = decodeRevert(error);
      if (decoded !== null) return { ok: false, revertReason: decoded.reason, raw: decoded.raw };
      // Not a revert: the node itself is unreachable or misbehaving.
      throw new ChainUnavailableError('simulation could not be performed', error);
    }
  }

  async broadcastRawTransaction(signed: `0x${string}`): Promise<`0x${string}`> {
    // Errors propagate unwrapped: the caller must distinguish a deterministic node
    // rejection from an ambiguous transport failure before deciding the operation state.
    return this.instrument('eth_sendRawTransaction', () =>
      this.client.sendRawTransaction({ serializedTransaction: signed }),
    );
  }

  async getTransactionReceipt(hash: `0x${string}`): Promise<TransactionReceiptView | null> {
    try {
      const receipt = await this.instrument('eth_getTransactionReceipt', () =>
        this.client.getTransactionReceipt({ hash }),
      );
      return {
        transactionHash: receipt.transactionHash,
        status: receipt.status,
        blockNumber: Number(receipt.blockNumber),
        blockHash: receipt.blockHash,
        gasUsed: receipt.gasUsed,
        contractAddress: receipt.contractAddress ?? null,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics,
          data: log.data,
          logIndex: log.logIndex ?? 0,
        })),
      };
    } catch (error) {
      // viem throws when a receipt does not exist yet; that is a normal poll outcome.
      if (isNotFound(error)) return null;
      throw new ChainUnavailableError('receipt lookup failed', error);
    }
  }

  async getLatestBlockNumber(): Promise<number> {
    return Number(await this.rpc('eth_blockNumber', () => this.client.getBlockNumber()));
  }

  decodeMintExecutedEvents(
    contract: `0x${string}`,
    logs: readonly LogView[],
  ): readonly MintExecutedEvent[] {
    const events: MintExecutedEvent[] = [];
    for (const log of logs) {
      // Only logs emitted by the asset's own contract are considered.
      if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: institutionalTokenAbi,
          data: log.data,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });
        if (decoded.eventName !== 'MintExecuted') continue;
        const args = decoded.args as unknown as MintExecutedEvent;
        events.push({
          operationReference: args.operationReference,
          recipient: args.recipient,
          amount: args.amount,
          newTotalSupply: args.newTotalSupply,
        });
      } catch {
        // Unrelated or undecodable log; reconciliation only cares about MintExecuted.
      }
    }
    return events;
  }

  private read<T>(contract: `0x${string}`, functionName: string, args: readonly unknown[] = []) {
    return this.rpc(`eth_call:${functionName}`, () =>
      this.client.readContract({
        address: contract,
        // Widened to the runtime ABI type: the read helper is generic over the token's
        // view functions, which the const-typed ABI cannot express in one signature.
        abi: institutionalTokenAbi as unknown as Abi,
        functionName,
        args,
      }),
    ) as Promise<T>;
  }

  async readTokenState(contract: `0x${string}`): Promise<TokenChainState> {
    const [paused, totalSupply, supplyCap, decimals, symbol] = await Promise.all([
      this.read<boolean>(contract, 'paused'),
      this.read<bigint>(contract, 'totalSupply'),
      this.read<bigint>(contract, 'supplyCap'),
      this.read<number>(contract, 'decimals'),
      this.read<string>(contract, 'symbol'),
    ]);
    return { paused, totalSupply, supplyCap, decimals, symbol };
  }

  async readBalanceOf(contract: `0x${string}`, account: `0x${string}`): Promise<bigint> {
    return this.read<bigint>(contract, 'balanceOf', [account]);
  }

  async readReferenceConsumed(
    contract: `0x${string}`,
    reference: `0x${string}`,
  ): Promise<boolean> {
    return this.read<boolean>(contract, 'referenceConsumed', [reference]);
  }

  async readEligibleUntil(contract: `0x${string}`, account: `0x${string}`): Promise<bigint> {
    return this.read<bigint>(contract, 'eligibleUntil', [account]);
  }
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  return name === 'TransactionReceiptNotFoundError' || name === 'TransactionNotFoundError';
}

interface DecodedRevert {
  readonly reason: string;
  readonly raw: string;
}

/** Extracts a custom-error name or revert string from a viem error, if it is a revert. */
function decodeRevert(error: unknown): DecodedRevert | null {
  if (!(error instanceof BaseError)) return null;

  const reverted = error.walk((candidate) => candidate instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    const name = reverted.data?.errorName ?? reverted.reason ?? 'execution reverted';
    return { reason: name, raw: reverted.shortMessage };
  }

  const message = error.shortMessage ?? error.message;
  if (/revert|execution reverted|custom error/i.test(message)) {
    const details = error.metaMessages?.join(' ') ?? '';
    return { reason: extractErrorName(`${message} ${details}`), raw: message };
  }
  return null;
}

function extractErrorName(text: string): string {
  const custom = /Error:\s*([A-Za-z0-9_]+)\(/.exec(text);
  if (custom?.[1] !== undefined) return custom[1];
  const reason = /reverted with the following reason:\s*(.+)/i.exec(text);
  if (reason?.[1] !== undefined) return reason[1].trim();
  return 'execution reverted';
}

export { AmbiguousBroadcastError };
