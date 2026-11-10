/** R05 storage is separate from participant Sessions and research events. */
export const up = (pgm) =>
  pgm.sql(`
CREATE TABLE r05_test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_version_id uuid NOT NULL REFERENCES material_catalog_versions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE r05_test_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_run_id uuid NOT NULL REFERENCES r05_test_runs(id) ON DELETE CASCADE,
  map_kind text NOT NULL CHECK (map_kind IN ('SB', 'KB', 'INTEGRATION')),
  state jsonb NOT NULL,
  UNIQUE (test_run_id, map_kind)
);

CREATE TABLE r05_test_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_map_id uuid NOT NULL REFERENCES r05_test_maps(id) ON DELETE CASCADE,
  sequence_number bigint NOT NULL CHECK (sequence_number > 0),
  operation jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (test_map_id, sequence_number)
);

-- The acceptance record intentionally has no FK to the disposable test run:
-- deleting its maps/history must not erase the completed-material record.
CREATE TABLE r05_submission_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_run_id uuid NOT NULL UNIQUE,
  material_version_id uuid NOT NULL REFERENCES material_catalog_versions(id) ON DELETE RESTRICT,
  submission_kind text NOT NULL CHECK (submission_kind IN ('MANUAL', 'AUTOMATIC')),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION r05_acceptance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='r05_acceptance_immutable';
END $$;
CREATE TRIGGER r05_acceptance_immutable BEFORE UPDATE OR DELETE ON r05_submission_acceptances
  FOR EACH ROW EXECUTE FUNCTION r05_acceptance_immutable();
`);

export const down = () => {
  throw new Error("Preserve R05 records; disable R05 and roll forward");
};
