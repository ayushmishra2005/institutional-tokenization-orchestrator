import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, seedAssetAndWallet, type SeededAsset, type TestHarness } from './helpers.js';
import { operations } from '../../src/db/schema/index.js';
import { eq } from 'drizzle-orm';

describe('idempotent mint requests', () => {
  let harness: TestHarness;
  let seed: SeededAsset;

  beforeAll(async () => {
    harness = await createHarness();
    seed = await seedAssetAndWallet(harness);
  });

  afterAll(async () => {
    await harness.close();
  });

  const post = (key: string, payload: Record<string, unknown>) =>
    harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${seed.assetId}/mints`,
      headers: { ...harness.auth('dev-issuer'), 'idempotency-key': key },
      payload,
    });

  it('requires an Idempotency-Key header', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${seed.assetId}/mints`,
      headers: harness.auth('dev-issuer'),
      payload: { walletId: seed.walletId, amount: '1000' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'IDEMPOTENCY_KEY_REQUIRED',
    );
  });

  it('returns the same logical result for the same key and same request', async () => {
    const key = `key-${randomUUID()}`;
    const payload = { walletId: seed.walletId, amount: '1000000000000000000' };

    const first = await post(key, payload);
    const second = await post(key, payload);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json<{ operationId: string }>().operationId).toBe(
      first.json<{ operationId: string }>().operationId,
    );

    // Exactly one operation exists for that intent.
    const rows = await harness.container.db
      .select()
      .from(operations)
      .where(eq(operations.id, first.json<{ operationId: string }>().operationId));
    expect(rows).toHaveLength(1);
  });

  it('returns a deterministic conflict for the same key with a different request', async () => {
    const key = `key-${randomUUID()}`;
    await post(key, { walletId: seed.walletId, amount: '1000000000000000000' });
    const conflicting = await post(key, { walletId: seed.walletId, amount: '2000000000000000000' });

    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json<{ error: { code: string } }>().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('creates exactly one operation for concurrent duplicate requests', async () => {
    const key = `key-${randomUUID()}`;
    const payload = { walletId: seed.walletId, amount: '3000000000000000000' };

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => post(key, payload)),
    );

    const accepted = responses.filter((response) => response.statusCode === 202);
    const inProgress = responses.filter((response) => response.statusCode === 409);

    // Every response is either the winner's result or a deterministic in-progress
    // conflict; no request silently creates a second operation.
    expect(accepted.length + inProgress.length).toBe(responses.length);
    expect(accepted.length).toBeGreaterThanOrEqual(1);

    const operationIds = new Set(
      accepted.map((response) => response.json<{ operationId: string }>().operationId),
    );
    expect(operationIds.size).toBe(1);

    for (const response of inProgress) {
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        'IDEMPOTENCY_IN_PROGRESS',
      );
    }
  });

  it('scopes keys per actor so two actors cannot collide', async () => {
    const key = `shared-${randomUUID()}`;
    const payload = { walletId: seed.walletId, amount: '5000000000000000000' };

    const issuer = await post(key, payload);
    const admin = await harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${seed.assetId}/mints`,
      headers: { ...harness.auth('dev-admin'), 'idempotency-key': key },
      payload,
    });

    expect(issuer.statusCode).toBe(202);
    expect(admin.statusCode).toBe(202);
    expect(admin.json<{ operationId: string }>().operationId).not.toBe(
      issuer.json<{ operationId: string }>().operationId,
    );
  });

  it('does not consume the key when the request is rejected', async () => {
    const key = `key-${randomUUID()}`;
    const rejected = await post(key, { walletId: seed.walletId, amount: '0' });
    expect(rejected.statusCode).toBe(400);

    // The same key may be retried once the caller fixes the payload.
    const retried = await post(key, { walletId: seed.walletId, amount: '7000000000000000000' });
    expect(retried.statusCode).toBe(202);
  });
});
