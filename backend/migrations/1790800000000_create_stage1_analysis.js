export const up = (pgm) => {
  pgm.createTable("research_proposition_evaluations", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    session_id: { type: "uuid", notNull: true, references: "sessions", onDelete: "RESTRICT" },
    map_id: { type: "uuid", notNull: true, references: "maps", onDelete: "RESTRICT" },
    link_id: { type: "uuid", notNull: true },
    operation_log_id: { type: "uuid", references: "map_operation_logs", onDelete: "RESTRICT" },
    snapshot_side: { type: "text", notNull: true },
    subject_snapshot: { type: "jsonb", notNull: true },
    evaluator_code: { type: "text", notNull: true },
    category: { type: "text", notNull: true },
    rationale: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.sql(`ALTER TABLE research_proposition_evaluations
    ADD CONSTRAINT research_evaluation_category_chk CHECK (category IN ('U','I','P','V')),
    ADD CONSTRAINT research_evaluation_snapshot_side_chk CHECK (snapshot_side IN ('CURRENT','BEFORE','AFTER')),
    ADD CONSTRAINT research_evaluation_source_chk CHECK (
      (snapshot_side = 'CURRENT' AND operation_log_id IS NULL)
      OR (snapshot_side IN ('BEFORE','AFTER') AND operation_log_id IS NOT NULL)
    )`);
  pgm.createIndex("research_proposition_evaluations", ["session_id","map_id","link_id"]);
  pgm.createTable("research_reflection_notes", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    session_id: { type: "uuid", notNull: true, references: "sessions", onDelete: "RESTRICT" },
    map_id: { type: "uuid", references: "maps", onDelete: "RESTRICT" },
    operation_log_id: { type: "uuid", references: "map_operation_logs", onDelete: "RESTRICT" },
    link_id: { type: "uuid" },
    reported_by_code: { type: "text", notNull: true },
    note_text: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("research_reflection_notes", ["session_id", "created_at"]);
};
export const down = (pgm) => {
  pgm.dropTable("research_reflection_notes");
  pgm.dropTable("research_proposition_evaluations");
};
