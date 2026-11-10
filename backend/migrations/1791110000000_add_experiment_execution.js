/** Additive execution contract; legacy protocols and rows retain their meaning. */
export const up = (pgm) =>
  pgm.sql(`
ALTER TABLE experiment_runs DROP CONSTRAINT experiment_runs_state_check;
ALTER TABLE experiment_runs ADD COLUMN started_at timestamptz;
ALTER TABLE experiment_runs ADD CONSTRAINT experiment_runs_state_check CHECK((state='PREPARING' AND started_at IS NULL) OR (state='RUNNING' AND started_at IS NOT NULL));
DROP TRIGGER experiment_run_immutable ON experiment_runs;
CREATE FUNCTION experiment_run_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'experiment_record_immutable';END IF;
 IF OLD.state<>'PREPARING' OR NEW.state<>'RUNNING' OR NEW.started_at IS NULL OR
 (to_jsonb(OLD)-ARRAY['state','started_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','started_at']) OR
 NOT EXISTS(SELECT 1 FROM experiment_run_sessions WHERE run_id=OLD.id) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_run_transition_invalid';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER experiment_run_immutable BEFORE UPDATE OR DELETE ON experiment_runs FOR EACH ROW EXECUTE FUNCTION experiment_run_transition();
CREATE TABLE experiment_start_receipts(request_key uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES experiment_runs,started_at timestamptz NOT NULL);
CREATE TABLE experiment_start_audit(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid, http_status integer NOT NULL,outcome text NOT NULL,reason_code text NOT NULL,server_timestamp timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER experiment_start_receipt_immutable BEFORE UPDATE OR DELETE ON experiment_start_receipts FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
CREATE TRIGGER experiment_start_audit_immutable BEFORE UPDATE OR DELETE ON experiment_start_audit FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
ALTER TABLE sessions DROP CONSTRAINT experiment_storage_only;
ALTER TABLE sessions ADD CONSTRAINT experiment_fixed_fields CHECK(protocol_key<>'SBKB_INTEGRATION_V1' OR
 (learner_access_token_hash IS NULL AND study_group IS NULL AND participant_code IS NOT NULL AND length(btrim(participant_code)) BETWEEN 1 AND 64 AND research_kit_definition_id IS NOT NULL AND lesson_video_url IS NOT NULL AND group_activity_seconds>0));
CREATE OR REPLACE FUNCTION experiment_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' AND OLD.protocol_key='SBKB_INTEGRATION_V1' THEN RAISE EXCEPTION 'experiment_storage_only';END IF;
 IF TG_OP='UPDATE' AND (OLD.protocol_key='SBKB_INTEGRATION_V1' OR NEW.protocol_key='SBKB_INTEGRATION_V1') THEN
  IF (to_jsonb(OLD)-ARRAY['status','started_at','completed_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','started_at','completed_at']) OR
   NOT EXISTS(SELECT 1 FROM experiment_run_sessions p JOIN experiment_runs r ON r.id=p.run_id WHERE p.session_id=OLD.id AND r.state='RUNNING') OR
   NOT ((OLD.status='NOT_STARTED' AND NEW.status='IN_PROGRESS' AND NEW.started_at IS NOT NULL AND NEW.completed_at IS NULL) OR
        (OLD.status='IN_PROGRESS' AND NEW.status='COMPLETED' AND NEW.started_at=OLD.started_at AND NEW.completed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM session_stages WHERE session_id=OLD.id AND status<>'COMPLETED'))) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_session_transition_invalid';END IF;
 END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END $$;
CREATE OR REPLACE FUNCTION experiment_stage_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF experiment_session_is_foundation(NEW.session_id) AND (NEW.status<>'PENDING' OR NEW.started_at IS NOT NULL OR NEW.completed_at IS NOT NULL) THEN RAISE EXCEPTION 'experiment_stage_transition_invalid';END IF;
 ELSIF experiment_session_is_foundation(OLD.session_id) OR (TG_OP='UPDATE' AND experiment_session_is_foundation(NEW.session_id)) THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'experiment_storage_only';END IF;
  IF (to_jsonb(OLD)-ARRAY['status','started_at','completed_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','started_at','completed_at']) OR
   NOT EXISTS(SELECT 1 FROM sessions s JOIN experiment_run_sessions p ON p.session_id=s.id JOIN experiment_runs r ON r.id=p.run_id WHERE s.id=NEW.session_id AND s.status='IN_PROGRESS' AND r.state='RUNNING') OR
   EXISTS(SELECT 1 FROM session_stages WHERE session_id=NEW.session_id AND order_index<NEW.order_index AND status<>'COMPLETED') OR
   NOT ((OLD.status='PENDING' AND NEW.status='IN_PROGRESS' AND NEW.started_at IS NOT NULL AND NEW.completed_at IS NULL) OR
        (OLD.status='IN_PROGRESS' AND NEW.status='COMPLETED' AND NEW.started_at=OLD.started_at AND NEW.completed_at IS NOT NULL AND (NEW.stage_type='LESSON' OR EXISTS(SELECT 1 FROM maps WHERE session_stage_id=NEW.id AND status='SUBMITTED')))) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_stage_transition_invalid';END IF;
 END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END $$;
CREATE OR REPLACE FUNCTION experiment_no_map() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM session_stages WHERE id=NEW.session_stage_id AND experiment_session_is_foundation(session_id)) AND
 NOT EXISTS(SELECT 1 FROM session_stages st JOIN sessions s ON s.id=st.session_id JOIN experiment_run_sessions p ON p.session_id=s.id JOIN experiment_runs r ON r.id=p.run_id
 WHERE st.id=NEW.session_stage_id AND st.status='IN_PROGRESS' AND s.status='IN_PROGRESS' AND r.state='RUNNING' AND
 st.stage_type=CASE NEW.type WHEN 'PRIOR' THEN 'PRIOR_MAP' WHEN 'KB' THEN 'KB_MAP' WHEN 'INTEGRATION' THEN 'INTEGRATION_MAP' ELSE '' END) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_map_not_active';END IF;
 RETURN NEW;END $$;
`);
export const down = () => {
  throw new Error(
    "Preserve experiment execution data; disable execution and roll forward",
  );
};
