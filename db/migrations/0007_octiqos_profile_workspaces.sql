-- A workflow profile may have one intentional default workspace.  The
-- workspace registry remains owned by OctiqFlow's local workspace store; this
-- snapshot makes the control plane readable and keeps an existing task bound
-- to the folder it was created with if the registry later changes.
ALTER TABLE octiqos.workflow_profiles
  ADD COLUMN IF NOT EXISTS default_workspace_id TEXT;

ALTER TABLE octiqos.workflow_profiles
  ADD COLUMN IF NOT EXISTS default_workspace_name TEXT;

ALTER TABLE octiqos.workflow_profiles
  ADD COLUMN IF NOT EXISTS default_workspace_path TEXT;

CREATE INDEX IF NOT EXISTS workflow_profiles_default_workspace_idx
  ON octiqos.workflow_profiles (default_workspace_id)
  WHERE default_workspace_id IS NOT NULL;
