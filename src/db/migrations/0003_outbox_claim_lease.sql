-- A claim must be durable, not just a row lock: FOR UPDATE SKIP LOCKED only holds until
-- commit, and the dispatcher commits before publishing to Redis.

ALTER TABLE outbox DROP CONSTRAINT outbox_status_check;
ALTER TABLE outbox
  ADD CONSTRAINT outbox_status_check
  CHECK (status IN ('PENDING', 'CLAIMED', 'DISPATCHED', 'FAILED'));

ALTER TABLE outbox ADD COLUMN claim_token uuid;
ALTER TABLE outbox ADD COLUMN claim_expires_at timestamptz;

ALTER TABLE outbox
  ADD CONSTRAINT outbox_claim_shape
  CHECK (
    (status = 'CLAIMED') = (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
  );

CREATE INDEX outbox_expired_claim_idx ON outbox (claim_expires_at) WHERE status = 'CLAIMED';
