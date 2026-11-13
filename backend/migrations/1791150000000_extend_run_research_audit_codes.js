/** Add research-read failure codes without rewriting existing audit records. */
export const up = (pgm) => pgm.sql(`
ALTER TABLE experiment_run_audit DROP CONSTRAINT experiment_run_audit_reason_code_check;
ALTER TABLE experiment_run_audit ADD CONSTRAINT experiment_run_audit_reason_code_check
 CHECK(reason_code IN ('ok','not_found','run_invalid_request','run_material_unavailable','run_sensitive_text','run_request_conflict','run_storage_unavailable','safety_budget_exceeded','safety_lookup_unavailable','research_data_inconsistent','research_unavailable'));
`);
export const down = () => {throw new Error("Preserve research audit records; disable the route and roll forward");};
