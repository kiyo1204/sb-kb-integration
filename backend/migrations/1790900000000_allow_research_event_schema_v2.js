export const up = (pgm) => {
  pgm.sql(`ALTER TABLE research_events DROP CONSTRAINT research_events_schema_version_check;
    ALTER TABLE research_events ADD CONSTRAINT research_events_schema_version_check CHECK (schema_version IN (1, 2));
    ALTER TABLE research_events ADD CONSTRAINT research_events_v2_state_shape_check CHECK (
      schema_version = 1 OR (map_id IS NOT NULL AND
        (before_state IS NULL OR (jsonb_typeof(before_state) = 'object' AND before_state->'snapshotVersion' = '1'::jsonb AND before_state->>'mapId' = map_id::text AND jsonb_typeof(before_state->'concepts') = 'array' AND jsonb_typeof(before_state->'links') = 'array')) AND
        (after_state IS NULL OR (jsonb_typeof(after_state) = 'object' AND after_state->'snapshotVersion' = '1'::jsonb AND after_state->>'mapId' = map_id::text AND jsonb_typeof(after_state->'concepts') = 'array' AND jsonb_typeof(after_state->'links') = 'array'))
      ) IS TRUE
    );`);
};
export const down = () => { throw new Error("Rolling back would invalidate version 2 research events"); };
