export const up = pgm => {
 pgm.sql(`
 DO $$ DECLARE previous text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO previous FROM pg_constraint WHERE conrelid='research_events'::regclass AND conname='research_events_schema_version_check';
 ALTER TABLE research_events DROP CONSTRAINT research_events_schema_version_check;
 EXECUTE 'ALTER TABLE research_events ADD CONSTRAINT research_events_schema_version_check CHECK (schema_version=4 OR (' || substring(previous from 8 for length(previous)-8) || '))';
 END $$;
 ALTER TABLE research_events DROP CONSTRAINT research_events_v2_state_shape_check;
 ALTER TABLE research_events ADD CONSTRAINT research_events_v2_state_shape_check CHECK(schema_version<>2 OR
 (map_id IS NOT NULL AND (before_state IS NULL OR (jsonb_typeof(before_state)='object' AND before_state->'snapshotVersion'='1'::jsonb AND before_state->>'mapId'=map_id::text AND jsonb_typeof(before_state->'concepts')='array' AND jsonb_typeof(before_state->'links')='array')) AND
 (after_state IS NULL OR (jsonb_typeof(after_state)='object' AND after_state->'snapshotVersion'='1'::jsonb AND after_state->>'mapId'=map_id::text AND jsonb_typeof(after_state->'concepts')='array' AND jsonb_typeof(after_state->'links')='array'))) IS TRUE);
 ALTER TABLE research_events ALTER COLUMN session_id DROP NOT NULL;
 ALTER TABLE research_events ALTER COLUMN participant_code DROP NOT NULL;
 ALTER TABLE research_events ADD COLUMN audit_dedup_key text UNIQUE;
 ALTER TABLE research_events ADD CONSTRAINT research_events_existing_session_required CHECK(schema_version=4 OR (session_id IS NOT NULL AND participant_code IS NOT NULL));
 ALTER TABLE research_events ADD CONSTRAINT research_events_audit_shape CHECK(schema_version<>4 OR
 (actor_type IN('RESEARCHER','SYSTEM') AND before_state IS NULL AND after_state IS NULL AND details='{}'::jsonb
 AND before_quality='NOT_APPLICABLE' AND after_quality='NOT_APPLICABLE' AND client_timestamp IS NULL AND client_time_quality='NOT_APPLICABLE'
 AND related_event_id IS NULL AND
 ((event_type IN('SESSION_CREATE','SESSION_SETTINGS_CHANGE','RESEARCH_ANALYSIS_VIEW','RESEARCH_EXPORT') AND target_type='SESSION')
 OR (event_type='RESEARCH_ASSESSMENT_CHANGE' AND target_type='ASSESSMENT' AND session_id IS NOT NULL)
 OR (event_type IN('DELETE_CONCEPT','DELETE_LINK') AND map_id IS NOT NULL AND target_id IS NOT NULL AND target_type IN('CONCEPT','LINK'))
 OR (event_type='STAGE_DEADLINE' AND actor_type='SYSTEM' AND target_type='STAGE' AND stage_id IS NOT NULL AND session_id IS NOT NULL AND map_id IS NULL)
 OR (event_type='MAP_AUTO_SUBMIT' AND actor_type='SYSTEM' AND target_type='MAP' AND map_id IS NOT NULL AND stage_id IS NOT NULL AND session_id IS NOT NULL)))
 IS TRUE);
 CREATE TABLE research_global_event_counter(id boolean PRIMARY KEY DEFAULT true CHECK(id), next_sequence bigint NOT NULL CHECK(next_sequence>0));
 CREATE UNIQUE INDEX research_global_events_order ON research_events(sequence_number) WHERE session_id IS NULL;
 `);
};
export const down = () => {throw new Error("Audit history must be retained");};

