-- A worker may disappear after claiming a live-source operation. Bound each claim with a lease so
-- the recovery loop can terminally account for an unknown upstream outcome and advance its run.

ALTER TABLE ops.discovery_operations
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_until timestamptz,
  ADD CONSTRAINT discovery_operations_lease_pair_check
    CHECK ((lease_token IS NULL) = (lease_until IS NULL));

CREATE INDEX discovery_operations_expired_lease_idx
  ON ops.discovery_operations (lease_until, state)
  WHERE state IN ('running', 'cancel_requested');
