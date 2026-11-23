-- Review candidate for 950b0be plus the legacy-session lock migration / 51 migrations. See production-db-preparation.md.
-- Operations review required before apply. Default mode verifies without persistent writes.
-- psql -X -v expected_database=<verified DB> [-v apply_acl=1] -f production-app-acl-51-review.sql
\set ON_ERROR_STOP on
\if :{?expected_database}
\else
  \echo 'expected_database is required'
  SELECT 1/0;
\endif
SELECT current_database() = :'expected_database' AS database_matches \gset
\if :database_matches
\else
  \echo 'unexpected database'
  SELECT 1/0;
\endif
\if :{?apply_acl}
\else
  \set apply_acl 0
\endif

BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
\set expected_migration_count 51
\ir migration-history-compare-950b0be.sql
CREATE TEMP TABLE expected_relation (
    relation regclass PRIMARY KEY,
    read_columns text,
    insert_columns text,
    update_columns text,
    can_delete boolean NOT NULL
) ON COMMIT DROP;
INSERT INTO expected_relation VALUES
  ('public.assessment_answers', '*', 'session_id,stage_id,question_id,answer', 'answer,updated_at', true),
  ('public.assessment_questions', '*', 'session_id,category,prompt,display_order', 'category,prompt,display_order,updated_at', true),
  ('public.client_delivery_reports', '*', 'session_id,client_id,report_sequence,pending,retrying,acknowledged,capacity_lost,expired_lost,rejected_lost,storage_lost,attempts,last_response', 'report_sequence,pending,retrying,acknowledged,capacity_lost,expired_lost,rejected_lost,storage_lost,attempts,last_response,received_at', true),
  ('public.client_event_receipts', '*', 'session_id,client_id,event_key,client_sequence,request_hash,event_id,sequence_number', NULL, true),
  ('public.concept_provenance', '*', 'id,target_concept_id,source_concept_id,relation_type,created_at', NULL, true),
  ('public.concepts', '*', 'id,map_id,label,position_x,position_y,merged_into_concept_id', 'label,position_x,position_y,merged_into_concept_id', true),
  ('public.experiment_access_audit', 'session_id,actor_type,action', 'action,run_id,session_id,actor_type,http_status,outcome,reason,reason_code', NULL, false),
  ('public.experiment_access_operations', '*', 'request_key,action,run_id,session_id,request_hash,result', NULL, false),
  ('public.experiment_asset_locks', 'map_id,revision', 'map_id', 'revision', false),
  ('public.experiment_client_candidates', '*', 'session_id,client_hash,credential_generation', NULL, false),
  ('public.experiment_end_audit', 'run_id', 'run_id,http_status,outcome,reason_code', NULL, false),
  ('public.experiment_end_receipts', '*', 'request_key,run_id,ended_at', NULL, false),
  ('public.experiment_material_seeds', '*', 'version_id,kit_concept_item_id', NULL, false),
  ('public.experiment_material_versions', '*', 'request_key,request_hash,title,video_ref,sb_instructions,kb_instructions,integration_instructions,kit_id,integration_seconds', NULL, false),
  ('public.experiment_participant_access', '*', 'session_id,code_hash', 'code_hash,credential_generation,device_generation,active_client_id', false),
  ('public.experiment_retired_credentials', 'token_hash,session_id,credential_generation', 'token_hash,session_id,credential_generation', NULL, false),
  ('public.experiment_run_audit', NULL, 'action,target_id,http_status,outcome,reason,reason_code', NULL, false),
  ('public.experiment_run_catalog', '*', 'run_id,catalog_version_id,name,request_hash', NULL, false),
  ('public.experiment_run_sessions', '*', 'session_id,run_id,request_key,request_hash', NULL, false),
  ('public.experiment_runs', '*', 'request_key,request_hash,material_version_id,planned_participants', 'state,started_at,ended_at', false),
  ('public.experiment_session_withdrawal_audit', NULL, 'run_id,session_id,http_status,outcome,reason_code', NULL, false),
  ('public.experiment_session_withdrawals', '*', 'session_id,request_key', NULL, false),
  ('public.experiment_start_audit', NULL, 'run_id,http_status,outcome,reason_code', NULL, false),
  ('public.experiment_start_receipts', '*', 'request_key,run_id,started_at', NULL, false),
  ('public.explanation_responses', '*', NULL, NULL, true),
  ('public.kit_concept_items', '*', 'kit_definition_id,source_concept_id', 'id', false),
  ('public.kit_definitions', '*', 'goal_map_id,name', 'id', false),
  ('public.kit_link_items', '*', 'kit_definition_id,source_link_id', NULL, false),
  ('public.link_provenance', '*', 'id,target_link_id,source_link_id,relation_type,created_at', NULL, true),
  ('public.links', '*', 'id,map_id,source_concept_id,target_concept_id,label,label_position_x,label_position_y', 'source_concept_id,target_concept_id,label,label_position_x,label_position_y', true),
  ('public.map_history_boundaries', '*', 'map_id,legacy_count,legacy_last_id,boundary_snapshot', NULL, true),
  ('public.map_initial_snapshots', '*', 'map_id,snapshot_version,snapshot', NULL, false),
  ('public.map_operation_logs', '*', 'map_id,operation_type,target_type,target_id,before,after,sequence_number,client_timestamp,related_operation_log_id,idempotency_key', NULL, true),
  ('public.maps', '*', 'type,status,title,session_stage_id,based_on_map_id,kit_definition_id', 'status,submitted_at,auto_submitted_at,kit_definition_id', true),
  ('public.material_catalog_audit', NULL, 'action,target_id,http_status,outcome,reason,reason_code', NULL, false),
  ('public.material_catalog_requests', '*', 'request_key,action,request_hash,version_id,result', NULL, false),
  ('public.material_catalog_series', 'id', 'id', 'id', false),
  ('public.material_catalog_versions', '*', 'series_id,version_number,body,base_version_id', 'body,edit_revision,state,foundation_version_id,completed_at', false),
  ('public.operation_receipts', '*', 'principal_scope,operation_key,request_hash,result', NULL, true),
  ('public.pgmigrations', 'name', NULL, NULL, false),
  ('public.r05_execution', '*', 'test_run_id,execution_id,phase', 'integration_started_at,phase,revision,last_check', false),
  ('public.r05_execution_audit', '*', 'test_run_id,action,http_status,outcome,reason_code', NULL, false),
  ('public.r05_operation_receipts', '*', 'request_key,request_hash,test_run_id,result', NULL, false),
  ('public.r05_storage_audit', NULL, 'action,test_run_id,material_version_id', NULL, false),
  ('public.r05_storage_requests', '*', 'request_key,request_hash,result', NULL, false),
  ('public.r05_submission_acceptances', 'material_version_id,test_run_id,submission_kind,accepted_at', 'test_run_id,material_version_id,submission_kind,accepted_at', NULL, false),
  ('public.r05_test_history', '*', 'id,test_map_id,sequence_number,operation', NULL, false),
  ('public.r05_test_maps', '*', 'id,test_run_id,map_kind,state,initial_state', 'state,submitted_at,submission_kind', false),
  ('public.r05_test_runs', '*', 'material_version_id', 'id', true),
  ('public.research_deletion_receipts', 'id', 'session_count', NULL, false),
  ('public.research_event_counters', '*', 'session_id,next_sequence', 'next_sequence', true),
  ('public.research_events', '*', 'event_id,schema_version,session_id,stage_id,map_id,participant_code,study_group,activity,actor_type,event_type,target_type,target_id,outcome,reason_code,sequence_number,client_timestamp,client_time_quality,related_event_id,before_state,after_state,before_quality,after_quality,details,related_legacy_operation_log_id,idempotency_key,audit_dedup_key', NULL, true),
  ('public.research_global_event_counter', 'id,next_sequence', 'id,next_sequence', 'next_sequence', false),
  ('public.research_proposition_evaluations', '*', 'session_id,map_id,link_id,operation_log_id,event_id,snapshot_side,subject_snapshot,evaluator_code,category,rationale', NULL, true),
  ('public.research_reflection_notes', '*', 'session_id,map_id,operation_log_id,event_id,link_id,reported_by_code,note_text', NULL, true),
  ('public.research_session_ids', '*', NULL, NULL, false),
  ('public.seeded_map_concepts', '*', 'concept_id,session_id,kit_concept_item_id', NULL, true),
  ('public.session_seed_concepts', '*', 'session_id,kit_concept_item_id', NULL, true),
  ('public.session_stages', '*', 'session_id,stage_type,order_index', 'status,started_at,completed_at', true),
  ('public.sessions', '*', 'protocol_key,participant_code,lesson_video_url,research_kit_definition_id,study_group,group_activity_seconds', 'status,started_at,completed_at,learner_access_token_hash', true),
  ('public.survey_answers', '*', 'session_id,stage_id,question_id,answer', NULL, true),
  ('public.survey_questions', '*', 'id,session_id,kind,prompt,required,display_order,config', NULL, true),
  ('research_identity.deletion_authorizations', 'transaction_id,map_id', 'transaction_id,map_id', NULL, true),
  ('research_identity.device_deletions', 'token_hash,client_hash', 'token_hash,client_hash,acknowledged', 'acknowledged', false),
  ('research_identity.membership', 'session_id,participant_id', 'session_id,participant_id', NULL, true),
  ('research_identity.participants', 'id', 'study_id', NULL, true),
  ('research_identity.revocations', 'token_hash,queue_key', 'token_hash,queue_key,receipt_id', NULL, false);

CREATE TEMP TABLE expected_routine (
    routine regprocedure PRIMARY KEY,
    can_execute boolean NOT NULL
) ON COMMIT DROP;
INSERT INTO expected_routine VALUES
  ('public.assessment_event_state_valid(jsonb,uuid)', true),
  ('public.experiment_access_no_truncate()', false),
  ('public.experiment_access_retirement()', false),
  ('public.experiment_access_validate()', false),
  ('public.experiment_assert_running(uuid)', true),
  ('public.experiment_asset_is_frozen(uuid)', true),
  ('public.experiment_check_session()', false),
  ('public.experiment_client_validate()', false),
  ('public.experiment_end_write_guard()', false),
  ('public.experiment_immutable()', false),
  ('public.experiment_lock_asset(uuid)', true),
  ('public.experiment_lock_row_guard()', false),
  ('public.experiment_membership_validate()', false),
  ('public.experiment_no_map()', false),
  ('public.experiment_no_truncate()', false),
  ('public.experiment_protect_asset()', false),
  ('public.experiment_require_seeds()', false),
  ('public.experiment_run_catalog_validate()', false),
  ('public.experiment_run_management_no_truncate()', false),
  ('public.experiment_run_transition()', false),
  ('public.experiment_session_guard()', false),
  ('public.experiment_session_is_foundation(uuid)', true),
  ('public.experiment_session_seed_guard()', false),
  ('public.experiment_stage_guard()', false),
  ('public.experiment_validate_seed()', false),
  ('public.experiment_validate_session_withdrawal()', false),
  ('public.experiment_validate_version()', false),
  ('public.experiment_withdrawal_block_access_update()', false),
  ('public.experiment_withdrawal_prevent_claim()', false),
  ('public.lock_map_initial_snapshots_for_deletion()', true),
  ('public.map_event_state_v5_valid(jsonb,uuid)', true),
  ('public.material_catalog_kit_available(uuid)', true),
  ('public.material_catalog_no_truncate()', false),
  ('public.material_catalog_validate()', false),
  ('public.protect_seeded_concept()', false),
  ('public.r05_acceptance_guard()', false),
  ('public.r05_acceptance_immutable()', false),
  ('public.r05_run_guard()', false),
  ('public.reject_legacy_map_writes_after_boundary()', false),
  ('public.reject_map_history_boundary_change()', false),
  ('research_identity.assign()', false),
  ('public.set_concept_updated_at()', false),
  ('public.set_link_updated_at()', false),
  ('public.survey_state_v7_valid(jsonb,uuid)', true),
  ('public.validate_map_history_boundary()', false);

\if :apply_acl
  -- Revoke only schema-specific defaults; global defaults are checked below and stop this transaction.
  ALTER DEFAULT PRIVILEGES FOR ROLE sbkb_prod_migrator IN SCHEMA public
    REVOKE SELECT ON TABLES FROM sbkb_prod_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE sbkb_prod_migrator IN SCHEMA public
    REVOKE USAGE ON SEQUENCES FROM sbkb_prod_app;

  -- Database TEMP is used by the R05 matcher on connection-local tables.
  SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO sbkb_prod_app', current_database()) \gexec
  GRANT USAGE ON SCHEMA public, research_identity TO sbkb_prod_app;

  SELECT format('GRANT %s%s ON TABLE %s TO sbkb_prod_app',
                privilege,
                CASE WHEN columns = '*' THEN '' ELSE
                  ' (' || (SELECT string_agg(quote_ident(col), ', ' ORDER BY position)
                           FROM unnest(string_to_array(columns, ',')) WITH ORDINALITY AS c(col, position)) || ')'
                END,
                relation)
  FROM expected_relation
  CROSS JOIN LATERAL (VALUES ('SELECT', read_columns), ('INSERT', insert_columns),
                             ('UPDATE', update_columns),
                             ('DELETE', CASE WHEN can_delete THEN '*' END)) AS g(privilege, columns)
  WHERE columns IS NOT NULL
  ORDER BY relation::text, privilege
  \gexec

  -- Trigger entry points execute through the installed triggers. Nested calls
  -- and CHECK expressions run according to their own function ACLs.
  SELECT format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', routine)
    FROM expected_routine ORDER BY routine::text
  \gexec
  SELECT format('GRANT EXECUTE ON FUNCTION %s TO sbkb_prod_app', routine)
    FROM expected_routine WHERE can_execute ORDER BY routine::text
  \gexec
\endif

CREATE TEMP TABLE acl_mismatch (item text) ON COMMIT DROP;

-- Compare effective permissions, so inheritance, ownership and PUBLIC grants
-- cannot make a forbidden privilege invisible.
INSERT INTO acl_mismatch
SELECT format('%I.%I %s', n.nspname, c.relname, p.privilege)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN expected_relation e ON e.relation = c.oid
CROSS JOIN LATERAL (
  VALUES ('SELECT', coalesce(e.read_columns = '*', false)),
         ('INSERT', false), ('UPDATE', false), ('DELETE', coalesce(e.can_delete, false)),
         ('TRUNCATE', false), ('REFERENCES', false), ('TRIGGER', false), ('MAINTAIN', false)
) AS p(privilege, allowed)
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  AND (has_table_privilege('sbkb_prod_app', c.oid, p.privilege) <> p.allowed
       OR has_table_privilege('sbkb_prod_app', c.oid, p.privilege || ' WITH GRANT OPTION'));

INSERT INTO acl_mismatch
SELECT format('%I.%I.%I %s', n.nspname, c.relname, a.attname, p.privilege)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN expected_relation e ON e.relation = c.oid
CROSS JOIN LATERAL (
  VALUES ('SELECT', e.read_columns), ('INSERT', e.insert_columns),
         ('UPDATE', e.update_columns), ('REFERENCES', NULL)
) AS p(privilege, columns)
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  AND (has_column_privilege('sbkb_prod_app', c.oid, a.attnum, p.privilege)
       <> coalesce(p.columns = '*' OR a.attname = ANY(string_to_array(p.columns, ',')), false)
       OR has_column_privilege('sbkb_prod_app', c.oid, a.attnum, p.privilege || ' WITH GRANT OPTION'));

INSERT INTO acl_mismatch
SELECT format('%I.%I sequence', n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname !~ '^pg_'
  AND CASE WHEN c.relkind = 'S'
      THEN has_sequence_privilege('sbkb_prod_app', c.oid, 'USAGE,SELECT,UPDATE')
      ELSE false END;

INSERT INTO acl_mismatch
SELECT format('%s EXECUTE', p.oid::regprocedure)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN expected_routine e ON e.routine = p.oid
WHERE n.nspname IN ('public', 'research_identity')
  AND (has_function_privilege('sbkb_prod_app', p.oid, 'EXECUTE') <> coalesce(e.can_execute, false)
       OR has_function_privilege('sbkb_prod_app', p.oid, 'EXECUTE WITH GRANT OPTION'));

INSERT INTO acl_mismatch
SELECT 'app role attributes or role memberships'
WHERE EXISTS (
  SELECT FROM pg_roles r
  WHERE r.rolname = 'sbkb_prod_app'
    AND (NOT r.rolcanlogin OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb
         OR r.rolreplication OR r.rolbypassrls
         OR EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid))
);

INSERT INTO acl_mismatch
SELECT 'database CONNECT/TEMP or CREATE'
WHERE NOT has_database_privilege('sbkb_prod_app', current_database(), 'CONNECT')
   OR NOT has_database_privilege('sbkb_prod_app', current_database(), 'TEMPORARY')
   OR has_database_privilege('sbkb_prod_app', current_database(),
                             'CREATE,CONNECT WITH GRANT OPTION,TEMPORARY WITH GRANT OPTION')
   OR has_database_privilege('sbkb_prod_migrator', current_database(), 'CREATE');

INSERT INTO acl_mismatch
SELECT format('schema %I', nspname)
FROM pg_namespace
WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
  AND (has_schema_privilege('sbkb_prod_app', oid, 'CREATE,USAGE WITH GRANT OPTION')
       OR has_schema_privilege('sbkb_prod_app', oid, 'USAGE') <> (nspname IN ('public', 'research_identity')));

INSERT INTO acl_mismatch
SELECT 'migrator default privileges on tables or sequences'
WHERE EXISTS (
  SELECT
  FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclrole = 'sbkb_prod_migrator'::regrole AND d.defaclobjtype IN ('r', 'S')
    AND a.grantee IN (0, 'sbkb_prod_app'::regrole)
);


INSERT INTO acl_mismatch
SELECT 'snapshot lock helper definition or ownership'
WHERE NOT EXISTS (
  SELECT FROM pg_proc p
  JOIN pg_class c ON c.oid = 'public.map_initial_snapshots'::regclass
  WHERE p.oid = 'public.lock_map_initial_snapshots_for_deletion()'::regprocedure
    AND p.prosecdef
    AND p.proowner = c.relowner AND p.proowner = 'sbkb_prod_migrator'::regrole
    AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
    AND btrim(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) =
        'BEGIN LOCK TABLE ONLY public.map_initial_snapshots IN EXCLUSIVE MODE; END;'
    AND NOT EXISTS (
      SELECT FROM aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    )
);

TABLE acl_mismatch;
SELECT NOT EXISTS (SELECT FROM acl_mismatch) AS acl_matches \gset
\if :acl_matches
  COMMIT;
  \echo 'ACL_CHECK=PASS'
\else
  ROLLBACK;
  SELECT 1/0;
\endif
