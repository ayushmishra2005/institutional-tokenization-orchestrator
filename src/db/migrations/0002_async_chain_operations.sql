-- Contract deployment and eligibility synchronisation become operations, so every chain
-- write goes through the same durable outbox/worker/reconciliation path as a mint and no
-- HTTP request blocks on block confirmation.

ALTER TABLE operations DROP CONSTRAINT operations_type_check;
ALTER TABLE operations ADD CONSTRAINT operations_type_check
  CHECK (type IN ('MINT', 'DEPLOY_ASSET', 'SYNC_ELIGIBILITY'));

-- Only a mint has a recipient, an amount and a single-use on-chain reference.
ALTER TABLE operations ALTER COLUMN wallet_id DROP NOT NULL;
ALTER TABLE operations ALTER COLUMN amount DROP NOT NULL;
ALTER TABLE operations ALTER COLUMN operation_reference DROP NOT NULL;

-- Administrative operations carry no approval threshold.
ALTER TABLE operations DROP CONSTRAINT operations_required_approvals_check;
ALTER TABLE operations ADD CONSTRAINT operations_required_approvals_check
  CHECK (required_approvals >= 0);

ALTER TABLE operations
  ADD COLUMN compliance_decision_id uuid REFERENCES compliance_decisions (id);

-- Each type has exactly one legal shape. Enforced here so a service bug cannot create,
-- say, a mint with no amount or a deployment that looks approvable.
ALTER TABLE operations ADD CONSTRAINT operations_type_shape CHECK (
  CASE type
    WHEN 'MINT' THEN
      wallet_id IS NOT NULL AND amount IS NOT NULL AND amount > 0
      AND operation_reference IS NOT NULL AND required_approvals > 0
      AND compliance_decision_id IS NULL
    WHEN 'DEPLOY_ASSET' THEN
      wallet_id IS NULL AND amount IS NULL AND operation_reference IS NULL
      AND required_approvals = 0 AND compliance_decision_id IS NULL
    WHEN 'SYNC_ELIGIBILITY' THEN
      wallet_id IS NOT NULL AND amount IS NULL AND operation_reference IS NULL
      AND required_approvals = 0 AND compliance_decision_id IS NOT NULL
    ELSE false
  END
);

-- One live provisioning operation per asset, and one live eligibility sync per
-- wallet+asset, so a retried request cannot queue a second competing chain write.
CREATE UNIQUE INDEX operations_one_live_deployment_per_asset
  ON operations (asset_id)
  WHERE type = 'DEPLOY_ASSET'
    AND state NOT IN ('SUCCEEDED', 'REVERTED', 'FAILED', 'CANCELLED');

CREATE UNIQUE INDEX operations_one_live_eligibility_sync
  ON operations (asset_id, wallet_id)
  WHERE type = 'SYNC_ELIGIBILITY'
    AND state NOT IN ('SUCCEEDED', 'REVERTED', 'FAILED', 'CANCELLED');

CREATE INDEX operations_recovery_idx
  ON operations (state, state_updated_at)
  WHERE state NOT IN ('PENDING_APPROVAL', 'SUCCEEDED', 'REVERTED', 'FAILED', 'CANCELLED');

-- Durable state timeline.
--
-- Written in the same transaction as the state change it describes, so the history
-- exposed by the API is recorded evidence rather than something inferred from the
-- operation's current state.
CREATE TABLE operation_transitions (
  id            bigserial PRIMARY KEY,
  operation_id  uuid NOT NULL REFERENCES operations (id),
  from_state    text,
  to_state      text NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX operation_transitions_operation_idx
  ON operation_transitions (operation_id, id);

CREATE TRIGGER operation_transitions_no_update
  BEFORE UPDATE OR DELETE ON operation_transitions
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

-- Backfill the states already reached, so existing operations still report a timeline.
INSERT INTO operation_transitions (operation_id, from_state, to_state, occurred_at)
  SELECT id, NULL, state, state_updated_at FROM operations;

-- Reconciliation findings.
--
-- A row with matched = false is a finding: observed chain state contradicted PostgreSQL.
-- Severity distinguishes "the evidence disagrees, money may be wrong" from "the evidence
-- is merely incomplete", because the first must never be resolved by marking the
-- operation SUCCEEDED and the second must never be resolved by marking it FAILED.
ALTER TABLE chain_observations DROP CONSTRAINT chain_observations_kind_check;
ALTER TABLE chain_observations ADD CONSTRAINT chain_observations_kind_check
  CHECK (kind IN (
    'RECEIPT', 'MINT_EVENT', 'REFERENCE_CONSUMED', 'RECIPIENT_BALANCE', 'TOTAL_SUPPLY',
    'CHAIN_IDENTITY', 'CONTRACT_CODE', 'TOKEN_METADATA', 'ELIGIBILITY_WINDOW'));

ALTER TABLE chain_observations
  ADD COLUMN severity text NOT NULL DEFAULT 'INFO'
    CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  ADD COLUMN status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'RESOLVED')),
  ADD COLUMN resolved_at timestamptz;

ALTER TABLE chain_observations ADD CONSTRAINT chain_observations_resolved_pair
  CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL));

-- A matched observation is evidence, not a finding, so it is never open.
ALTER TABLE chain_observations ADD CONSTRAINT chain_observations_matched_is_not_open
  CHECK (NOT matched OR (severity = 'INFO' AND status = 'RESOLVED'));

UPDATE chain_observations
  SET severity = CASE WHEN matched THEN 'INFO' ELSE 'CRITICAL' END,
      status = CASE WHEN matched THEN 'RESOLVED' ELSE 'OPEN' END,
      resolved_at = CASE WHEN matched THEN observed_at ELSE NULL END;

CREATE INDEX chain_observations_open_findings_idx
  ON chain_observations (severity, observed_at DESC)
  WHERE status = 'OPEN';
