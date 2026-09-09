/**
 * Deploys InstitutionalToken to a configured chain profile, for bringing up a chain the
 * orchestrator has not run against before. Assets created through the API are deployed by
 * the worker, not by this script.
 *
 * Usage: pnpm deploy:token [chainId] with NAME, SYMBOL, DECIMALS and SUPPLY_CAP in the
 * environment, and DEPLOY_SIGNER_PRIVATE_KEY holding the deploying key.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { getConfig } from '../src/platform/config/index.js';
import { resolveChainProfiles } from '../src/platform/config/chain-profile.js';
import { ViemEvmGateway } from '../src/adapters/evm/viem-evm-gateway.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

const config = getConfig();
const profiles = resolveChainProfiles(config);
const requestedChainId = process.argv[2] === undefined ? undefined : Number(process.argv[2]);
const profile = requestedChainId === undefined ? profiles.active : profiles.get(requestedChainId);

const privateKey = required('DEPLOY_SIGNER_PRIVATE_KEY') as `0x${string}`;
const account = privateKeyToAccount(privateKey);
const gateway = new ViemEvmGateway({ rpcUrl: profile.rpcUrl, chainId: profile.chainId });

const identity = await gateway.getChainIdentity();
if (identity.chainId !== profile.chainId) {
  throw new Error(
    `chain mismatch: profile ${profile.label} expects ${profile.chainId}, RPC reports ${identity.chainId}`,
  );
}

const call = gateway.encodeTokenDeployment({
  name: required('NAME'),
  symbol: required('SYMBOL'),
  decimals: Number(required('DECIMALS')),
  supplyCap: BigInt(required('SUPPLY_CAP')),
  admin: account.address,
  minter: account.address,
  complianceOfficer: account.address,
  pauser: account.address,
});

const [fees, nonce] = await Promise.all([
  gateway.getFeeEstimate(),
  gateway.getTransactionCount(account.address, 'pending'),
]);
const gas = await gateway.simulate({
  from: account.address,
  to: null,
  data: call.data,
  value: 0n,
});
if (!gas.ok) throw new Error(`deployment would revert: ${gas.revertReason}`);

const signed = await account.signTransaction({
  chainId: profile.chainId,
  type: 'eip1559',
  nonce,
  data: call.data,
  gas: (gas.gasEstimate * 12n) / 10n,
  maxFeePerGas: fees.maxFeePerGas,
  maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  value: 0n,
});

const hash = await gateway.broadcastRawTransaction(signed);
console.log(`chain      ${profile.label} (${profile.chainId})`);
console.log(`deployer   ${account.address}`);
console.log(`tx         ${hash}`);

const deadline = Date.now() + 300_000;
while (Date.now() < deadline) {
  const receipt = await gateway.getTransactionReceipt(hash);
  if (receipt !== null) {
    if (receipt.status !== 'success') throw new Error(`deployment reverted in ${receipt.blockHash}`);
    console.log(`contract   ${receipt.contractAddress}`);
    console.log(`block      ${receipt.blockNumber} ${receipt.blockHash}`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
throw new Error(`no receipt for ${hash} within 5 minutes`);
