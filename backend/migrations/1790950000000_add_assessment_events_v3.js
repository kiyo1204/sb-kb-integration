export const up = pgm => {
  pgm.sql(`
    ALTER TABLE research_events DROP CONSTRAINT research_events_schema_version_check;
    ALTER TABLE research_events ADD CONSTRAINT research_events_schema_version_check CHECK(schema_version IN (1,2,3));
    ALTER TABLE research_events DROP CONSTRAINT research_events_v2_state_shape_check;
    ALTER TABLE research_events ADD CONSTRAINT research_events_v2_state_shape_check CHECK (
      schema_version <> 2 OR (map_id IS NOT NULL AND
       (before_state IS NULL OR (jsonb_typeof(before_state)='object' AND before_state->'snapshotVersion'='1'::jsonb AND before_state->>'mapId'=map_id::text AND jsonb_typeof(before_state->'concepts')='array' AND jsonb_typeof(before_state->'links')='array')) AND
       (after_state IS NULL OR (jsonb_typeof(after_state)='object' AND after_state->'snapshotVersion'='1'::jsonb AND after_state->>'mapId'=map_id::text AND jsonb_typeof(after_state->'concepts')='array' AND jsonb_typeof(after_state->'links')='array'))) IS TRUE);
    CREATE FUNCTION assessment_event_state_valid(s jsonb, target uuid) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN jsonb_typeof(s)='object' THEN
        (s - ARRAY['questionId','answer'] = '{}'::jsonb AND s ?& ARRAY['questionId','answer']
         AND s->>'questionId'=target::text
         AND (s->'answer'='null'::jsonb OR
           (jsonb_typeof(s->'answer')='string' AND length(btrim(s->>'answer'))>0 AND length(s->>'answer')<=100000)))
      ELSE false END
    $$;
    ALTER TABLE research_events ADD CONSTRAINT research_events_v3_shape CHECK (
      schema_version <> 3 OR (stage_id IS NOT NULL AND map_id IS NULL AND target_id IS NOT NULL
        AND target_type='ASSESSMENT' AND event_type IN ('ASSESSMENT_EDIT','ASSESSMENT_SUBMIT')
        AND details='{}'::jsonb AND related_event_id IS NULL
        AND CASE WHEN event_type='ASSESSMENT_SUBMIT' THEN target_id=stage_id AND before_state IS NULL AND after_state IS NULL
          WHEN outcome='SUCCESS' THEN assessment_event_state_valid(before_state,target_id) AND assessment_event_state_valid(after_state,target_id) AND before_state<>after_state
          ELSE before_state IS NULL AND after_state IS NULL END) IS TRUE);
  `);
};
export const down = () => { throw new Error("Assessment history must be retained"); };

