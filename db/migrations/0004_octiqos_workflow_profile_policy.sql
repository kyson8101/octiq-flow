-- Workflow profiles are a single policy envelope per initial domain. A profile
-- may tune future intake/connectors and local runner choices, but it cannot
-- disable the V0 founder-evidence closeout rule.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_profiles_domain_unique_idx
  ON octiqos.workflow_profiles (domain);

UPDATE octiqos.workflow_profiles
SET execution_policy = jsonb_set(
  execution_policy,
  '{evidenceRequired}',
  'true'::jsonb,
  true
)
WHERE execution_policy ->> 'evidenceRequired' IS DISTINCT FROM 'true';
