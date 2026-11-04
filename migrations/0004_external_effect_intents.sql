-- Offline external-effect recovery primitives. No AWS executor or API admission is enabled.
CREATE TABLE external_effect_intents (
    id text PRIMARY KEY,
    scope text NOT NULL UNIQUE CHECK (length(scope) BETWEEN 1 AND 2048),
    action_key text NOT NULL CHECK (length(action_key) BETWEEN 1 AND 2048),
    desired_sha256 text NOT NULL CHECK (desired_sha256 ~ '^[0-9a-f]{64}$'),
    client_token text NOT NULL UNIQUE,
    state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','dispatched','confirmed')),
    fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
    lease_until timestamptz NOT NULL DEFAULT '-infinity',
    external_id text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((state = 'confirmed') = (external_id IS NOT NULL)),
    CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 2048)
);

CREATE FUNCTION protect_external_effect_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'External effect intent history cannot be deleted';
    END IF;
    IF (NEW.id, NEW.scope, NEW.action_key, NEW.desired_sha256, NEW.client_token, NEW.created_at)
        IS DISTINCT FROM
       (OLD.id, OLD.scope, OLD.action_key, OLD.desired_sha256, OLD.client_token, OLD.created_at) THEN
        RAISE EXCEPTION 'External effect intent identity is immutable';
    END IF;
    IF NEW.fence < OLD.fence
        OR (OLD.state = 'dispatched' AND NEW.state = 'prepared')
        OR (OLD.state = 'confirmed' AND NEW IS DISTINCT FROM OLD) THEN
        RAISE EXCEPTION 'External effect journal cannot roll back dispatch or confirmation';
    END IF;
    IF OLD.state = 'prepared' AND NEW.state = 'confirmed' THEN
        RAISE EXCEPTION 'Confirmation requires prior durable dispatch intent';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER protect_external_effect_intent BEFORE UPDATE OR DELETE ON external_effect_intents
    FOR EACH ROW EXECUTE FUNCTION protect_external_effect_intent();

CREATE TABLE external_effect_events (
    id bigserial PRIMARY KEY,
    intent_id text NOT NULL REFERENCES external_effect_intents(id),
    state text NOT NULL,
    fence bigint NOT NULL,
    external_id text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_external_effect_event BEFORE UPDATE OR DELETE ON external_effect_events
    FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION record_external_effect_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO external_effect_events(intent_id, state, fence, external_id)
        VALUES (NEW.id, NEW.state, NEW.fence, NEW.external_id);
    RETURN NEW;
END;
$$;
CREATE TRIGGER record_external_effect_event AFTER INSERT OR UPDATE ON external_effect_intents
    FOR EACH ROW EXECUTE FUNCTION record_external_effect_event();
