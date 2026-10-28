export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE research_event_counters (
      session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE RESTRICT,
      next_sequence bigint NOT NULL CHECK (next_sequence > 0)
    );
    CREATE TABLE research_events (
      event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      schema_version smallint NOT NULL CHECK (schema_version = 1),
      session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
      stage_id uuid REFERENCES session_stages(id) ON DELETE RESTRICT,
      map_id uuid REFERENCES maps(id) ON DELETE RESTRICT,
      participant_code text NOT NULL,
      study_group text CHECK (study_group IN ('EXPERIMENTAL','CONTROL')),
      activity text,
      actor_type text NOT NULL CHECK (actor_type IN ('LEARNER','RESEARCHER','SYSTEM')),
      event_type text NOT NULL CHECK (event_type ~ '^[A-Z][A-Z0-9_]{1,63}$'),
      target_type text NOT NULL CHECK (target_type IN ('SESSION','STAGE','MAP','CONCEPT','LINK','ASSESSMENT','VIDEO','FEEDBACK','SCREEN')),
      target_id uuid,
      outcome text NOT NULL CHECK (outcome IN ('SUCCESS','FAILURE','REJECTED','CANCELLED','UNKNOWN')),
      reason_code text CHECK (reason_code IN ('NOT_APPLICABLE','UNKNOWN','VALIDATION','PERMISSION','DEADLINE','CONFLICT','NETWORK','SERVER','USER_CANCELLED','OTHER')),
      sequence_number bigint NOT NULL CHECK (sequence_number > 0),
      client_timestamp timestamptz,
      client_time_quality text NOT NULL CHECK (client_time_quality IN ('OBSERVED','ESTIMATED','MISSING','NOT_APPLICABLE','UNKNOWN')),
      server_timestamp timestamptz NOT NULL DEFAULT clock_timestamp(),
      related_event_id uuid REFERENCES research_events(event_id) ON DELETE RESTRICT,
      before_state jsonb,
      after_state jsonb,
      before_quality text NOT NULL CHECK (before_quality IN ('OBSERVED','ESTIMATED','MISSING','NOT_APPLICABLE','UNKNOWN')),
      after_quality text NOT NULL CHECK (after_quality IN ('OBSERVED','ESTIMATED','MISSING','NOT_APPLICABLE','UNKNOWN')),
      details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
      CHECK ((client_timestamp IS NOT NULL AND client_time_quality IN ('OBSERVED','ESTIMATED')) OR
             (client_timestamp IS NULL AND client_time_quality IN ('MISSING','NOT_APPLICABLE','UNKNOWN'))),
      CHECK ((before_state IS NOT NULL AND before_quality IN ('OBSERVED','ESTIMATED')) OR (before_state IS NULL AND before_quality IN ('MISSING','NOT_APPLICABLE','UNKNOWN'))),
      CHECK ((after_state IS NOT NULL AND after_quality IN ('OBSERVED','ESTIMATED')) OR (after_state IS NULL AND after_quality IN ('MISSING','NOT_APPLICABLE','UNKNOWN'))),
      UNIQUE(session_id, sequence_number)
    );
    CREATE INDEX research_events_session_map_order_idx ON research_events(session_id, map_id, sequence_number);
    CREATE INDEX research_events_session_stage_order_idx ON research_events(session_id, stage_id, sequence_number);
    CREATE INDEX research_events_session_type_order_idx ON research_events(session_id, event_type, sequence_number);
  `);
};
export const down = () => { throw new Error('Research events cannot be rolled back without losing data'); };
