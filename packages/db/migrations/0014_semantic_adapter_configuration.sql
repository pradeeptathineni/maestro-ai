-- Configure the optional loopback semantic adapter and bind proposals to operations.

ALTER TABLE ops.source_adapter_configs
  ADD COLUMN IF NOT EXISTS model_identifier text,
  ADD COLUMN IF NOT EXISTS max_input_tokens integer NOT NULL DEFAULT 4096,
  ADD COLUMN IF NOT EXISTS max_output_tokens integer NOT NULL DEFAULT 512;

ALTER TABLE ops.source_adapter_configs
  DROP CONSTRAINT IF EXISTS source_adapter_configs_token_limits_check;
ALTER TABLE ops.source_adapter_configs
  ADD CONSTRAINT source_adapter_configs_token_limits_check CHECK (
    max_input_tokens BETWEEN 256 AND 32768
    AND max_output_tokens BETWEEN 64 AND 4096
  );

ALTER TABLE ops.source_adapter_configs
  DROP CONSTRAINT IF EXISTS source_adapter_configs_local_semantic_configuration_check;
ALTER TABLE ops.source_adapter_configs
  ADD CONSTRAINT source_adapter_configs_local_semantic_configuration_check CHECK (
    adapter_key <> 'local_semantic'
    OR NOT enabled
    OR (
      base_url IS NOT NULL
      AND model_identifier IS NOT NULL
      AND length(btrim(model_identifier)) BETWEEN 1 AND 120
    )
  );

ALTER TABLE ops.semantic_proposals
  ADD COLUMN IF NOT EXISTS operation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS semantic_proposals_operation_unique
  ON ops.semantic_proposals(operation_id)
  WHERE operation_id IS NOT NULL;

ALTER TABLE ops.semantic_proposals
  DROP CONSTRAINT IF EXISTS semantic_proposals_operation_workspace_fkey;
ALTER TABLE ops.semantic_proposals
  ADD CONSTRAINT semantic_proposals_operation_workspace_fkey
  FOREIGN KEY (operation_id, workspace_id)
  REFERENCES ops.discovery_operations(id, workspace_id);
