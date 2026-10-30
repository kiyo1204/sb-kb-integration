export const up = (pgm) => {
  for (const table of ["research_proposition_evaluations", "research_reflection_notes"]) {
    pgm.addColumn(table, { event_id: { type: "uuid", references: "research_events", onDelete: "RESTRICT" } });
    pgm.sql(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_one_history_ref_chk CHECK (operation_log_id IS NULL OR event_id IS NULL)`);
    pgm.createIndex(table, "event_id");
  }
  pgm.sql(`ALTER TABLE research_proposition_evaluations DROP CONSTRAINT research_evaluation_source_chk;
    ALTER TABLE research_proposition_evaluations ADD CONSTRAINT research_evaluation_source_chk CHECK (
      (snapshot_side = 'CURRENT' AND operation_log_id IS NULL AND event_id IS NULL)
      OR (snapshot_side IN ('BEFORE','AFTER') AND num_nonnulls(operation_log_id, event_id) = 1)
    )`);
};
export const down = (pgm) => {
  pgm.sql(`ALTER TABLE research_proposition_evaluations DROP CONSTRAINT research_evaluation_source_chk;
    ALTER TABLE research_proposition_evaluations ADD CONSTRAINT research_evaluation_source_chk CHECK (
      (snapshot_side = 'CURRENT' AND operation_log_id IS NULL)
      OR (snapshot_side IN ('BEFORE','AFTER') AND operation_log_id IS NOT NULL)
    )`);
  for (const table of ["research_reflection_notes", "research_proposition_evaluations"]) {
    pgm.dropIndex(table, "event_id");
    pgm.sql(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_one_history_ref_chk`);
    pgm.dropColumn(table, "event_id");
  }
};
