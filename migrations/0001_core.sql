CREATE TABLE accounts (id text PRIMARY KEY, body jsonb NOT NULL);
CREATE TABLE inventory (account_id text PRIMARY KEY REFERENCES accounts(id), body jsonb NOT NULL);
CREATE TABLE networks (id text PRIMARY KEY, body jsonb NOT NULL);
CREATE TABLE scopes (id text PRIMARY KEY, version integer NOT NULL DEFAULT 0);
CREATE TABLE plans (id text PRIMARY KEY, scope text NOT NULL REFERENCES scopes(id), body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE operations (
 id text PRIMARY KEY, plan_id text NOT NULL UNIQUE REFERENCES plans(id), scope text NOT NULL REFERENCES scopes(id),
 status text NOT NULL CHECK (status IN ('queued','running','retrying','succeeded','failed','partial')),
 step integer NOT NULL DEFAULT 0 CHECK (step >= 0), attempts integer NOT NULL DEFAULT 0,
 fault jsonb NOT NULL, error text, fence bigint NOT NULL DEFAULT 0,
 lease_until timestamptz NOT NULL DEFAULT '-infinity', next_attempt timestamptz NOT NULL DEFAULT '-infinity',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX one_active_operation_per_scope ON operations(scope) WHERE status IN ('queued','running','retrying');
CREATE INDEX operation_queue ON operations(next_attempt,created_at) WHERE status IN ('queued','running','retrying');
CREATE TABLE fake_effects (scope text NOT NULL, action_key text NOT NULL, body jsonb NOT NULL, operation_id text NOT NULL REFERENCES operations(id), fence bigint NOT NULL, PRIMARY KEY(scope,action_key));
CREATE TABLE step_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, operation_id text NOT NULL REFERENCES operations(id), step integer NOT NULL, fence bigint NOT NULL, outcome text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE audit (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor text NOT NULL, event text NOT NULL, target text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Record is append-only'; END $$;
CREATE TRIGGER immutable_plan BEFORE UPDATE OR DELETE ON plans FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_step_event BEFORE UPDATE OR DELETE ON step_events FOR EACH ROW EXECUTE FUNCTION immutable_record();
