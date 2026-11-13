/** Additive guards. Never rewrite 179112 or associate research rows. */
export const up = (pgm) =>
  pgm.sql(`
CREATE UNIQUE INDEX r05_one_live_run_per_version ON r05_test_runs(material_version_id);
CREATE UNIQUE INDEX r05_one_acceptance_per_version ON r05_submission_acceptances(material_version_id);
ALTER TABLE r05_test_maps ADD COLUMN submitted_at timestamptz;
ALTER TABLE r05_test_maps ADD COLUMN submission_kind text CHECK(submission_kind IN ('MANUAL','AUTOMATIC'));
ALTER TABLE r05_test_maps ADD CONSTRAINT r05_submission_pair CHECK((submitted_at IS NULL)=(submission_kind IS NULL));
CREATE TABLE r05_storage_requests(request_key uuid PRIMARY KEY,request_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE r05_storage_audit(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),action text NOT NULL CHECK(action IN ('CREATE','DELETE')),test_run_id uuid NOT NULL,material_version_id uuid NOT NULL REFERENCES material_catalog_versions,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER r05_request_immutable BEFORE UPDATE OR DELETE ON r05_storage_requests FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
CREATE TRIGGER r05_audit_immutable BEFORE UPDATE OR DELETE ON r05_storage_audit FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
CREATE FUNCTION r05_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='r05_run_immutable';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('r05-version:'||NEW.material_version_id::text,0));
 IF NOT EXISTS(SELECT 1 FROM material_catalog_versions WHERE id=NEW.material_version_id AND state='PUBLISHED') OR EXISTS(SELECT 1 FROM r05_submission_acceptances WHERE material_version_id=NEW.material_version_id) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='r05_material_unavailable';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER r05_run_guard BEFORE INSERT OR UPDATE ON r05_test_runs FOR EACH ROW EXECUTE FUNCTION r05_run_guard();
CREATE FUNCTION r05_acceptance_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM r05_test_runs r JOIN r05_test_maps m ON m.test_run_id=r.id WHERE r.id=NEW.test_run_id AND r.material_version_id=NEW.material_version_id AND m.map_kind='INTEGRATION' AND m.submitted_at=NEW.accepted_at AND m.submission_kind=NEW.submission_kind) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='r05_submission_not_accepted';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER r05_acceptance_guard BEFORE INSERT ON r05_submission_acceptances FOR EACH ROW EXECUTE FUNCTION r05_acceptance_guard();
`);
export const down = () => {
  throw new Error("Preserve R05 records; disable R05 and roll forward");
};
