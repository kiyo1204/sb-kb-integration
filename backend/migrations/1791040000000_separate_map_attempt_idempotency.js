// Preserve every existing event. A failed attempt does not reserve the success slot.
export const up = (pgm) =>
  pgm.sql(`
  DROP INDEX research_events_map_idempotency_uq;
  CREATE UNIQUE INDEX research_events_map_success_idempotency_uq
    ON research_events(map_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND outcome='SUCCESS';
  CREATE UNIQUE INDEX research_events_map_attempt_idempotency_uq
    ON research_events(map_id, idempotency_key, outcome)
    WHERE idempotency_key IS NOT NULL AND outcome<>'SUCCESS';
`);
export const down = () => {
  throw new Error(
    "Successful retries and their earlier attempt records must be retained",
  );
};
