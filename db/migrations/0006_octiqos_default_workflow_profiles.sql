-- A control plane cannot accept its first task without a policy envelope.
-- These are safe operating defaults, not demo tasks: existing profile choices
-- always win, while a fresh database gets the three initial domains ready for
-- founder configuration immediately.
INSERT INTO octiqos.workflow_profiles (
  id, slug, domain, label, intake_policy, planner_policy, approval_policy, execution_policy
)
VALUES
  (
    '00000000-0000-4000-8000-000000000501',
    'company-projects',
    'company',
    'Company projects',
    '{"sources":["manual","ticket","feedback"],"confirmation":"plan"}',
    '{"agent":"pm","mode":"brainstorm-and-grill"}',
    '{"requiredFor":["scope","deployment","external-write"]}',
    '{"runners":["codex","claude","deepseek"],"evidenceRequired":true}'
  ),
  (
    '00000000-0000-4000-8000-000000000502',
    'personal-operations',
    'personal',
    'Personal operations',
    '{"sources":["manual","email","calendar","folder-watch"],"confirmation":"policy"}',
    '{"agent":"pm","mode":"clarify-and-draft"}',
    '{"requiredFor":["financial-change","payment","delete","nas-write"]}',
    '{"runners":["local-llm"],"evidenceRequired":true,"financialMode":"review-only"}'
  ),
  (
    '00000000-0000-4000-8000-000000000503',
    'novel-studio',
    'novel',
    'Novel studio',
    '{"sources":["manual","docspace"],"confirmation":"none"}',
    '{"agent":"story-pm","mode":"continuity-and-outline"}',
    '{"requiredFor":["canon-change"]}',
    '{"runners":["codex","claude","deepseek"],"evidenceRequired":true}'
  )
ON CONFLICT (domain) DO NOTHING;
