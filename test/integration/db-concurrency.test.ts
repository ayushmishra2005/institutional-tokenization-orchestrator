import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createHarness, type TestHarness } from './helpers.js';
import { auditEvents, outbox, signerNonces } from '../../src/db/schema/index.js';
import {
  claimPendingOutbox,
  enqueueOutbox,
  markOutboxDispatched,
  rescheduleOutbox,
  OutboxTopic,
} from '../../src/db/repositories/outbox-repository.js';
import { reserveNonce } from '../../src/db/repositories/transaction-repository.js';
import { recordAuditEvent } from '../../src/db/repositories/audit-repository.js';
import { AppError, ErrorCode } from '../../src/domain/errors.js';
import { systemActor } from '../../src/domain/roles.js';

describe('database-level concurrency guarantees', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('outbox claiming', () => {
    it('hands each row to exactly one concurrent claimer', async () => {
      const db = harness.container.db;
      await db.delete(outbox);

      const total = 30;
      for (let index = 0; index < total; index += 1) {
        await enqueueOutbox(db, {
          topic: OutboxTopic.OPERATION_READY,
          aggregateType: 'operation',
          aggregateId: randomUUID(),
          payload: { operationId: randomUUID() },
          correlationId: `corr-${index}`,
        });
      }

      // Six dispatchers drain the same table simultaneously.
      const batches = await Promise.all(
        Array.from({ length: 6 }, () =>
          db.transaction((tx) => claimPendingOutbox(tx, { limit: 10 })),
        ),
      );

      const claimedIds = batches.flatMap((batch) => batch.rows.map((row) => row.id));
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      expect(claimedIds.length).toBe(total);

      // A dispatcher arriving after those transactions committed must still see nothing:
      // the claim outlives the row lock.
      const late = await db.transaction((tx) => claimPendingOutbox(tx, { limit: total }));
      expect(late.rows).toHaveLength(0);

      for (const batch of batches) {
        await markOutboxDispatched(db, {
          ids: batch.rows.map((row) => row.id),
          claimToken: batch.claimToken,
        });
      }
      const remaining = await db
        .select()
        .from(outbox)
        .where(eq(outbox.status, 'PENDING'));
      expect(remaining).toHaveLength(0);
    });

    it('does not claim rows scheduled for the future', async () => {
      const db = harness.container.db;
      await db.delete(outbox);

      const row = await enqueueOutbox(db, {
        topic: OutboxTopic.OPERATION_READY,
        aggregateType: 'operation',
        aggregateId: randomUUID(),
        payload: { operationId: randomUUID() },
        correlationId: 'future',
      });
      await db
        .update(outbox)
        .set({ availableAt: new Date(Date.now() + 60_000) })
        .where(eq(outbox.id, row.id));

      const claimed = await db.transaction((tx) => claimPendingOutbox(tx, { limit: 10 }));
      expect(claimed.rows).toHaveLength(0);
    });

    it('claims rows against the database clock even when the application clock lags', async () => {
      const db = harness.container.db;
      await db.delete(outbox);

      const row = await enqueueOutbox(db, {
        topic: OutboxTopic.OPERATION_READY,
        aggregateType: 'operation',
        aggregateId: randomUUID(),
        payload: { operationId: randomUUID() },
        correlationId: 'clock-skew',
      });
      await db
        .update(outbox)
        .set({ availableAt: sql`now()` })
        .where(eq(outbox.id, row.id));

      // Old failure mode: an application clock behind PostgreSQL never sees the row as due.
      const laggingAppClock = new Date(Date.now() - 10 * 60_000);
      const starved = await db.transaction((tx) =>
        claimPendingOutbox(tx, { limit: 10, now: laggingAppClock }),
      );
      expect(starved.rows).toHaveLength(0);

      const claimed = await db.transaction((tx) => claimPendingOutbox(tx, { limit: 10 }));
      expect(claimed.rows.map((entry) => entry.id)).toEqual([row.id]);
    });

    it('schedules retry backoff from database time', async () => {
      const db = harness.container.db;
      await db.delete(outbox);
      const row = await enqueueOutbox(db, {
        topic: OutboxTopic.OPERATION_READY,
        aggregateType: 'operation',
        aggregateId: randomUUID(),
        payload: { operationId: randomUUID() },
        correlationId: 'backoff',
      });

      const { claimToken } = await db.transaction((tx) => claimPendingOutbox(tx, { limit: 1 }));
      await rescheduleOutbox(db, {
        id: row.id,
        claimToken,
        error: 'redis down',
        retryAfterMs: 30_000,
      });

      const [after] = await db
        .select({
          secondsFromDbNow: sql<number>`extract(epoch from (${outbox.availableAt} - now()))`,
        })
        .from(outbox)
        .where(eq(outbox.id, row.id));
      expect(Number(after!.secondsFromDbNow)).toBeGreaterThan(25);
      expect(Number(after!.secondsFromDbNow)).toBeLessThanOrEqual(30);
    });

    it('reclaims a row whose lease expired and counts the attempt', async () => {
      const db = harness.container.db;
      await db.delete(outbox);
      const row = await enqueueOutbox(db, {
        topic: OutboxTopic.OPERATION_READY,
        aggregateType: 'operation',
        aggregateId: randomUUID(),
        payload: { operationId: randomUUID() },
        correlationId: 'retry',
      });

      const abandoned = await db.transaction((tx) =>
        claimPendingOutbox(tx, { limit: 10, leaseMs: 0 }),
      );
      const reclaimed = await db.transaction((tx) => claimPendingOutbox(tx, { limit: 10 }));
      expect(reclaimed.rows.map((entry) => entry.id)).toEqual([row.id]);

      // The first dispatcher lost the row when its lease lapsed and can no longer close it.
      await markOutboxDispatched(db, { ids: [row.id], claimToken: abandoned.claimToken });

      const [after] = await db.select().from(outbox).where(eq(outbox.id, row.id));
      expect(after!.status).toBe('CLAIMED');
      expect(after!.claimToken).toBe(reclaimed.claimToken);
      expect(after!.attempts).toBe(2);
    });

    it('does not hand a live claim to a second dispatcher', async () => {
      const db = harness.container.db;
      await db.delete(outbox);
      const row = await enqueueOutbox(db, {
        topic: OutboxTopic.OPERATION_READY,
        aggregateType: 'operation',
        aggregateId: randomUUID(),
        payload: { operationId: randomUUID() },
        correlationId: 'lease',
      });

      const first = await db.transaction((tx) => claimPendingOutbox(tx, { limit: 10 }));
      expect(first.rows.map((entry) => entry.id)).toEqual([row.id]);

      const second = await db.transaction((tx) => claimPendingOutbox(tx, { limit: 10 }));
      expect(second.rows).toHaveLength(0);

      await db
        .update(outbox)
        .set({ claimExpiresAt: sql`now() - interval '1 second'` })
        .where(eq(outbox.id, row.id));

      const afterExpiry = await db.transaction((tx) => claimPendingOutbox(tx, { limit: 10 }));
      expect(afterExpiry.rows.map((entry) => entry.id)).toEqual([row.id]);
    });
  });

  describe('nonce reservation', () => {
    const signer = '0x1111111111111111111111111111111111111111';

    it('issues strictly increasing, unique nonces under concurrency', async () => {
      const db = harness.container.db;
      await db.delete(signerNonces);

      const reservations = await Promise.all(
        Array.from({ length: 25 }, () =>
          db.transaction((tx) =>
            reserveNonce(tx, { chainId: 31337, signerAddress: signer, chainNonce: 0 }),
          ),
        ),
      );

      const sorted = [...reservations].sort((a, b) => a - b);
      expect(new Set(reservations).size).toBe(reservations.length);
      expect(sorted).toEqual(Array.from({ length: 25 }, (_, index) => index));

      const [row] = await db
        .select()
        .from(signerNonces)
        .where(eq(signerNonces.signerAddress, signer));
      expect(row!.nextNonce).toBe(25);
    });

    it('starts from the chain nonce when no lane exists yet', async () => {
      const db = harness.container.db;
      await db.delete(signerNonces);

      const nonce = await db.transaction((tx) =>
        reserveNonce(tx, { chainId: 31337, signerAddress: signer, chainNonce: 17 }),
      );
      expect(nonce).toBe(17);
    });

    it('halts rather than guessing when the chain nonce runs ahead of the lane', async () => {
      const db = harness.container.db;
      await db.delete(signerNonces);
      await db.transaction((tx) =>
        reserveNonce(tx, { chainId: 31337, signerAddress: signer, chainNonce: 0 }),
      );

      // A chain nonce beyond what we ever issued means the key was used elsewhere.
      await expect(
        db.transaction((tx) =>
          reserveNonce(tx, { chainId: 31337, signerAddress: signer, chainNonce: 99 }),
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCode.NONCE_DIVERGENCE);
        return true;
      });
    });

    it('tolerates the chain lagging behind reserved but unmined nonces', async () => {
      const db = harness.container.db;
      await db.delete(signerNonces);
      await db.transaction((tx) =>
        reserveNonce(tx, { chainId: 31337, signerAddress: signer, chainNonce: 5 }),
      );

      // Nonce 5 is reserved but not yet mined, so the chain still reports 5.
      const next = await db.transaction((tx) =>
        reserveNonce(tx, { chainId: 31337, signerAddress: signer, chainNonce: 5 }),
      );
      expect(next).toBe(6);
    });

    it('keeps separate lanes per signer address', async () => {
      const db = harness.container.db;
      await db.delete(signerNonces);
      const other = '0x2222222222222222222222222222222222222222';

      const a = await db.transaction((tx) =>
        reserveNonce(tx, { chainId: 31337, signerAddress: signer, chainNonce: 3 }),
      );
      const b = await db.transaction((tx) =>
        reserveNonce(tx, { chainId: 31337, signerAddress: other, chainNonce: 8 }),
      );
      expect(a).toBe(3);
      expect(b).toBe(8);
    });
  });

  describe('audit append-only enforcement', () => {
    it('refuses updates and deletes at the database level', async () => {
      const db = harness.container.db;
      const id = await recordAuditEvent(db, {
        actor: systemActor('test'),
        action: 'test.event',
        resourceType: 'test',
        resourceId: 'resource-1',
        correlationId: 'corr-1',
        metadata: { original: true },
      });

      await expect(
        db.update(auditEvents).set({ action: 'tampered' }).where(eq(auditEvents.id, id)),
      ).rejects.toThrow(/append-only/);

      await expect(
        db.delete(auditEvents).where(eq(auditEvents.id, id)),
      ).rejects.toThrow(/append-only/);

      const [row] = await db.select().from(auditEvents).where(eq(auditEvents.id, id));
      expect(row!.action).toBe('test.event');
    });

    it('refuses tampering even through raw SQL', async () => {
      const db = harness.container.db;
      await recordAuditEvent(db, {
        actor: systemActor('test'),
        action: 'test.raw',
        resourceType: 'test',
        resourceId: 'resource-2',
        correlationId: 'corr-2',
      });

      await expect(
        db.execute(sql`UPDATE audit_events SET action = 'x' WHERE action = 'test.raw'`),
      ).rejects.toThrow(/append-only/);
    });
  });
});
