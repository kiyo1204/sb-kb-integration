export const up = (pgm) => {
  pgm.addColumns('sessions', {
    study_group: { type: 'text' },
    group_activity_seconds: { type: 'integer' },
  });
  pgm.createTable('research_settings', {
    id: { type: 'integer', primaryKey: true },
    group_activity_seconds: { type: 'integer', notNull: true },
  });
  pgm.sql(`
    ALTER TABLE research_settings ADD CONSTRAINT research_settings_values_chk
      CHECK (id = 1 AND group_activity_seconds > 0);
    ALTER TABLE sessions DROP CONSTRAINT sessions_protocol_key_chk;
    ALTER TABLE sessions ADD CONSTRAINT sessions_protocol_key_chk
      CHECK (protocol_key IN ('STANDARD_7', 'STAGE1_4', 'STAGE1_6'));
    ALTER TABLE sessions ADD CONSTRAINT sessions_stage1_6_fields_chk CHECK (
      protocol_key <> 'STAGE1_6' OR (study_group IS NOT NULL AND group_activity_seconds IS NOT NULL AND study_group IN ('EXPERIMENTAL', 'CONTROL')
        AND group_activity_seconds > 0 AND participant_code IS NOT NULL
        AND length(btrim(participant_code)) BETWEEN 1 AND 64
        AND lesson_video_url IS NOT NULL AND length(lesson_video_url) > 0
        AND research_kit_definition_id IS NOT NULL));
    ALTER TABLE session_stages DROP CONSTRAINT session_stages_type_chk;
    ALTER TABLE session_stages ADD CONSTRAINT session_stages_type_chk CHECK (stage_type IN (
      'TUTORIAL', 'PRE_EXPLANATION', 'PRIOR_MAP', 'LESSON', 'KB_MAP',
      'INTEGRATION_MAP', 'POST_EXPLANATION', 'PRE_ASSESSMENT', 'POST_ASSESSMENT', 'SELF_STUDY'));
  `);
};

export const down = () => {
  throw new Error('The six-activity protocol cannot be rolled back without losing research data');
};
