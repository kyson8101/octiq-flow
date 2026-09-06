-- Illustrative operating state for a fresh local database. Each row is
-- idempotent and can safely be applied again during setup.
INSERT INTO octiqos.tasks (id, title, detail, domain, stage, priority, risk, next_step)
VALUES
  ('00000000-0000-4000-8000-000000000101', 'Approve the OctiqOS mission-control boundary', 'Confirm the first loop stays manual request to verified agent run before live connectors are added.', 'company', 'triage', 'urgent', 'approval', 'Founder decision required'),
  ('00000000-0000-4000-8000-000000000102', 'Define the OctiqFlow runner contract', 'Specify how OctiqOS requests an isolated run and receives status, evidence, and questions back.', 'company', 'running', 'important', 'guarded', 'Draft the run contract'),
  ('00000000-0000-4000-8000-000000000103', 'Prepare the PostgreSQL operational store', 'Apply the initial schema for tasks, approvals, runs, and events.', 'company', 'verifying', 'important', 'safe', 'Review the additive schema'),
  ('00000000-0000-4000-8000-000000000104', 'Create a receipt intake policy', 'Define how local receipt and bank-advice files are renamed, filed, and proposed for credit-card reconciliation without initiating a payment.', 'personal', 'triage', 'important', 'approval', 'Choose the review and confirmation policy'),
  ('00000000-0000-4000-8000-000000000105', 'Map the current novel chapter continuity', 'Capture open chapter beats and known dependencies before the next writing session.', 'novel', 'captured', 'routine', 'safe', 'Send the chapter material to the story workflow')
ON CONFLICT (id) DO NOTHING;

INSERT INTO octiqos.workflow_profiles (id, slug, domain, label, intake_policy, planner_policy, approval_policy, execution_policy)
VALUES
  ('00000000-0000-4000-8000-000000000501', 'company-projects', 'company', 'Company projects', '{"sources":["manual","ticket","feedback"],"confirmation":"plan"}', '{"agent":"pm","mode":"brainstorm-and-grill"}', '{"requiredFor":["scope","deployment","external-write"]}', '{"runners":["codex","claude","deepseek"],"evidenceRequired":true}'),
  ('00000000-0000-4000-8000-000000000502', 'personal-operations', 'personal', 'Personal operations', '{"sources":["manual","email","calendar","folder-watch"],"confirmation":"policy"}', '{"agent":"pm","mode":"clarify-and-draft"}', '{"requiredFor":["financial-change","payment","delete","nas-write"]}', '{"runners":["local-llm"],"evidenceRequired":true,"financialMode":"review-only"}'),
  ('00000000-0000-4000-8000-000000000503', 'novel-studio', 'novel', 'Novel studio', '{"sources":["manual","docspace"],"confirmation":"none"}', '{"agent":"story-pm","mode":"continuity-and-outline"}', '{"requiredFor":["canon-change"]}', '{"runners":["codex","claude","deepseek"],"evidenceRequired":true}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO octiqos.approvals (id, task_id, subject, rationale)
VALUES ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', 'Keep receipt and payment workflows in a review-only mode', 'Financial documents can be classified and a credit-card payment record can be prepared, but no transfer, deletion, or ledger mutation should happen without evidence and founder confirmation.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO octiqos.agent_runs (id, task_id, provider, model, status, current_step)
VALUES
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000102', 'OctiqFlow', 'Codex', 'running', 'Mapping the execution handoff'),
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000103', 'OctiqOS', 'Verifier', 'verifying', 'Checking the migration evidence')
ON CONFLICT (id) DO NOTHING;

INSERT INTO octiqos.mission_events (id, task_id, kind, message)
VALUES
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000101', 'approval_requested', 'Founder decision requested: receipt and payment workflow policy'),
  ('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000102', 'agent_running', 'OctiqFlow run is mapping the execution handoff'),
  ('00000000-0000-4000-8000-000000000403', '00000000-0000-4000-8000-000000000103', 'verification_started', 'Verifier is checking the PostgreSQL migration')
ON CONFLICT (id) DO NOTHING;
