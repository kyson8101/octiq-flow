-- Kanban is a view over durable task state.  A task is never deleted when the
-- founder abandons it, and a re-open starts a separately traceable work cycle.
ALTER TABLE octiqos.tasks
  DROP CONSTRAINT IF EXISTS tasks_stage_check;

ALTER TABLE octiqos.tasks
  ADD CONSTRAINT tasks_stage_check
  CHECK (stage IN ('captured', 'triage', 'approved', 'running', 'verifying', 'done', 'blocked', 'abandoned'));

CREATE TABLE IF NOT EXISTS octiqos.task_cycles (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES octiqos.tasks(id),
  cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
  instruction TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'abandoned')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  UNIQUE (task_id, cycle_number)
);

ALTER TABLE octiqos.agent_runs
  ADD COLUMN IF NOT EXISTS chat_key TEXT;

CREATE INDEX IF NOT EXISTS task_cycles_task_opened_idx
  ON octiqos.task_cycles (task_id, opened_at DESC);
