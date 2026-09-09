import type { AppConfig } from './index.js';

/**
 * Block tag a chain can be asked about finality with. `latest` means the chain exposes no
 * finality view of its own and depth counting is the only available evidence.
 */
export type FinalityTag = 'latest' | 'safe' | 'finalized';

export interface ReplacementPolicy {
  /** How long an attempt may sit submitted without inclusion before it may be replaced. */
  readonly stuckAfterMs: number;
  readonly maxReplacements: number;
  /** Minimum fee increase a replacement must carry; nodes reject equal-fee replacements. */
  readonly feeBumpPercent: number;
}

export interface ChainProfile {
  readonly chainId: number;
  readonly label: string;
  readonly rpcUrl: string;
  readonly eip1559: boolean;
  readonly finalityTag: FinalityTag;
  /** Depth required when the chain has no finality tag, or as the fallback when it does. */
  readonly confirmations: number;
  readonly replacement: ReplacementPolicy;
}

const ANVIL_CHAIN_ID = 31337;

/**
 * Anvil mines on demand and never reorganises, so depth is a deterministic stand-in for
 * finality there and nothing more. Public chains are asked for their own finalized tag.
 */
function finalityTagFor(chainId: number): FinalityTag {
  return chainId === ANVIL_CHAIN_ID ? 'latest' : 'finalized';
}

function labelFor(chainId: number): string {
  if (chainId === ANVIL_CHAIN_ID) return 'anvil-local';
  if (chainId === 11155111) return 'sepolia';
  return `evm-${chainId}`;
}

export function chainProfileFrom(input: {
  chainId: number;
  rpcUrl: string;
  confirmations: number;
  replacement: ReplacementPolicy;
}): ChainProfile {
  return {
    chainId: input.chainId,
    label: labelFor(input.chainId),
    rpcUrl: input.rpcUrl,
    eip1559: true,
    finalityTag: finalityTagFor(input.chainId),
    confirmations: input.confirmations,
    replacement: input.replacement,
  };
}

/**
 * Profiles known to this process, keyed by chain id. The active profile drives the
 * runtime; a second profile is present only when a testnet is configured, which is what
 * keeps per-chain policy a lookup rather than a global constant.
 */
export class ChainProfiles {
  private readonly byChainId: Map<number, ChainProfile>;

  constructor(
    readonly active: ChainProfile,
    others: readonly ChainProfile[] = [],
  ) {
    this.byChainId = new Map([active, ...others].map((profile) => [profile.chainId, profile]));
  }

  get(chainId: number): ChainProfile {
    const profile = this.byChainId.get(chainId);
    if (profile === undefined) {
      throw new Error(`no chain profile configured for chain ${chainId}`);
    }
    return profile;
  }

  list(): ChainProfile[] {
    return [...this.byChainId.values()];
  }
}

export function resolveChainProfiles(config: AppConfig): ChainProfiles {
  const replacement: ReplacementPolicy = {
    stuckAfterMs: config.TRANSACTION_STUCK_AFTER_MS,
    maxReplacements: config.TRANSACTION_MAX_REPLACEMENTS,
    feeBumpPercent: config.TRANSACTION_FEE_BUMP_PERCENT,
  };

  const active = chainProfileFrom({
    chainId: config.EVM_CHAIN_ID,
    rpcUrl: config.EVM_RPC_URL,
    confirmations: config.EVM_CONFIRMATIONS,
    replacement,
  });

  if (config.TESTNET_RPC_URL === undefined || config.TESTNET_CHAIN_ID === undefined) {
    return new ChainProfiles(active);
  }
  if (config.TESTNET_CHAIN_ID === active.chainId) {
    throw new Error('TESTNET_CHAIN_ID must differ from EVM_CHAIN_ID');
  }

  return new ChainProfiles(active, [
    chainProfileFrom({
      chainId: config.TESTNET_CHAIN_ID,
      rpcUrl: config.TESTNET_RPC_URL,
      confirmations: config.TESTNET_CONFIRMATIONS,
      replacement,
    }),
  ]);
}
