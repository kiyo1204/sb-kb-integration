/** Registration withdrawal is a durable tombstone, never a physical deletion.
 * Existing Session, Map, credential and audit rows remain immutable. */
export const up = pgm => pgm.sql(`
CREATE TABLE experiment_session_withdrawals(
  session_id uuid PRIMARY KEY REFERENCES experiment_run_sessions(session_id) ON DELETE RESTRICT,
  request_key uuid NOT NULL UNIQUE,
  withdrawn_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION experiment_validate_session_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_state text; session_state text; session_started timestamptz; session_completed timestamptz;
BEGIN
  SELECT r.state,s.status,s.started_at,s.completed_at
    INTO run_state,session_state,session_started,session_completed
    FROM experiment_run_sessions p JOIN experiment_runs r ON r.id=p.run_id
    JOIN sessions s ON s.id=p.session_id
    WHERE p.session_id=NEW.session_id AND s.protocol_key='SBKB_INTEGRATION_V1'
    FOR UPDATE OF r,s;
  IF run_state IS DISTINCT FROM 'PREPARING'
    OR session_state IS DISTINCT FROM 'NOT_STARTED'
    OR session_started IS NOT NULL OR session_completed IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_withdrawal_not_eligible';
  END IF;
  IF EXISTS(SELECT 1 FROM session_stages WHERE session_id=NEW.session_id
       AND (status<>'PENDING' OR started_at IS NOT NULL OR completed_at IS NOT NULL))
    OR EXISTS(SELECT 1 FROM maps m JOIN session_stages st ON st.id=m.session_stage_id WHERE st.session_id=NEW.session_id)
    OR EXISTS(SELECT 1 FROM research_events WHERE session_id=NEW.session_id)
    OR EXISTS(SELECT 1 FROM experiment_client_candidates WHERE session_id=NEW.session_id)
    OR EXISTS(SELECT 1 FROM experiment_access_audit WHERE session_id=NEW.session_id AND actor_type='LEARNER' AND action='CLAIM')
    OR EXISTS(SELECT 1 FROM client_event_receipts WHERE session_id=NEW.session_id)
    OR EXISTS(SELECT 1 FROM client_delivery_reports WHERE session_id=NEW.session_id)
    OR EXISTS(SELECT 1 FROM assessment_answers WHERE session_id=NEW.session_id)
    OR EXISTS(SELECT 1 FROM survey_answers WHERE session_id=NEW.session_id)
    OR EXISTS(SELECT 1 FROM research_proposition_evaluations WHERE session_id=NEW.session_id)
    OR EXISTS(SELECT 1 FROM research_reflection_notes WHERE session_id=NEW.session_id)
    OR EXISTS(SELECT 1 FROM operation_receipts WHERE principal_scope LIKE 'LEARNER:'||NEW.session_id::text||'%')
    THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_withdrawal_has_activity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER experiment_withdrawal_validate BEFORE INSERT ON experiment_session_withdrawals
  FOR EACH ROW EXECUTE FUNCTION experiment_validate_session_withdrawal();
CREATE TRIGGER experiment_withdrawal_immutable BEFORE UPDATE OR DELETE ON experiment_session_withdrawals
  FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
CREATE FUNCTION experiment_withdrawal_prevent_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM experiment_participant_access WHERE session_id=NEW.session_id FOR SHARE;
  IF EXISTS(SELECT 1 FROM experiment_session_withdrawals WHERE session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_code_invalidated';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER experiment_withdrawal_client_guard BEFORE INSERT ON experiment_client_candidates
  FOR EACH ROW EXECUTE FUNCTION experiment_withdrawal_prevent_claim();
`);
export const down = () => {
  throw new Error("Preserve withdrawn Session and credential history; roll forward");
};
