-- The first durable loop: a read-only PM proposal is reviewed before an
-- execution runner is launched.  Plans are immutable snapshots; asking for a
-- new plan supersedes the earlier proposal instead of overwriting history.
CREATE TABLE IF NOT EXISTS octiqos.plans (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES octiqos.tasks(id),
  status TEXT NOT NULL CHECK (status IN ('drafting', 'awaiting_confirmation', 'confirmed', 'superseded', 'failed')),
  planner_provider TEXT NOT NULL,
  planner_model TEXT NOT NULL,
  chat_key TEXT NOT NULL UNIQUE,
  content TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ
);

ALTER TABLE octiqos.tasks
  ADD COLUMN IF NOT EXISTS workspace_path TEXT;

CREATE INDEX IF NOT EXISTS plans_task_requested_idx
  ON octiqos.plans (task_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS plans_status_requested_idx
  ON octiqos.plans (status, requested_at DESC);
