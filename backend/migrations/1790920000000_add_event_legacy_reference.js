export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE research_events ADD COLUMN related_legacy_operation_log_id uuid REFERENCES map_operation_logs(id) ON DELETE RESTRICT;
    ALTER TABLE research_events ADD COLUMN idempotency_key uuid;
    ALTER TABLE research_events ADD CONSTRAINT research_events_related_source_check CHECK (related_event_id IS NULL OR related_legacy_operation_log_id IS NULL);
    ALTER TABLE research_events ADD CONSTRAINT research_events_idempotency_map_check CHECK (idempotency_key IS NULL OR map_id IS NOT NULL);
    CREATE UNIQUE INDEX research_events_map_idempotency_uq ON research_events(map_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  `);
};
export const down = () => { throw new Error("Event references cannot be removed without losing history"); };
