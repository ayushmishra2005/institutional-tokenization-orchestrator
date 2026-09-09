-- Fee replacement, nonce-lane recovery and canonical chain observations.

ALTER TABLE transaction_attempts DROP CONSTRAINT transaction_attempts_purpose_check;
ALTER TABLE transaction_attempts
  ADD CONSTRAINT transaction_attempts_purpose_check
  CHECK (purpose IN ('DEPLOY_TOKEN', 'SET_ELIGIBILITY', 'MINT', 'NONCE_RECOVERY'));

ALTER TABLE transaction_attempts DROP CONSTRAINT transaction_attempts_status_check;
ALTER TABLE transaction_attempts
  ADD CONSTRAINT transaction_attempts_status_check
  CHECK (status IN (
    'PREPARED', 'SIGNED', 'BROADCASTING', 'BROADCAST_UNKNOWN',
    'SUBMITTED', 'INCLUDED', 'CONFIRMED', 'REVERTED', 'FAILED', 'REPLACED'));

-- Identifies the authorised financial intent independently of nonce and fee fields, so a
-- replacement can be proven to carry the same intent as the attempt it supersedes.
ALTER TABLE transaction_attempts
  ADD COLUMN intent_fingerprint text
  CHECK (intent_fingerprint IS NULL OR intent_fingerprint ~ '^[0-9a-f]{64}$');

ALTER TABLE transaction_attempts
  ADD COLUMN replaces_attempt_id uuid REFERENCES transaction_attempts (id),
  ADD COLUMN replaced_by_attempt_id uuid REFERENCES transaction_attempts (id),
  ADD COLUMN replacement_reason text CHECK (replacement_reason IS NULL OR length(replacement_reason) <= 128),
  ADD COLUMN replacement_number integer NOT NULL DEFAULT 0 CHECK (replacement_number >= 0);

ALTER TABLE transaction_attempts
  ADD CONSTRAINT transaction_attempts_replacement_shape
  CHECK ((replaces_attempt_id IS NULL) = (replacement_number = 0));

ALTER TABLE transaction_attempts
  ADD CONSTRAINT transaction_attempts_no_self_replacement
  CHECK (replaces_attempt_id IS DISTINCT FROM id AND replaced_by_attempt_id IS DISTINCT FROM id);

-- A replacement deliberately reuses the nonce of the attempt it supersedes, so the lane
-- constraint now protects the property that actually matters: at most one attempt per
-- nonce may still be live, every earlier one having been retired first.
ALTER TABLE transaction_attempts DROP CONSTRAINT transaction_attempts_nonce_lane_key;

CREATE UNIQUE INDEX transaction_attempts_live_nonce_key
  ON transaction_attempts (chain_id, from_address, nonce)
  WHERE status <> 'REPLACED';

CREATE UNIQUE INDEX transaction_attempts_replaced_by_key
  ON transaction_attempts (replaced_by_attempt_id)
  WHERE replaced_by_attempt_id IS NOT NULL;

CREATE INDEX transaction_attempts_stuck_idx
  ON transaction_attempts (updated_at)
  WHERE status IN ('SUBMITTED', 'BROADCASTING', 'BROADCAST_UNKNOWN');

-- Observation kinds used by the finality and reorg checks.
ALTER TABLE chain_observations DROP CONSTRAINT chain_observations_kind_check;
ALTER TABLE chain_observations
  ADD CONSTRAINT chain_observations_kind_check
  CHECK (kind IN (
    'RECEIPT', 'MINT_EVENT', 'REFERENCE_CONSUMED', 'RECIPIENT_BALANCE', 'TOTAL_SUPPLY',
    'CHAIN_IDENTITY', 'CONTRACT_CODE', 'TOKEN_METADATA', 'ELIGIBILITY_WINDOW',
    'BLOCK_CANONICALITY', 'FINALITY'));

-- An orphaned observation is marked, never deleted: it is evidence of what the chain
-- claimed at the time it was read.
ALTER TABLE chain_observations
  ADD COLUMN block_hash evm_hash32,
  ADD COLUMN canonical boolean NOT NULL DEFAULT true;

CREATE INDEX chain_observations_attempt_idx
  ON chain_observations (transaction_attempt_id, observed_at);
