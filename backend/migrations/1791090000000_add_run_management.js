/** R06/R07 only. No existing runs or Sessions are converted/associated. */
export const up = (pgm) =>
  pgm.sql(`
CREATE TABLE experiment_run_catalog(
 run_id uuid PRIMARY KEY REFERENCES experiment_runs ON DELETE RESTRICT,
 catalog_version_id uuid NOT NULL REFERENCES material_catalog_versions ON DELETE RESTRICT,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'));
CREATE FUNCTION experiment_run_catalog_validate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM experiment_runs r JOIN material_catalog_versions c ON c.foundation_version_id=r.material_version_id
 WHERE r.id=NEW.run_id AND c.id=NEW.catalog_version_id AND c.state='PUBLISHED' AND r.state='PREPARING') THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='run_material_mismatch'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER experiment_run_catalog_validate BEFORE INSERT ON experiment_run_catalog FOR EACH ROW EXECUTE FUNCTION experiment_run_catalog_validate();
CREATE TRIGGER experiment_run_catalog_immutable BEFORE UPDATE OR DELETE ON experiment_run_catalog FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
CREATE TABLE experiment_run_audit(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 action text NOT NULL CHECK(action IN ('CREATE','READ','LIST','MATERIALS')),
 target_id uuid,actor_type text NOT NULL DEFAULT 'RESEARCHER' CHECK(actor_type='RESEARCHER'),
 http_status integer NOT NULL CHECK(http_status BETWEEN 200 AND 599),
 outcome text NOT NULL CHECK(outcome IN ('SUCCESS','REJECTED','FAILURE')),
 reason text CHECK(reason IN ('VALIDATION','CONFLICT','SERVER')),
 reason_code text NOT NULL CHECK(reason_code IN ('ok','not_found','run_invalid_request','run_material_unavailable','run_sensitive_text','run_request_conflict','run_storage_unavailable','safety_budget_exceeded','safety_lookup_unavailable')),
 server_timestamp timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((http_status<400 AND outcome='SUCCESS' AND reason IS NULL) OR
 (http_status>=400 AND http_status<500 AND outcome='REJECTED' AND reason IN ('VALIDATION','CONFLICT')) OR
 (http_status>=500 AND outcome='FAILURE' AND reason='SERVER')));
CREATE TRIGGER experiment_run_audit_immutable BEFORE UPDATE OR DELETE ON experiment_run_audit FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
CREATE FUNCTION experiment_run_management_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM experiment_run_catalog) OR EXISTS(SELECT 1 FROM experiment_run_audit) THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='run_management_immutable';END IF;RETURN NULL;
END $$;
CREATE TRIGGER experiment_run_catalog_no_truncate BEFORE TRUNCATE ON experiment_run_catalog FOR EACH STATEMENT EXECUTE FUNCTION experiment_run_management_no_truncate();
CREATE TRIGGER experiment_run_audit_no_truncate BEFORE TRUNCATE ON experiment_run_audit FOR EACH STATEMENT EXECUTE FUNCTION experiment_run_management_no_truncate();
`);
export const down = () => {
  throw new Error("Preserve run management data; stop writes and roll forward");
};
