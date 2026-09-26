ALTER TABLE ops.intake_sources
  ADD COLUMN IF NOT EXISTS resolved_provider_id uuid REFERENCES catalog.providers(id),
  ADD COLUMN IF NOT EXISTS curated_at timestamptz;

CREATE INDEX IF NOT EXISTS intake_sources_resolved_provider_idx
  ON ops.intake_sources (resolved_provider_id)
  WHERE resolved_provider_id IS NOT NULL;
