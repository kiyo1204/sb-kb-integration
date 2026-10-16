/** Add an opt-in post-lesson Stage 1 protocol alongside the legacy seven-stage flow. */
export const up = (pgm) => {
  pgm.addColumns("sessions", {
    protocol_key: { type: "text", notNull: true, default: "STANDARD_7" },
    participant_code: { type: "text" },
    lesson_video_url: { type: "text" },
    research_kit_definition_id: {
      type: "uuid",
      references: "kit_definitions",
      onDelete: "RESTRICT",
    },
  });
  pgm.sql(`
    ALTER TABLE sessions ADD CONSTRAINT sessions_protocol_key_chk
      CHECK (protocol_key IN ('STANDARD_7', 'STAGE1_4'));
    ALTER TABLE sessions ADD CONSTRAINT sessions_stage1_fields_chk
      CHECK (
        protocol_key <> 'STAGE1_4'
        OR (participant_code IS NOT NULL AND
            length(btrim(participant_code)) BETWEEN 1 AND 64 AND
            lesson_video_url IS NOT NULL AND
            length(lesson_video_url) > 0 AND
            research_kit_definition_id IS NOT NULL)
      );
  `);
};
export const down = (pgm) => {
  pgm.sql("ALTER TABLE sessions DROP CONSTRAINT sessions_stage1_fields_chk;");
  pgm.sql("ALTER TABLE sessions DROP CONSTRAINT sessions_protocol_key_chk;");
  pgm.dropColumn("sessions", "research_kit_definition_id");
  pgm.dropColumn("sessions", "lesson_video_url");
  pgm.dropColumn("sessions", "participant_code");
  pgm.dropColumn("sessions", "protocol_key");
};
