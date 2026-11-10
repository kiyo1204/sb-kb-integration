/** R05 execution remains independent of participant and research tables. */
export const up = (pgm) =>
  pgm.sql(`
CREATE TABLE r05_execution(test_run_id uuid PRIMARY KEY REFERENCES r05_test_runs ON DELETE CASCADE, execution_id uuid NOT NULL, phase text NOT NULL CHECK(phase IN ('LESSON','SB','KB','INTEGRATION','COMPLETE','INTERRUPTED')), revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), integration_started_at timestamptz, last_check text);
ALTER TABLE r05_test_maps ADD COLUMN initial_state jsonb;
CREATE TABLE r05_operation_receipts(request_key uuid PRIMARY KEY,request_hash text NOT NULL,test_run_id uuid NOT NULL REFERENCES r05_test_runs ON DELETE CASCADE,result jsonb NOT NULL);
CREATE TABLE r05_execution_audit(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),test_run_id uuid,action text NOT NULL,http_status integer NOT NULL,outcome text NOT NULL,reason_code text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER r05_execution_audit_immutable BEFORE UPDATE OR DELETE ON r05_execution_audit FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
`);
export const down = () => {
  throw new Error("Preserve R05 execution records; disable and roll forward");
};
