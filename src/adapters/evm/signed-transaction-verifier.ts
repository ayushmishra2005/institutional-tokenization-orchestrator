import { keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import type { UnsignedTransactionRequest } from '../../ports/signer-provider.js';
import { AppError, ErrorCode } from '../../domain/errors.js';

export interface VerifiedSignedTransaction {
  readonly transactionHash: `0x${string}`;
  readonly recoveredSigner: `0x${string}`;
}

function mismatch(field: string, expected: unknown, actual: unknown): never {
  throw new AppError(
    ErrorCode.SIGNED_TRANSACTION_MISMATCH,
    `signed transaction does not match the committed signing request (${field})`,
    { details: { field, expected: String(expected), actual: String(actual) } },
  );
}

/**
 * Independently validates bytes returned by a SignerProvider against the exact request
 * that was committed to PostgreSQL before signing.
 *
 * The signer is treated as untrusted: a compromised or buggy adapter must not be able to
 * substitute a different recipient, amount, calldata, chain, nonce or fee. Nothing is
 * broadcast until every field below matches and the recovered signer is the expected one.
 */
export async function verifySignedTransaction(
  signedTransaction: `0x${string}`,
  request: UnsignedTransactionRequest,
  expectedSigner: `0x${string}`,
  claimedHash: `0x${string}`,
): Promise<VerifiedSignedTransaction> {
  // The bytes come from an untrusted signer. This application only ever requests
  // EIP-1559 transactions, so anything without the 0x02 envelope is rejected outright
  // rather than being parsed as some other transaction type.
  if (!signedTransaction.startsWith('0x02')) {
    mismatch('envelope', '0x02 (eip1559)', signedTransaction.slice(0, 4));
  }
  const serialized = signedTransaction as `0x02${string}`;

  let parsed;
  try {
    parsed = parseTransaction(serialized);
  } catch (error) {
    throw new AppError(ErrorCode.SIGNED_TRANSACTION_MISMATCH, 'returned bytes are not a valid transaction', {
      cause: error,
    });
  }

  if (parsed.type !== 'eip1559') mismatch('type', 'eip1559', parsed.type);
  if (parsed.chainId !== request.chainId) mismatch('chainId', request.chainId, parsed.chainId);
  if (parsed.nonce !== request.nonce) mismatch('nonce', request.nonce, parsed.nonce);

  const expectedTo = request.to === null ? null : request.to.toLowerCase();
  const actualTo = parsed.to === undefined || parsed.to === null ? null : parsed.to.toLowerCase();
  if (expectedTo !== actualTo) mismatch('to', expectedTo, actualTo);

  const actualValue = parsed.value ?? 0n;
  if (actualValue !== request.value) mismatch('value', request.value, actualValue);

  const actualData = (parsed.data ?? '0x').toLowerCase();
  if (actualData !== request.data.toLowerCase()) {
    // Calldata is compared in full: a single mutated byte changes the recipient or amount.
    mismatch('data', request.data.toLowerCase(), actualData);
  }

  if (parsed.gas !== request.gasLimit) mismatch('gas', request.gasLimit, parsed.gas);
  if (parsed.maxFeePerGas !== request.maxFeePerGas) {
    mismatch('maxFeePerGas', request.maxFeePerGas, parsed.maxFeePerGas);
  }
  if (parsed.maxPriorityFeePerGas !== request.maxPriorityFeePerGas) {
    mismatch('maxPriorityFeePerGas', request.maxPriorityFeePerGas, parsed.maxPriorityFeePerGas);
  }
  if (parsed.maxPriorityFeePerGas !== undefined && parsed.maxFeePerGas !== undefined) {
    if (parsed.maxPriorityFeePerGas > parsed.maxFeePerGas) {
      mismatch('feePolicy', 'maxPriorityFeePerGas <= maxFeePerGas', 'priority fee exceeds max fee');
    }
  }

  let recovered: `0x${string}`;
  try {
    recovered = await recoverTransactionAddress({ serializedTransaction: serialized });
  } catch (error) {
    throw new AppError(ErrorCode.SIGNED_TRANSACTION_MISMATCH, 'unable to recover signer from signature', {
      cause: error,
    });
  }
  if (recovered.toLowerCase() !== expectedSigner.toLowerCase()) {
    mismatch('signer', expectedSigner.toLowerCase(), recovered.toLowerCase());
  }

  const transactionHash = keccak256(signedTransaction);
  if (transactionHash.toLowerCase() !== claimedHash.toLowerCase()) {
    mismatch('transactionHash', transactionHash, claimedHash);
  }

  return { transactionHash, recoveredSigner: recovered };
}
