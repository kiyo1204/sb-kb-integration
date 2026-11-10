/** Participant access only; legacy credentials and storage-only flow stay intact. */
export const up = (pgm) =>
  pgm.sql(`
CREATE TABLE experiment_participant_access(
 session_id uuid PRIMARY KEY REFERENCES experiment_run_sessions(session_id) ON DELETE RESTRICT,
 code_hash text NOT NULL UNIQUE CHECK(code_hash ~ '^[a-f0-9]{64}$'),
 credential_generation integer NOT NULL DEFAULT 1 CHECK(credential_generation>0),
 device_generation integer NOT NULL DEFAULT 1 CHECK(device_generation>0),
 active_client_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE experiment_client_candidates(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_id uuid NOT NULL REFERENCES experiment_participant_access ON DELETE RESTRICT,
 client_hash text NOT NULL CHECK(client_hash ~ '^[a-f0-9]{64}$'),credential_generation integer NOT NULL CHECK(credential_generation>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(session_id,credential_generation,client_hash));
ALTER TABLE experiment_participant_access ADD CONSTRAINT experiment_active_client_fk FOREIGN KEY(active_client_id) REFERENCES experiment_client_candidates ON DELETE RESTRICT;
CREATE TABLE experiment_retired_credentials(
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),session_id uuid NOT NULL REFERENCES experiment_participant_access ON DELETE RESTRICT,
 credential_generation integer NOT NULL,revoked_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE experiment_access_operations(
 request_key uuid PRIMARY KEY,action text NOT NULL CHECK(action IN ('REGISTER','ISSUE','REISSUE','SWITCH')),
 run_id uuid NOT NULL REFERENCES experiment_run_catalog(run_id) ON DELETE RESTRICT,
 session_id uuid NOT NULL REFERENCES experiment_participant_access ON DELETE RESTRICT,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(jsonb_typeof(result)='object' AND NOT result ?| ARRAY['code','issuedCode','token','code_hash','clientSecret']));
CREATE TABLE experiment_access_audit(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),action text NOT NULL CHECK(action IN ('REGISTER','ISSUE','REISSUE','SWITCH','CLAIM','VIEW')),
 run_id uuid,session_id uuid,actor_type text NOT NULL CHECK(actor_type IN ('RESEARCHER','LEARNER')),
 http_status integer NOT NULL CHECK(http_status BETWEEN 200 AND 599),outcome text NOT NULL CHECK(outcome IN ('SUCCESS','REJECTED','FAILURE')),
 reason text CHECK(reason IN ('VALIDATION','CONFLICT','SERVER')),
 reason_code text NOT NULL CHECK(reason_code IN ('ok','not_found','access_invalid_request','access_conflict','access_storage_unavailable','access_sensitive_text','experiment_code_invalidated','experiment_client_in_use','experiment_client_stale','safety_budget_exceeded','safety_lookup_unavailable')),
 server_timestamp timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((http_status<400 AND outcome='SUCCESS' AND reason IS NULL) OR (http_status>=400 AND http_status<500 AND outcome='REJECTED' AND reason IN ('VALIDATION','CONFLICT')) OR (http_status>=500 AND outcome='FAILURE' AND reason='SERVER')));
CREATE FUNCTION experiment_access_validate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM sessions s JOIN experiment_run_sessions p ON p.session_id=s.id JOIN experiment_run_catalog x ON x.run_id=p.run_id WHERE s.id=NEW.session_id AND s.protocol_key='SBKB_INTEGRATION_V1') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_access_owner_mismatch';END IF;
 IF NEW.active_client_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM experiment_client_candidates c WHERE c.id=NEW.active_client_id AND c.session_id=NEW.session_id AND c.credential_generation=NEW.credential_generation) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_client_mismatch';END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.session_id<>OLD.session_id OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_access_immutable';END IF;
  IF NOT (
   (NEW.credential_generation=OLD.credential_generation+1 AND NEW.code_hash<>OLD.code_hash AND NEW.device_generation=OLD.device_generation+1 AND NEW.active_client_id IS NULL) OR
   (NEW.credential_generation=OLD.credential_generation AND NEW.code_hash=OLD.code_hash AND NEW.device_generation=OLD.device_generation+1 AND NEW.active_client_id IS NOT NULL AND NEW.active_client_id IS DISTINCT FROM OLD.active_client_id) OR
   (NEW.credential_generation=OLD.credential_generation AND NEW.code_hash=OLD.code_hash AND NEW.device_generation=OLD.device_generation AND OLD.active_client_id IS NULL AND NEW.active_client_id IS NOT NULL)) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_access_transition_invalid';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER experiment_access_validate BEFORE INSERT OR UPDATE ON experiment_participant_access FOR EACH ROW EXECUTE FUNCTION experiment_access_validate();
CREATE FUNCTION experiment_access_retirement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.code_hash<>OLD.code_hash AND NOT EXISTS(SELECT 1 FROM experiment_retired_credentials r WHERE r.token_hash=OLD.code_hash AND r.session_id=OLD.session_id AND r.credential_generation=OLD.credential_generation) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_retirement_required';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER experiment_access_retirement AFTER UPDATE ON experiment_participant_access DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION experiment_access_retirement();
CREATE FUNCTION experiment_client_validate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM experiment_participant_access a WHERE a.session_id=NEW.session_id AND a.credential_generation=NEW.credential_generation) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_client_mismatch';END IF;RETURN NEW;
END $$;
CREATE TRIGGER experiment_client_validate BEFORE INSERT ON experiment_client_candidates FOR EACH ROW EXECUTE FUNCTION experiment_client_validate();
CREATE TRIGGER experiment_access_no_delete BEFORE DELETE ON experiment_participant_access FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['experiment_client_candidates','experiment_retired_credentials','experiment_access_operations','experiment_access_audit'] LOOP
 EXECUTE format('CREATE TRIGGER experiment_access_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION experiment_immutable()',t);
END LOOP;END $$;
CREATE FUNCTION experiment_access_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM experiment_participant_access) OR EXISTS(SELECT 1 FROM experiment_access_audit) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_access_immutable';END IF;RETURN NULL;
END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['experiment_participant_access','experiment_client_candidates','experiment_retired_credentials','experiment_access_operations','experiment_access_audit'] LOOP
 EXECUTE format('CREATE TRIGGER experiment_access_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION experiment_access_no_truncate()',t);
END LOOP;END $$;
`);
export const down = () => {
  throw new Error(
    "Preserve participant access history; stop writes and roll forward",
  );
};
