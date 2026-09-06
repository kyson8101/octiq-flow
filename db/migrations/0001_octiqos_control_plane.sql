-- OctiqOS owns its schema within the shared OctiqFlow PostgreSQL database.
-- Generic table names would collide as the platform grows, so every runtime
-- query is explicitly qualified with `octiqos`.
-- `CREATE SCHEMA IF NOT EXISTS` still asks PostgreSQL for database-level
-- CREATE privilege even when the schema already exists. Shared databases often
-- grant the OctiqOS role only schema-level table rights, so only attempt the
-- privileged operation when the schema is genuinely absent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'octiqos') THEN
    EXECUTE 'CREATE SCHEMA octiqos';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS octiqos.tasks (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 140),
  detail TEXT,
  domain TEXT NOT NULL CHECK (domain IN ('company', 'personal', 'novel')),
  stage TEXT NOT NULL CHECK (stage IN ('captured', 'triage', 'approved', 'running', 'verifying', 'done', 'blocked')),
  priority TEXT NOT NULL CHECK (priority IN ('routine', 'important', 'urgent')),
  risk TEXT NOT NULL CHECK (risk IN ('safe', 'guarded', 'approval')),
  next_step TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS octiqos.approvals (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES octiqos.tasks(id),
  subject TEXT NOT NULL,
  rationale TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'declined')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS octiqos.agent_runs (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES octiqos.tasks(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'verifying', 'completed', 'blocked')),
  current_step TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS octiqos.mission_events (
  id UUID PRIMARY KEY,
  task_id UUID REFERENCES octiqos.tasks(id),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS octiqos.workflow_profiles (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  domain TEXT NOT NULL CHECK (domain IN ('company', 'personal', 'novel')),
  label TEXT NOT NULL,
  intake_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  planner_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  approval_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  execution_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_stage_updated_idx ON octiqos.tasks (stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS approvals_pending_idx ON octiqos.approvals (decision, requested_at ASC);
CREATE INDEX IF NOT EXISTS agent_runs_status_started_idx ON octiqos.agent_runs (status, started_at DESC);
CREATE INDEX IF NOT EXISTS mission_events_created_idx ON octiqos.mission_events (created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_profiles_domain_idx ON octiqos.workflow_profiles (domain, is_enabled);
