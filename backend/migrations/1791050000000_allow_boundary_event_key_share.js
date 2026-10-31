export const up = (pgm) => {
  // Keep the installed boundary validation intact; change only its non-key lock.
  // Existing boundary rows, frozen legacy logs and events are not rewritten.
  pgm.sql(`
    DO $$
    DECLARE definition text;
    BEGIN
      definition := pg_get_functiondef('public.validate_map_history_boundary()'::regprocedure);
      IF position('PERFORM 1 FROM maps WHERE id = NEW.map_id FOR UPDATE;' in definition) = 0 THEN
        RAISE EXCEPTION 'unexpected_map_history_boundary_lock';
      END IF;
      EXECUTE replace(definition,
        'PERFORM 1 FROM maps WHERE id = NEW.map_id FOR UPDATE;',
        'PERFORM 1 FROM maps WHERE id = NEW.map_id FOR NO KEY UPDATE;');
    END $$;
  `);
};

export const down = () => {
  throw new Error("Do not restore the boundary/event foreign-key deadlock");
};
