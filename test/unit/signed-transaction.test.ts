import { describe, expect, it } from 'vitest';
import { keccak256, parseTransaction, serializeTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LocalSignerProvider } from '../../src/adapters/signer/local-signer-provider.js';
import { verifySignedTransaction } from '../../src/adapters/evm/signed-transaction-verifier.js';
import type {
  SigningPolicyContext,
  UnsignedTransactionRequest,
} from '../../src/ports/signer-provider.js';
import { AppError, ErrorCode } from '../../src/domain/errors.js';

// Anvil's first well-known development account. Controls nothing of value.
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as const;
const OTHER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const CHAIN_ID = 31337;

const account = privateKeyToAccount(PRIVATE_KEY);

function makeSigner(): LocalSignerProvider {
  return new LocalSignerProvider({
    privateKey: PRIVATE_KEY,
    expectedAddress: ADDRESS,
    chainId: CHAIN_ID,
  });
}

function makeRequest(
  overrides: Partial<UnsignedTransactionRequest> = {},
): UnsignedTransactionRequest {
  return {
    attemptId: '11111111-1111-1111-1111-111111111111',
    chainId: CHAIN_ID,
    from: ADDRESS,
    to: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
    nonce: 7,
    value: 0n,
    data: '0xdeadbeef',
    gasLimit: 120_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    ...overrides,
  };
}

const context: SigningPolicyContext = {
  purpose: 'MINT',
  correlationId: 'corr-1',
  evidence: {},
};

async function expectMismatch(promise: Promise<unknown>, field: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe(ErrorCode.SIGNED_TRANSACTION_MISMATCH);
    expect(appError.details['field']).toBe(field);
    return true;
  });
}

describe('local signer provider', () => {
  it('refuses to construct when the key does not match the configured address', () => {
    expect(
      () =>
        new LocalSignerProvider({
          privateKey: PRIVATE_KEY,
          expectedAddress: '0x0000000000000000000000000000000000000001',
          chainId: CHAIN_ID,
        }),
    ).toThrow(/does not correspond/);
  });

  it('signs a well-formed request', async () => {
    const result = await makeSigner().sign(makeRequest(), context);
    expect(result.kind).toBe('SIGNED');
  });

  it('rejects a request for another chain', async () => {
    const result = await makeSigner().sign(makeRequest({ chainId: 1 }), context);
    expect(result).toMatchObject({ kind: 'REJECTED', code: 'CHAIN_ID_NOT_PERMITTED' });
  });

  it('rejects a request for an address it does not hold', async () => {
    const result = await makeSigner().sign(
      makeRequest({ from: '0x0000000000000000000000000000000000000009' }),
      context,
    );
    expect(result).toMatchObject({ kind: 'REJECTED', code: 'SIGNER_ADDRESS_MISMATCH' });
  });

  it('never authorises a native value transfer', async () => {
    const result = await makeSigner().sign(makeRequest({ value: 1n }), context);
    expect(result).toMatchObject({ kind: 'REJECTED', code: 'VALUE_TRANSFER_NOT_PERMITTED' });
  });

  it('only permits contract creation for token deployment', async () => {
    const result = await makeSigner().sign(makeRequest({ to: null }), context);
    expect(result).toMatchObject({ kind: 'REJECTED', code: 'CONTRACT_CREATION_NOT_PERMITTED' });

    const deploy = await makeSigner().sign(makeRequest({ to: null }), {
      ...context,
      purpose: 'DEPLOY_TOKEN',
    });
    expect(deploy.kind).toBe('SIGNED');
  });
});

describe('signed transaction verification', () => {
  it('accepts bytes that match the committed request exactly', async () => {
    const request = makeRequest();
    const signed = await makeSigner().sign(request, context);
    if (signed.kind !== 'SIGNED') expect.unreachable('signer should have signed');

    const verified = await verifySignedTransaction(
      signed.signedTransaction,
      request,
      ADDRESS,
      signed.transactionHash,
    );
    expect(verified.recoveredSigner.toLowerCase()).toBe(ADDRESS);
    expect(verified.transactionHash).toBe(keccak256(signed.signedTransaction));
  });

  it('rejects a transaction signed by the wrong signer', async () => {
    const request = makeRequest();
    const rogue = new LocalSignerProvider({
      privateKey: OTHER_PRIVATE_KEY,
      expectedAddress: privateKeyToAccount(OTHER_PRIVATE_KEY).address.toLowerCase() as `0x${string}`,
      chainId: CHAIN_ID,
    });
    const signed = await rogue.sign(
      { ...request, from: privateKeyToAccount(OTHER_PRIVATE_KEY).address },
      context,
    );
    if (signed.kind !== 'SIGNED') expect.unreachable('signer should have signed');

    // The application expects its own signer, so bytes from any other key are refused.
    await expectMismatch(
      verifySignedTransaction(signed.signedTransaction, request, ADDRESS, signed.transactionHash),
      'signer',
    );
  });

  it('rejects mutated calldata', async () => {
    const request = makeRequest();
    const tampered = await signRaw({ ...request, data: '0xdeadbeee' });
    await expectMismatch(
      verifySignedTransaction(tampered.signed, request, ADDRESS, tampered.hash),
      'data',
    );
  });

  it('rejects a substituted recipient contract', async () => {
    const request = makeRequest();
    const tampered = await signRaw({
      ...request,
      to: '0x000000000000000000000000000000000000dead',
    });
    await expectMismatch(
      verifySignedTransaction(tampered.signed, request, ADDRESS, tampered.hash),
      'to',
    );
  });

  it('rejects the wrong chain id', async () => {
    const request = makeRequest();
    const tampered = await signRaw({ ...request, chainId: 1 });
    await expectMismatch(
      verifySignedTransaction(tampered.signed, request, ADDRESS, tampered.hash),
      'chainId',
    );
  });

  it('rejects the wrong nonce', async () => {
    const request = makeRequest();
    const tampered = await signRaw({ ...request, nonce: 99 });
    await expectMismatch(
      verifySignedTransaction(tampered.signed, request, ADDRESS, tampered.hash),
      'nonce',
    );
  });

  it('rejects an injected native value', async () => {
    const request = makeRequest();
    const tampered = await signRaw({ ...request, value: 10n });
    await expectMismatch(
      verifySignedTransaction(tampered.signed, request, ADDRESS, tampered.hash),
      'value',
    );
  });

  it('rejects altered gas and fee fields', async () => {
    const request = makeRequest();
    await expectMismatch(
      verifySignedTransaction(
        (await signRaw({ ...request, gasLimit: 21_000n })).signed,
        request,
        ADDRESS,
        (await signRaw({ ...request, gasLimit: 21_000n })).hash,
      ),
      'gas',
    );

    const fee = await signRaw({ ...request, maxFeePerGas: 99_000_000_000n });
    await expectMismatch(
      verifySignedTransaction(fee.signed, request, ADDRESS, fee.hash),
      'maxFeePerGas',
    );
  });

  it('rejects a transaction hash the signer misreported', async () => {
    const request = makeRequest();
    const signed = await makeSigner().sign(request, context);
    if (signed.kind !== 'SIGNED') expect.unreachable('signer should have signed');

    await expectMismatch(
      verifySignedTransaction(
        signed.signedTransaction,
        request,
        ADDRESS,
        `0x${'11'.repeat(32)}` as `0x${string}`,
      ),
      'transactionHash',
    );
  });

  it('rejects a non-EIP-1559 envelope', async () => {
    const request = makeRequest();
    const legacy = serializeTransaction({
      type: 'legacy',
      chainId: CHAIN_ID,
      nonce: request.nonce,
      gas: request.gasLimit,
      gasPrice: request.maxFeePerGas,
      value: 0n,
      data: request.data,
      to: request.to ?? undefined,
    });
    await expectMismatch(
      verifySignedTransaction(legacy, request, ADDRESS, keccak256(legacy)),
      'envelope',
    );
  });

  it('rejects bytes that are not a transaction at all', async () => {
    const request = makeRequest();
    await expect(
      verifySignedTransaction('0x02aabbcc', request, ADDRESS, keccak256('0x02aabbcc')),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('round-trips through parseTransaction with identical fields', async () => {
    const request = makeRequest();
    const signed = await makeSigner().sign(request, context);
    if (signed.kind !== 'SIGNED') expect.unreachable('signer should have signed');

    const parsed = parseTransaction(signed.signedTransaction as `0x02${string}`);
    expect(parsed.nonce).toBe(request.nonce);
    expect(parsed.chainId).toBe(request.chainId);
    expect(parsed.to?.toLowerCase()).toBe(request.to?.toLowerCase());
    expect(parsed.data).toBe(request.data);
  });
});

/** Signs an arbitrary transaction shape directly, bypassing the provider's policy. */
async function signRaw(
  request: UnsignedTransactionRequest,
): Promise<{ signed: `0x${string}`; hash: `0x${string}` }> {
  const signed = await account.signTransaction({
    type: 'eip1559',
    chainId: request.chainId,
    nonce: request.nonce,
    gas: request.gasLimit,
    maxFeePerGas: request.maxFeePerGas,
    maxPriorityFeePerGas: request.maxPriorityFeePerGas,
    value: request.value,
    data: request.data,
    ...(request.to === null ? {} : { to: request.to }),
  });
  return { signed, hash: keccak256(signed) };
}
