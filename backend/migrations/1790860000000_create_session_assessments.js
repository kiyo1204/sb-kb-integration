export const up = (pgm) => {
  pgm.createTable("assessment_questions", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    session_id: { type: "uuid", notNull: true, references: "sessions", onDelete: "RESTRICT" },
    category: { type: "text", notNull: true },
    prompt: { type: "text", notNull: true },
    display_order: { type: "integer", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("assessment_questions", "assessment_questions_values_chk", { check: "category IN ('DESCRIPTION', 'RETENTION', 'TRANSFER') AND length(btrim(prompt)) > 0 AND display_order >= 0" });
  pgm.addConstraint("assessment_questions", "assessment_questions_session_id_id_uq", { unique: ["session_id", "id"] });
  pgm.createTable("assessment_answers", {
    session_id: { type: "uuid", notNull: true, references: "sessions", onDelete: "RESTRICT" },
    stage_id: { type: "uuid", notNull: true, references: "session_stages", onDelete: "RESTRICT" },
    question_id: { type: "uuid", notNull: true },
    answer: { type: "text", notNull: true, default: "" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("assessment_answers", "assessment_answers_pk", { primaryKey: ["stage_id", "question_id"] });
  pgm.sql(`ALTER TABLE assessment_answers ADD CONSTRAINT assessment_answers_question_session_fk
    FOREIGN KEY (session_id, question_id) REFERENCES assessment_questions(session_id, id) ON DELETE RESTRICT`);
  pgm.createIndex("assessment_questions", ["session_id", "display_order"]);
  pgm.createIndex("assessment_answers", ["session_id", "stage_id"]);
};

export const down = (pgm) => {
  pgm.dropTable("assessment_answers");
  pgm.dropTable("assessment_questions");
};
