-- Signing evidence.
--
-- One row per transaction attempt, so a worker that restarts while a signature is
-- outstanding resumes the request the provider already has instead of creating a second
-- signing intent for the same money. Key material and signed bytes are not stored here:
-- transaction_attempts owns the bytes.

CREATE TABLE signer_requests (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_attempt_id  uuid NOT NULL UNIQUE REFERENCES transaction_attempts (id),
  operation_id            uuid REFERENCES operations (id),
  provider                text NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  provider_request_id     text NOT NULL CHECK (length(provider_request_id) BETWEEN 1 AND 128),
  status                  text NOT NULL CHECK (status IN ('PENDING', 'SIGNED', 'REJECTED', 'EXPIRED')),
  request_fingerprint     text NOT NULL,
  requested_at            timestamptz NOT NULL DEFAULT now(),
  last_checked_at         timestamptz,
  signed_at               timestamptz,
  rejected_at             timestamptz,
  rejection_code          text,
  CONSTRAINT signer_requests_provider_request_key UNIQUE (provider, provider_request_id)
);

CREATE INDEX signer_requests_pending_idx
  ON signer_requests (requested_at)
  WHERE status = 'PENDING';

-- Compliance lifecycle.
--
-- Expiry is already expressed by valid_until; revocation and the sweep that retires a
-- lapsed approval need their own evidence.

ALTER TABLE compliance_decisions DROP CONSTRAINT compliance_decisions_status_check;
ALTER TABLE compliance_decisions
  ADD CONSTRAINT compliance_decisions_status_check
  CHECK (status IN ('APPROVED', 'REJECTED', 'REVOKED', 'EXPIRED'));

ALTER TABLE compliance_decisions ADD COLUMN revoked_at timestamptz;
ALTER TABLE compliance_decisions ADD COLUMN revocation_reason text;

ALTER TABLE compliance_decisions
  ADD CONSTRAINT compliance_decisions_revocation_shape
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL));

CREATE INDEX compliance_decisions_expiry_idx
  ON compliance_decisions (valid_until)
  WHERE status = 'APPROVED' AND superseded_at IS NULL;
