import { canonicalHash } from '../../domain/canonical.js';

/**
 * Administrative operations get the same intent fingerprint treatment as a mint proposal:
 * the worker recomputes it before signing, so a definition edited between the request and
 * execution stops the operation instead of quietly deploying something else.
 */
export function hashAssetDeploymentIntent(asset: {
  id: string;
  chainId: number;
  symbol: string;
  name: string;
  decimals: number;
  supplyCap: string;
}): string {
  return canonicalHash({
    kind: 'DEPLOY_ASSET',
    assetId: asset.id,
    chainId: asset.chainId,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    supplyCap: asset.supplyCap,
  });
}

export function hashEligibilitySyncIntent(input: {
  assetId: string;
  chainId: number;
  walletId: string;
  walletAddress: string;
  complianceDecisionId: string;
  eligibleUntil: string;
}): string {
  return canonicalHash({
    kind: 'SYNC_ELIGIBILITY',
    assetId: input.assetId,
    chainId: input.chainId,
    walletId: input.walletId,
    walletAddress: input.walletAddress.toLowerCase(),
    complianceDecisionId: input.complianceDecisionId,
    eligibleUntil: input.eligibleUntil,
  });
}
