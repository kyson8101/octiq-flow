-- Task messages are the durable bridge between a founder and a running agent.
-- They intentionally contain only concise operational communication, not raw
-- provider transcripts or tool payloads.
CREATE TABLE IF NOT EXISTS octiqos.task_messages (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES octiqos.tasks(id),
  actor TEXT NOT NULL CHECK (actor IN ('founder', 'agent', 'system')),
  kind TEXT NOT NULL CHECK (kind IN ('direction', 'question', 'report')),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 3 AND 12000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_messages_task_created_idx
  ON octiqos.task_messages (task_id, created_at DESC);

-- "blocked" normally means a failed runner. This explicit bit distinguishes
-- the recoverable case where a runner deliberately stopped for the founder's
-- answer and can safely be resumed with that answer.
ALTER TABLE octiqos.agent_runs
  ADD COLUMN IF NOT EXISTS waiting_for_founder BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE octiqos.agent_runs
  ADD COLUMN IF NOT EXISTS pending_founder_direction BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS agent_runs_waiting_for_founder_idx
  ON octiqos.agent_runs (waiting_for_founder, updated_at DESC)
  WHERE waiting_for_founder = TRUE;
