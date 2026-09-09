/**
 * Shows a transaction that never reaches a block being replaced at the same nonce with a
 * higher fee: the original attempt stays on record, the replacement carries the identical
 * mint intent, and the operation settles once.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { expectStatus, startDemo, step } from './demo-support.js';
import { getConfig } from '../src/platform/config/index.js';
import { ViemEvmGateway } from '../src/adapters/evm/viem-evm-gateway.js';
import { AmbiguousBroadcastError, type EvmGateway } from '../src/ports/evm-gateway.js';
import { keccak256 } from 'viem';

const STUCK_AFTER_MS = 2_000;

/**
 * Reports the next broadcast outcome as unknown without sending it, which is what a client
 * timeout against a node that never propagated the transaction looks like.
 */
function withLosableBroadcast(inner: EvmGateway): { gateway: EvmGateway; loseNext: () => void } {
  let lose = false;
  const gateway: EvmGateway = {
    getChainIdentity: () => inner.getChainIdentity(),
    assertContractDeployed: (address) => inner.assertContractDeployed(address),
    getFeeEstimate: () => inner.getFeeEstimate(),
    getTransactionCount: (address, blockTag) => inner.getTransactionCount(address, blockTag),
    encodeTokenDeployment: (params) => inner.encodeTokenDeployment(params),
    encodeMintCall: (contract, params) => inner.encodeMintCall(contract, params),
    encodeSetEligibilityCall: (contract, params) => inner.encodeSetEligibilityCall(contract, params),
    simulate: (input) => inner.simulate(input),
    broadcastRawTransaction: async (signed) => {
      if (!lose) return inner.broadcastRawTransaction(signed);
      lose = false;
      throw new AmbiguousBroadcastError('demo: broadcast response lost', keccak256(signed));
    },
    getTransactionReceipt: (hash) => inner.getTransactionReceipt(hash),
    getLatestBlockNumber: () => inner.getLatestBlockNumber(),
    getBlockHashAt: (blockNumber) => inner.getBlockHashAt(blockNumber),
    getFinalizedBlockNumber: () => inner.getFinalizedBlockNumber(),
    decodeMintExecutedEvents: (contract, logs) => inner.decodeMintExecutedEvents(contract, logs),
    readTokenState: (contract) => inner.readTokenState(contract),
    readBalanceOf: (contract, account) => inner.readBalanceOf(contract, account),
    readReferenceConsumed: (contract, reference) => inner.readReferenceConsumed(contract, reference),
    readEligibleUntil: (contract, account) => inner.readEligibleUntil(contract, account),
  };
  return {
    gateway,
    loseNext: () => {
      lose = true;
    },
  };
}

const config = getConfig();
const chain = withLosableBroadcast(
  new ViemEvmGateway({ rpcUrl: config.EVM_RPC_URL, chainId: config.EVM_CHAIN_ID }),
);
const demo = await startDemo({
  gateway: chain.gateway,
  // The replacement below is triggered by hand, so the periodic sweep stays out of the way.
  config: { TRANSACTION_STUCK_AFTER_MS: STUCK_AFTER_MS, RECOVERY_SWEEP_INTERVAL_MS: 300_000 },
});
const { call, awaitOperation, awaitOperationState, container } = demo;
const suffix = randomUUID().slice(0, 4).toUpperCase();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

try {
  console.log('\nInstitutional tokenization orchestrator - fee replacement demo\n');

  const assetResponse = await call({
    method: 'POST',
    url: '/v1/assets',
    as: 'dev-issuer',
    payload: {
      symbol: `RPLC${suffix}`.slice(0, 12),
      name: 'Demo Replacement Token',
      decimals: 18,
      supplyCap: '1000000000000000000000000',
    },
  });
  expectStatus(assetResponse, 202, 'create asset');
  const asset = assetResponse.json<{ id: string; provisioningOperationId: string }>();
  await awaitOperation(asset.provisioningOperationId, 'asset deployment');

  const assetView = await call({ method: 'GET', url: `/v1/assets/${asset.id}`, as: 'dev-issuer' });
  const contractAddress = assetView.json<{ contractAddress: string }>()
    .contractAddress as `0x${string}`;
  step(`contract deployed        ${contractAddress}`);

  const recipient = `0x${randomBytes(20).toString('hex')}` as `0x${string}`;
  const walletResponse = await call({
    method: 'POST',
    url: '/v1/wallets',
    as: 'dev-issuer',
    payload: { address: recipient, investorReference: `investor-${suffix}` },
  });
  expectStatus(walletResponse, 201, 'register wallet');
  const wallet = walletResponse.json<{ id: string }>();

  const approval = await call({
    method: 'POST',
    url: `/v1/wallets/${wallet.id}/compliance-decisions`,
    as: 'dev-compliance',
    payload: { assetId: asset.id },
  });
  expectStatus(approval, 202, 'compliance decision');
  await awaitOperation(
    approval.json<{ eligibilityOperationId: string }>().eligibilityOperationId,
    'eligibility sync',
  );

  const mintResponse = await call({
    method: 'POST',
    url: `/v1/assets/${asset.id}/mints`,
    as: 'dev-issuer',
    headers: { 'idempotency-key': `demo-${randomUUID()}` },
    payload: { walletId: wallet.id, amount: '1000000000000000000000' },
  });
  expectStatus(mintResponse, 202, 'request mint');
  const mint = mintResponse.json<{ operationId: string; approvalRequestId: string }>();
  chain.loseNext();
  for (const approver of ['dev-approver-1', 'dev-approver-2'] as const) {
    const decision = await call({
      method: 'POST',
      url: `/v1/approval-requests/${mint.approvalRequestId}/decisions`,
      as: approver,
      payload: { decision: 'APPROVE' },
    });
    expectStatus(decision, 200, `approval by ${approver}`);
  }

  const stuck = await awaitOperationState(mint.operationId, 'BROADCAST_UNKNOWN', 'mint broadcast');
  const first = stuck.transactionAttempts[0]!;
  step(`mint state               ${stuck.state} (broadcast response lost)`);
  step(
    `attempt 1                nonce=${first.nonce} maxFeePerGas=${first.maxFeePerGas} hash=${first.transactionHash}`,
  );

  step(`waiting ${STUCK_AFTER_MS}ms for the attempt to become replacement-eligible`);
  await sleep(STUCK_AFTER_MS + 500);
  const replaced = await container.replacement.replaceStuckTransactions();
  step(`replacements issued      ${replaced}`);

  const settled = await awaitOperation(mint.operationId, 'mint');
  console.log('\nAttempt history');
  for (const attempt of settled.transactionAttempts) {
    const link =
      attempt.replacesAttemptId === null
        ? attempt.replacedByAttemptId === null
          ? ''
          : ` replaced by ${attempt.replacedByAttemptId.slice(0, 8)} (${attempt.replacementReason})`
        : ` replaces ${attempt.replacesAttemptId.slice(0, 8)}`;
    console.log(
      `  ${attempt.status.padEnd(9)} nonce=${attempt.nonce} maxFeePerGas=${attempt.maxFeePerGas} hash=${attempt.transactionHash}${link}`,
    );
  }

  const balance = await container.gateway.readBalanceOf(contractAddress, recipient);
  console.log('\nResult');
  console.log(`  operation:         ${settled.state} on ${settled.transactionHash}`);
  console.log(`  recipient balance: ${balance} (minted once)\n`);
} finally {
  await demo.close();
}
