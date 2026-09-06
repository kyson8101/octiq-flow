-- The new org world is isolated from the existing mission-control prototype.
-- A locked aggregate gives founder commands and worker completions one atomic
-- consistency boundary. Agent contexts are built by scoped server projections.
CREATE TABLE octiqos.world_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO octiqos.world_state(singleton, payload) VALUES (TRUE, '{}');
