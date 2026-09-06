-- A connector records a normalized, idempotent signal before any agent sees
-- it. Raw webhook payloads intentionally do not enter the operational store:
-- connectors reduce external data to a title, bounded context, and source
-- reference, then the normal PM/approval/evidence loop owns the task.
CREATE TABLE IF NOT EXISTS octiqos.connector_intakes (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('ticket', 'feedback', 'email', 'calendar', 'folder-watch', 'docspace')),
  external_id TEXT NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  domain TEXT NOT NULL CHECK (domain IN ('company', 'personal', 'novel')),
  task_id UUID NOT NULL REFERENCES octiqos.tasks(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS connector_intakes_received_idx
  ON octiqos.connector_intakes (received_at DESC);
CREATE INDEX IF NOT EXISTS connector_intakes_task_idx
  ON octiqos.connector_intakes (task_id);
