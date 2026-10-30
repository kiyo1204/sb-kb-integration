export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE map_history_boundaries (
      map_id uuid PRIMARY KEY REFERENCES maps(id) ON DELETE RESTRICT,
      legacy_count bigint NOT NULL CHECK (legacy_count >= 0),
      legacy_last_id uuid REFERENCES map_operation_logs(id) ON DELETE RESTRICT,
      boundary_snapshot jsonb NOT NULL CHECK (jsonb_typeof(boundary_snapshot) = 'object'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK ((legacy_count = 0 AND legacy_last_id IS NULL) OR (legacy_count > 0 AND legacy_last_id IS NOT NULL))
    );
    CREATE FUNCTION validate_map_history_boundary() RETURNS trigger AS $$
    DECLARE actual_count bigint; actual_max bigint; actual_min bigint; actual_last uuid;
    BEGIN
      PERFORM 1 FROM maps WHERE id = NEW.map_id FOR UPDATE;
      SELECT count(*), coalesce(max(sequence_number), 0), coalesce(min(sequence_number), 0) INTO actual_count, actual_max, actual_min
        FROM map_operation_logs WHERE map_id = NEW.map_id;
      SELECT id INTO actual_last FROM map_operation_logs WHERE map_id = NEW.map_id ORDER BY sequence_number DESC LIMIT 1;
      IF NEW.legacy_count <> actual_count OR actual_count <> actual_max OR (actual_count > 0 AND actual_min <> 1)
        OR NEW.legacy_last_id IS DISTINCT FROM actual_last
        OR NEW.boundary_snapshot->>'mapId' IS DISTINCT FROM NEW.map_id::text THEN
        RAISE EXCEPTION 'Map history boundary does not match legacy history' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER map_history_boundary_validate BEFORE INSERT ON map_history_boundaries
      FOR EACH ROW EXECUTE FUNCTION validate_map_history_boundary();
    CREATE FUNCTION reject_map_history_boundary_change() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Map history boundaries cannot be changed or removed' USING ERRCODE = '23514';
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER map_history_boundary_immutable BEFORE UPDATE OR DELETE ON map_history_boundaries
      FOR EACH ROW EXECUTE FUNCTION reject_map_history_boundary_change();
    CREATE FUNCTION reject_legacy_map_writes_after_boundary() RETURNS trigger AS $$
    BEGIN
      PERFORM 1 FROM maps WHERE id = NEW.map_id FOR UPDATE;
      IF EXISTS (SELECT 1 FROM map_history_boundaries WHERE map_id = NEW.map_id) THEN
        RAISE EXCEPTION 'Legacy map history is frozen after the event boundary' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER map_operation_logs_boundary_guard BEFORE INSERT ON map_operation_logs
      FOR EACH ROW EXECUTE FUNCTION reject_legacy_map_writes_after_boundary();
  `);
};
export const down = () => { throw new Error("Map history boundaries cannot be removed safely"); };
