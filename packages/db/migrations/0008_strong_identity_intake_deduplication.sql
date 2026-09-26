-- Strong identities are normalized independently from display/source URL
-- casing. Enforce one intake per workspace identity so concurrent variants
-- collapse at the database boundary as well as in repository preflight checks.

CREATE UNIQUE INDEX IF NOT EXISTS intakes_workspace_strong_identity_unique
  ON ops.intakes (workspace_id, strong_identity_scheme, strong_identity_value)
  WHERE strong_identity_scheme IS NOT NULL AND strong_identity_value IS NOT NULL;
