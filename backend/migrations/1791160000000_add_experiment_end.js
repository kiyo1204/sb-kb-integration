/** Ending freezes learning, never submits or rewrites participant history. */
export const up = pgm => pgm.sql(`
ALTER TABLE experiment_runs ADD COLUMN ended_at timestamptz;
ALTER TABLE experiment_runs DROP CONSTRAINT experiment_runs_state_check;
ALTER TABLE experiment_runs ADD CONSTRAINT experiment_runs_state_check CHECK(
(state='PREPARING' AND started_at IS NULL AND ended_at IS NULL) OR
(state='RUNNING' AND started_at IS NOT NULL AND ended_at IS NULL) OR
(state='ENDED' AND started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at>=started_at));
CREATE OR REPLACE FUNCTION experiment_run_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'experiment_record_immutable';END IF;
 IF OLD.state='PREPARING' AND NEW.state='RUNNING' AND NEW.started_at IS NOT NULL AND NEW.ended_at IS NULL AND
 (to_jsonb(OLD)-ARRAY['state','started_at']) IS NOT DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','started_at']) AND EXISTS(SELECT 1 FROM experiment_run_sessions WHERE run_id=OLD.id) THEN RETURN NEW;END IF;
 IF OLD.state='RUNNING' AND NEW.state='ENDED' AND NEW.ended_at IS NOT NULL AND
 (to_jsonb(OLD)-ARRAY['state','ended_at']) IS NOT DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','ended_at']) THEN RETURN NEW;END IF;
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_run_transition_invalid';END $$;
CREATE TABLE experiment_end_receipts(request_key uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES experiment_runs,ended_at timestamptz NOT NULL);
CREATE TABLE experiment_end_audit(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid,http_status integer NOT NULL,outcome text NOT NULL,reason_code text NOT NULL,server_timestamp timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER experiment_end_receipt_immutable BEFORE UPDATE OR DELETE ON experiment_end_receipts FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
CREATE TRIGGER experiment_end_audit_immutable BEFORE UPDATE OR DELETE ON experiment_end_audit FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
CREATE FUNCTION experiment_assert_running(target uuid) RETURNS void LANGUAGE plpgsql AS $$ DECLARE current_state text; BEGIN
 SELECT r.state INTO current_state FROM experiment_runs r JOIN experiment_run_sessions p ON p.run_id=r.id WHERE p.session_id=target FOR SHARE OF r;
 IF current_state='ENDED' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_ended';END IF;
END $$;
CREATE FUNCTION experiment_end_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE mid uuid;sid uuid; BEGIN
 IF TG_TABLE_NAME='research_events' THEN
  IF NEW.actor_type='LEARNER' THEN PERFORM experiment_assert_running(NEW.session_id);END IF;
 ELSIF TG_TABLE_NAME='maps' THEN
  SELECT session_id INTO sid FROM session_stages WHERE id=coalesce(NEW.session_stage_id,OLD.session_stage_id);PERFORM experiment_assert_running(sid);
 ELSE
  mid=CASE WHEN TG_OP='DELETE' THEN OLD.map_id ELSE NEW.map_id END;
  SELECT st.session_id INTO sid FROM maps m JOIN session_stages st ON st.id=m.session_stage_id WHERE m.id=mid;PERFORM experiment_assert_running(sid);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END $$;
CREATE TRIGGER experiment_end_map_guard BEFORE INSERT OR UPDATE OR DELETE ON maps FOR EACH ROW EXECUTE FUNCTION experiment_end_write_guard();
CREATE TRIGGER experiment_end_concept_guard BEFORE INSERT OR UPDATE OR DELETE ON concepts FOR EACH ROW EXECUTE FUNCTION experiment_end_write_guard();
CREATE TRIGGER experiment_end_link_guard BEFORE INSERT OR UPDATE OR DELETE ON links FOR EACH ROW EXECUTE FUNCTION experiment_end_write_guard();
CREATE TRIGGER experiment_end_event_guard BEFORE INSERT ON research_events FOR EACH ROW EXECUTE FUNCTION experiment_end_write_guard();
`);
export const down = () => {throw new Error("Preserve ended experiments; disable writes and roll forward");};
