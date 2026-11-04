-- AWS metadata is separate from fake-provider executable state.
CREATE TABLE aws_accounts (
    id text PRIMARY KEY,
    aws_account_id text NOT NULL CHECK (aws_account_id ~ '^[0-9]{12}$'),
    region text NOT NULL,
    role_configuration jsonb NOT NULL,
    public_view jsonb NOT NULL,
    discovery_fence bigint NOT NULL DEFAULT 0 CHECK (discovery_fence >= 0),
    UNIQUE(aws_account_id, region)
);
CREATE TABLE aws_topologies (
    id text PRIMARY KEY,
    account_id text NOT NULL REFERENCES aws_accounts(id),
    generation bigint NOT NULL CHECK (generation > 0),
    body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(account_id, generation)
);
CREATE TABLE aws_adoptions (
    id text PRIMARY KEY,
    account_id text NOT NULL REFERENCES aws_accounts(id),
    resource_kind text NOT NULL,
    resource_id text NOT NULL,
    topology_id text NOT NULL REFERENCES aws_topologies(id),
    body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(account_id, resource_kind, resource_id)
);
CREATE TRIGGER immutable_aws_topology BEFORE UPDATE OR DELETE ON aws_topologies FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_aws_adoption BEFORE UPDATE OR DELETE ON aws_adoptions FOR EACH ROW EXECUTE FUNCTION immutable_record();
