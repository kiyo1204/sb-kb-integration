export const up = (pgm) => {
  pgm.sql(`
ALTER TABLE sessions DROP CONSTRAINT sessions_learner_token_hash_chk;
ALTER TABLE sessions ADD CONSTRAINT sessions_learner_token_hash_chk CHECK(learner_access_token_hash IS NULL OR (protocol_key IN ('STAGE1_4','STAGE1_6','STAGE1_5') AND learner_access_token_hash ~ '^[0-9a-f]{64}$'));
ALTER TABLE sessions DROP CONSTRAINT sessions_protocol_key_chk;
ALTER TABLE sessions ADD CONSTRAINT sessions_protocol_key_chk CHECK(protocol_key IN ('STANDARD_7','STAGE1_4','STAGE1_6','STAGE1_5'));
ALTER TABLE sessions ADD CONSTRAINT sessions_stage1_5_fields_chk CHECK(protocol_key<>'STAGE1_5' OR
 (study_group IS NULL AND group_activity_seconds>0 AND group_activity_seconds IS NOT NULL AND participant_code IS NOT NULL AND research_kit_definition_id IS NOT NULL AND lesson_video_url IS NOT NULL));
ALTER TABLE session_stages DROP CONSTRAINT session_stages_type_chk;
ALTER TABLE session_stages ADD CONSTRAINT session_stages_type_chk CHECK(stage_type IN
 ('TUTORIAL','PRE_EXPLANATION','PRIOR_MAP','LESSON','KB_MAP','INTEGRATION_MAP','POST_EXPLANATION','PRE_ASSESSMENT','POST_ASSESSMENT','SELF_STUDY','SURVEY'));
CREATE TABLE survey_questions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES sessions ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('TEXT','CHOICE','RATING')), prompt text NOT NULL CHECK(length(btrim(prompt)) BETWEEN 1 AND 10000),
 required boolean NOT NULL, display_order integer NOT NULL CHECK(display_order>=0),
 config jsonb NOT NULL, UNIQUE(session_id,id), UNIQUE(session_id,display_order),
 CHECK(jsonb_typeof(config)='object'));
CREATE TABLE survey_answers(
 session_id uuid NOT NULL REFERENCES sessions ON DELETE RESTRICT, stage_id uuid NOT NULL REFERENCES session_stages ON DELETE RESTRICT,
 question_id uuid NOT NULL, answer jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(stage_id,question_id), FOREIGN KEY(session_id,question_id) REFERENCES survey_questions(session_id,id) ON DELETE RESTRICT);
CREATE TABLE session_seed_concepts(
 session_id uuid NOT NULL REFERENCES sessions ON DELETE RESTRICT,
 kit_concept_item_id uuid NOT NULL REFERENCES kit_concept_items ON DELETE RESTRICT,
 PRIMARY KEY(session_id,kit_concept_item_id));
CREATE TABLE seeded_map_concepts(
 concept_id uuid PRIMARY KEY REFERENCES concepts ON DELETE RESTRICT,
 session_id uuid NOT NULL REFERENCES sessions ON DELETE RESTRICT,
 kit_concept_item_id uuid NOT NULL REFERENCES kit_concept_items ON DELETE RESTRICT,
 FOREIGN KEY(session_id,kit_concept_item_id) REFERENCES session_seed_concepts(session_id,kit_concept_item_id) ON DELETE RESTRICT);
CREATE FUNCTION protect_seeded_concept() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM seeded_map_concepts WHERE concept_id=OLD.id) AND
 (TG_OP='DELETE' OR NEW.label IS DISTINCT FROM OLD.label OR NEW.merged_into_concept_id IS DISTINCT FROM OLD.merged_into_concept_id) THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='seed_concept_read_only'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
CREATE TRIGGER seeded_concept_guard BEFORE UPDATE OR DELETE ON concepts FOR EACH ROW EXECUTE FUNCTION protect_seeded_concept();

ALTER TABLE research_events DROP CONSTRAINT research_events_schema_version_check;
ALTER TABLE research_events ADD CONSTRAINT research_events_schema_version_check CHECK(schema_version IN (1,2,3,4,5,6,7));
CREATE FUNCTION survey_state_v7_valid(s jsonb,target uuid) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
 IF s IS NULL OR jsonb_typeof(s)<>'object' OR s-ARRAY['questionId','kind','value']<>'{}'::jsonb OR NOT(s ?& ARRAY['questionId','kind','value']) OR s->>'questionId'<>target::text OR s->>'kind' NOT IN('TEXT','CHOICE','RATING') THEN RETURN false; END IF;
 IF s->'value'='null'::jsonb THEN RETURN true; END IF;
 IF s->>'kind'='RATING' THEN RETURN jsonb_typeof(s->'value')='number' AND (s->>'value')::numeric=trunc((s->>'value')::numeric) AND (s->>'value')::numeric BETWEEN -100 AND 1000; END IF;
 RETURN jsonb_typeof(s->'value')='string' AND length(btrim(s->>'value')) BETWEEN 1 AND 100000;
 EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
ALTER TABLE research_events ADD CONSTRAINT research_events_survey_version CHECK(event_type NOT IN ('SURVEY_EDIT','SURVEY_SUBMIT') OR schema_version=7);
ALTER TABLE research_events ADD CONSTRAINT research_events_v7_shape CHECK(schema_version<>7 OR (
 event_type IN ('SURVEY_EDIT','SURVEY_SUBMIT') AND target_type='ASSESSMENT' AND stage_id IS NOT NULL AND target_id IS NOT NULL AND map_id IS NULL AND details='{}'::jsonb AND related_event_id IS NULL AND related_legacy_operation_log_id IS NULL AND
 ((event_type='SURVEY_SUBMIT' AND target_id=stage_id AND before_state IS NULL AND after_state IS NULL) OR
 (event_type='SURVEY_EDIT' AND ((outcome<>'SUCCESS' AND before_state IS NULL AND after_state IS NULL) OR
 (outcome='SUCCESS' AND survey_state_v7_valid(before_state,target_id) AND survey_state_v7_valid(after_state,target_id) AND before_state->>'kind'=after_state->>'kind' AND before_state->'value' IS DISTINCT FROM after_state->'value'))))) IS TRUE);
`);
};
export const down = () => {
  throw new Error("Keep existing sessions and survey records");
};
