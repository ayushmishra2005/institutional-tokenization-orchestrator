-- Phase 1 schema.
--
-- PostgreSQL is the authority for application workflow. Invariants that protect money
-- are expressed as constraints here, not only in TypeScript, so a bug in a service or a
-- concurrent request cannot violate them.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Reusable domains keep address/hash formats consistent across every table.
CREATE DOMAIN evm_address AS text CHECK (VALUE ~ '^0x[0-9a-f]{40}$');
CREATE DOMAIN evm_hash32 AS text CHECK (VALUE ~ '^0x[0-9a-f]{64}$');
-- uint256 in base units. Never floating point.
CREATE DOMAIN uint256 AS numeric(78, 0) CHECK (VALUE >= 0);

-- ---------------------------------------------------------------------------
-- identity and application roles
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_subject  text NOT NULL,
  organization_id   text NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 128),
  display_name      text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_external_subject_key UNIQUE (external_subject)
);

CREATE TABLE user_roles (
  user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role     text NOT NULL CHECK (role IN ('ADMIN', 'ISSUER', 'COMPLIANCE_OFFICER', 'APPROVER', 'AUDITOR')),
  PRIMARY KEY (user_id, role)
);

-- ---------------------------------------------------------------------------
-- assets
-- ---------------------------------------------------------------------------

CREATE TABLE assets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     text NOT NULL,
  symbol              text NOT NULL CHECK (symbol ~ '^[A-Z0-9]{2,12}$'),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  decimals            smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  supply_cap          uint256 NOT NULL CHECK (supply_cap > 0),
  chain_id            integer NOT NULL CHECK (chain_id > 0),
  contract_address    evm_address,
  deployment_tx_hash  evm_hash32,
  status              text NOT NULL CHECK (status IN ('PROVISIONING', 'ACTIVE', 'PAUSED', 'FAILED')),
  -- Bumped whenever configuration that approvals depend on changes; part of the
  -- approval proposal snapshot so old approvals cannot survive a policy change.
  policy_version      integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_org_symbol_key UNIQUE (organization_id, symbol),
  -- An asset may only leave provisioning once its canonical contract is known.
  CONSTRAINT assets_usable_requires_contract
    CHECK (status = 'PROVISIONING' OR status = 'FAILED' OR contract_address IS NOT NULL)
);

-- One asset per deployed contract; prevents two asset rows claiming the same token.
CREATE UNIQUE INDEX assets_chain_contract_key
  ON assets (chain_id, contract_address)
  WHERE contract_address IS NOT NULL;

-- ---------------------------------------------------------------------------
-- wallets
-- ---------------------------------------------------------------------------

CREATE TABLE wallets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     text NOT NULL,
  chain_id            integer NOT NULL CHECK (chain_id > 0),
  address             evm_address NOT NULL,
  label               text CHECK (label IS NULL OR length(label) <= 128),
  -- Opaque investor handle. Deliberately NOT real-world identity data.
  investor_reference  text NOT NULL CHECK (length(investor_reference) BETWEEN 1 AND 128),
  status              text NOT NULL DEFAULT 'REGISTERED'
                        CHECK (status IN ('REGISTERED', 'BLOCKED')),
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallets_chain_address_key UNIQUE (chain_id, address)
);

-- ---------------------------------------------------------------------------
-- compliance
-- ---------------------------------------------------------------------------

CREATE TABLE compliance_decisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id           uuid NOT NULL REFERENCES wallets (id),
  asset_id            uuid REFERENCES assets (id),
  status              text NOT NULL CHECK (status IN ('APPROVED', 'REJECTED', 'REVOKED')),
  subject_reference   text NOT NULL CHECK (length(subject_reference) BETWEEN 1 AND 128),
  provider            text NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  provider_reference  text NOT NULL CHECK (length(provider_reference) BETWEEN 1 AND 128),
  valid_from          timestamptz NOT NULL,
  valid_until         timestamptz NOT NULL,
  decided_at          timestamptz NOT NULL DEFAULT now(),
  decided_by          uuid NOT NULL REFERENCES users (id),
  -- On-chain eligibility mirror. The chain, not this row, gates the actual mint.
  chain_sync_status   text NOT NULL DEFAULT 'PENDING'
                        CHECK (chain_sync_status IN ('PENDING', 'SYNCED', 'FAILED')),
  chain_sync_tx_hash  evm_hash32,
  superseded_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compliance_decisions_validity_window CHECK (valid_until > valid_from),
  CONSTRAINT compliance_decisions_provider_ref_key UNIQUE (provider, provider_reference)
);

-- At most one live APPROVED decision per wallet+asset scope at any time.
CREATE UNIQUE INDEX compliance_decisions_one_active_per_wallet
  ON compliance_decisions (wallet_id, COALESCE(asset_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'APPROVED' AND superseded_at IS NULL;

CREATE INDEX compliance_decisions_wallet_idx ON compliance_decisions (wallet_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- operations
-- ---------------------------------------------------------------------------

CREATE TABLE operations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       text NOT NULL,
  type                  text NOT NULL CHECK (type IN ('MINT')),
  state                 text NOT NULL CHECK (state IN (
                          'PENDING_APPROVAL', 'READY', 'PREPARING', 'SIGNING', 'SIGNED',
                          'BROADCASTING', 'BROADCAST_UNKNOWN', 'SUBMITTED', 'INCLUDED',
                          'SUCCEEDED', 'REVERTED', 'FAILED', 'CANCELLED')),
  asset_id              uuid NOT NULL REFERENCES assets (id),
  wallet_id             uuid NOT NULL REFERENCES wallets (id),
  amount                uint256 NOT NULL CHECK (amount > 0),
  -- Single-use bytes32 handed to the contract. Unique here and consumable once on chain.
  operation_reference   evm_hash32 NOT NULL,
  proposal_hash         text NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  required_approvals    smallint NOT NULL CHECK (required_approvals > 0),
  requested_by          uuid NOT NULL REFERENCES users (id),
  correlation_id        text NOT NULL,
  failure_code          text,
  failure_reason        text,
  -- Worker lease. Only one worker may drive an operation's chain interaction.
  claimed_by            text,
  claimed_at            timestamptz,
  state_updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_reference_key UNIQUE (operation_reference),
  CONSTRAINT operations_claim_consistent
    CHECK ((claimed_by IS NULL) = (claimed_at IS NULL))
);

CREATE INDEX operations_state_idx ON operations (state, state_updated_at);
CREATE INDEX operations_asset_idx ON operations (asset_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- approvals
-- ---------------------------------------------------------------------------

CREATE TABLE approval_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id        uuid NOT NULL REFERENCES operations (id),
  state               text NOT NULL CHECK (state IN ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'CANCELLED')),
  required_approvals  smallint NOT NULL CHECK (required_approvals > 0),
  -- Immutable financial intent the approvers are consenting to.
  proposal_snapshot   jsonb NOT NULL,
  proposal_hash       text NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  requested_by        uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  -- Target for the composite FK below, which is what makes self-approval a
  -- database-enforced rule rather than an application convention.
  CONSTRAINT approval_requests_id_requester_key UNIQUE (id, requested_by)
);

-- An operation can have at most one open approval request at a time.
CREATE UNIQUE INDEX approval_requests_one_open_per_operation
  ON approval_requests (operation_id)
  WHERE state = 'PENDING';

CREATE TABLE approval_decisions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_request_id     uuid NOT NULL REFERENCES approval_requests (id),
  approver_id             uuid NOT NULL REFERENCES users (id),
  -- Denormalised copy of approval_requests.requested_by, kept honest by the composite
  -- foreign key, so the self-approval prohibition can be a plain CHECK.
  operation_requested_by  uuid NOT NULL,
  decision                text NOT NULL CHECK (decision IN ('APPROVE', 'REJECT')),
  -- Recorded so a decision can be proven to apply to one exact financial intent.
  proposal_hash           text NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  comment                 text CHECK (comment IS NULL OR length(comment) <= 1024),
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- Two approvals must come from two different people.
  CONSTRAINT approval_decisions_one_per_approver UNIQUE (approval_request_id, approver_id),
  CONSTRAINT approval_decisions_no_self_approval CHECK (approver_id <> operation_requested_by),
  CONSTRAINT approval_decisions_requester_fk
    FOREIGN KEY (approval_request_id, operation_requested_by)
    REFERENCES approval_requests (id, requested_by)
);

-- ---------------------------------------------------------------------------
-- idempotency
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            text NOT NULL CHECK (length(scope) BETWEEN 1 AND 256),
  organization_id  text NOT NULL,
  actor_id         uuid NOT NULL REFERENCES users (id),
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 255),
  request_hash     text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status           text NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
  response_status  integer CHECK (response_status IS NULL OR (response_status BETWEEN 100 AND 599)),
  response_body    jsonb,
  resource_type    text,
  resource_id      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  -- The key is scoped to endpoint + organization + actor so one tenant's key can never
  -- collide with, or replay, another's.
  CONSTRAINT idempotency_keys_scope_key UNIQUE (scope, organization_id, actor_id, idempotency_key),
  CONSTRAINT idempotency_keys_completed_has_response
    CHECK (status <> 'COMPLETED' OR (response_status IS NOT NULL AND response_body IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic           text NOT NULL CHECK (length(topic) BETWEEN 1 AND 128),
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  -- Identifiers only. Redis is a delivery mechanism, never a source of financial truth.
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DISPATCHED', 'FAILED')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at    timestamptz NOT NULL DEFAULT now(),
  dispatched_at   timestamptz,
  last_error      text,
  correlation_id  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_pending_idx ON outbox (available_at, id) WHERE status = 'PENDING';

-- ---------------------------------------------------------------------------
-- audit
-- ---------------------------------------------------------------------------

CREATE TABLE audit_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_type      text NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM')),
  actor_id        text NOT NULL,
  action          text NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
  resource_type   text NOT NULL,
  resource_id     text NOT NULL,
  operation_id    uuid REFERENCES operations (id),
  correlation_id  text NOT NULL,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_events_occurred_idx ON audit_events (occurred_at DESC, id DESC);
CREATE INDEX audit_events_operation_idx ON audit_events (operation_id, occurred_at);
CREATE INDEX audit_events_resource_idx ON audit_events (resource_type, resource_id, occurred_at DESC);

-- Append-only enforced by the database: application bugs cannot rewrite history.
CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

-- ---------------------------------------------------------------------------
-- signer nonce lane
-- ---------------------------------------------------------------------------

CREATE TABLE signer_nonces (
  chain_id        integer NOT NULL CHECK (chain_id > 0),
  signer_address  evm_address NOT NULL,
  next_nonce      bigint NOT NULL CHECK (next_nonce >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, signer_address)
);

-- ---------------------------------------------------------------------------
-- transaction attempts
-- ---------------------------------------------------------------------------

CREATE TABLE transaction_attempts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id              uuid REFERENCES operations (id),
  asset_id                  uuid REFERENCES assets (id),
  wallet_id                 uuid REFERENCES wallets (id),
  -- Allowlisted intents only. There is no generic "sign arbitrary bytes" path.
  purpose                   text NOT NULL CHECK (purpose IN ('DEPLOY_TOKEN', 'SET_ELIGIBILITY', 'MINT')),
  chain_id                  integer NOT NULL CHECK (chain_id > 0),
  from_address              evm_address NOT NULL,
  to_address                evm_address,
  nonce                     bigint NOT NULL CHECK (nonce >= 0),
  -- This system never transfers native value; enforced rather than assumed.
  value                     uint256 NOT NULL DEFAULT 0 CHECK (value = 0),
  data                      text NOT NULL CHECK (data ~ '^0x[0-9a-f]*$'),
  gas_limit                 bigint NOT NULL CHECK (gas_limit > 0),
  max_fee_per_gas           uint256 NOT NULL,
  max_priority_fee_per_gas  uint256 NOT NULL,
  -- Fingerprint of the exact unsigned request that was committed before signing.
  request_hash              text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  signed_raw_transaction    text CHECK (signed_raw_transaction ~ '^0x[0-9a-f]+$'),
  transaction_hash          evm_hash32,
  status                    text NOT NULL CHECK (status IN (
                              'PREPARED', 'SIGNED', 'BROADCASTING', 'BROADCAST_UNKNOWN',
                              'SUBMITTED', 'INCLUDED', 'CONFIRMED', 'REVERTED', 'FAILED')),
  broadcast_attempts        integer NOT NULL DEFAULT 0 CHECK (broadcast_attempts >= 0),
  block_number              bigint,
  block_hash                evm_hash32,
  gas_used                  bigint,
  receipt_status            smallint CHECK (receipt_status IS NULL OR receipt_status IN (0, 1)),
  contract_address          evm_address,
  error_code                text,
  error_message             text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- Signed bytes and their hash are persisted together, before any broadcast.
  CONSTRAINT transaction_attempts_signed_pair
    CHECK ((signed_raw_transaction IS NULL) = (transaction_hash IS NULL)),
  CONSTRAINT transaction_attempts_broadcast_requires_bytes
    CHECK (status IN ('PREPARED', 'FAILED') OR signed_raw_transaction IS NOT NULL),
  CONSTRAINT transaction_attempts_deploy_has_no_target
    CHECK ((purpose = 'DEPLOY_TOKEN') = (to_address IS NULL)),
  -- One live attempt per nonce in a signer lane: two different signed transactions can
  -- never legitimately share a nonce.
  CONSTRAINT transaction_attempts_nonce_lane_key UNIQUE (chain_id, from_address, nonce)
);

CREATE UNIQUE INDEX transaction_attempts_hash_key
  ON transaction_attempts (transaction_hash)
  WHERE transaction_hash IS NOT NULL;

CREATE INDEX transaction_attempts_operation_idx ON transaction_attempts (operation_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- reconciliation
-- ---------------------------------------------------------------------------

CREATE TABLE chain_observations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id            uuid REFERENCES operations (id),
  transaction_attempt_id  uuid REFERENCES transaction_attempts (id),
  kind                    text NOT NULL CHECK (kind IN (
                            'RECEIPT', 'MINT_EVENT', 'REFERENCE_CONSUMED',
                            'RECIPIENT_BALANCE', 'TOTAL_SUPPLY')),
  chain_id                integer NOT NULL,
  block_number            bigint,
  transaction_hash        evm_hash32,
  -- False rows are reconciliation findings: observed chain state contradicts the
  -- expectation recorded in PostgreSQL.
  matched                 boolean NOT NULL,
  expected                jsonb,
  actual                  jsonb,
  detail                  text,
  observed_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chain_observations_operation_idx ON chain_observations (operation_id, observed_at);
CREATE INDEX chain_observations_findings_idx ON chain_observations (observed_at DESC) WHERE matched = false;
