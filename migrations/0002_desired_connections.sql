CREATE TABLE desired_connections (
 scope text PRIMARY KEY REFERENCES scopes(id),
 request jsonb NOT NULL,
 plan_id text NOT NULL REFERENCES plans(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO desired_connections(scope,request,plan_id)
SELECT DISTINCT ON (o.scope) o.scope,p.body->'request',p.id
FROM operations o JOIN plans p ON p.id=o.plan_id
ORDER BY o.scope,o.created_at DESC;
UPDATE fake_effects SET body=body-'requires';