/** Additive storage only. No legacy rows are converted or associated. */
export const up = (pgm) =>
  pgm.sql(`
ALTER TABLE sessions DROP CONSTRAINT sessions_protocol_key_chk;
ALTER TABLE sessions ADD CONSTRAINT sessions_protocol_key_chk CHECK(protocol_key IN ('STANDARD_7','STAGE1_4','STAGE1_6','STAGE1_5','SBKB_INTEGRATION_V1'));
ALTER TABLE sessions ADD CONSTRAINT experiment_storage_only CHECK(protocol_key <> 'SBKB_INTEGRATION_V1' OR
 (status='NOT_STARTED' AND started_at IS NULL AND completed_at IS NULL AND learner_access_token_hash IS NULL AND study_group IS NULL AND participant_code IS NOT NULL AND length(btrim(participant_code)) BETWEEN 1 AND 64 AND research_kit_definition_id IS NOT NULL AND lesson_video_url IS NOT NULL AND group_activity_seconds>0));
CREATE TABLE experiment_asset_locks(
 map_id uuid PRIMARY KEY REFERENCES maps ON DELETE CASCADE, revision bigint NOT NULL DEFAULT 0);
CREATE TABLE experiment_material_versions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_key uuid NOT NULL UNIQUE, request_hash text NOT NULL,
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 120),
 video_ref text NOT NULL CHECK(length(video_ref) BETWEEN 1 AND 2048 AND (video_ref ~ '^https?://' OR (video_ref LIKE '/%' AND video_ref NOT LIKE '//%'))),
 sb_instructions text NOT NULL CHECK(length(btrim(sb_instructions)) BETWEEN 1 AND 10000),
 kb_instructions text NOT NULL CHECK(length(btrim(kb_instructions)) BETWEEN 1 AND 10000),
 integration_instructions text NOT NULL CHECK(length(btrim(integration_instructions)) BETWEEN 1 AND 10000),
 kit_id uuid NOT NULL REFERENCES kit_definitions ON DELETE RESTRICT,
 integration_seconds integer NOT NULL CHECK(integration_seconds>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), creation_tx bigint NOT NULL DEFAULT txid_current());
CREATE TABLE experiment_material_seeds(
 version_id uuid NOT NULL REFERENCES experiment_material_versions ON DELETE RESTRICT,
 kit_concept_item_id uuid NOT NULL REFERENCES kit_concept_items ON DELETE RESTRICT,
 PRIMARY KEY(version_id,kit_concept_item_id));
CREATE TABLE experiment_runs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_key uuid NOT NULL UNIQUE,request_hash text NOT NULL,
 material_version_id uuid NOT NULL REFERENCES experiment_material_versions ON DELETE RESTRICT,
 planned_participants integer NOT NULL CHECK(planned_participants>=0),
 state text NOT NULL DEFAULT 'PREPARING' CHECK(state='PREPARING'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE experiment_run_sessions(
 session_id uuid PRIMARY KEY REFERENCES sessions ON DELETE RESTRICT,
 run_id uuid NOT NULL REFERENCES experiment_runs ON DELETE RESTRICT,
 request_key uuid NOT NULL UNIQUE,request_hash text NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT clock_timestamp(), creation_tx bigint NOT NULL DEFAULT txid_current());
CREATE INDEX experiment_run_sessions_run_idx ON experiment_run_sessions(run_id);

-- A real write, not just an advisory lock: old REPEATABLE READ snapshots must
-- serialize/fail rather than miss a newly committed material freeze.
CREATE FUNCTION experiment_lock_asset(target uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO experiment_asset_locks(map_id) VALUES(target)
 ON CONFLICT(map_id) DO UPDATE SET revision=experiment_asset_locks.revision+1;
END $$;
CREATE FUNCTION experiment_asset_is_frozen(target uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM experiment_material_versions v JOIN kit_definitions k ON k.id=v.kit_id WHERE k.goal_map_id=target)
$$;
CREATE FUNCTION experiment_protect_asset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb;new_row jsonb;ids uuid[];item uuid;BEGIN
 IF TG_OP<>'INSERT' THEN old_row=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN new_row=to_jsonb(NEW); END IF;
 IF TG_TABLE_NAME='maps' THEN
  IF old_row->>'type'='GOAL' OR new_row->>'type'='GOAL' THEN ids=ARRAY[coalesce(old_row->>'id',new_row->>'id')::uuid]; END IF;
 ELSIF TG_TABLE_NAME IN ('concepts','links') THEN
  SELECT array_agg(id ORDER BY id) INTO ids FROM maps WHERE type='GOAL' AND id IN ((old_row->>'map_id')::uuid,(new_row->>'map_id')::uuid);
 ELSIF TG_TABLE_NAME='kit_definitions' THEN ids=ARRAY[(old_row->>'goal_map_id')::uuid,(new_row->>'goal_map_id')::uuid];
 ELSE
  SELECT array_agg(DISTINCT goal_map_id ORDER BY goal_map_id) INTO ids FROM kit_definitions WHERE id IN ((old_row->>'kit_definition_id')::uuid,(new_row->>'kit_definition_id')::uuid);
 END IF;
 FOR item IN SELECT DISTINCT x FROM unnest(ids) x WHERE x IS NOT NULL ORDER BY x LOOP
  PERFORM experiment_lock_asset(item);
  IF experiment_asset_is_frozen(item) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_asset_frozen'; END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
CREATE TRIGGER experiment_map_guard BEFORE UPDATE OR DELETE ON maps FOR EACH ROW EXECUTE FUNCTION experiment_protect_asset();
CREATE TRIGGER experiment_concept_guard BEFORE INSERT OR UPDATE OR DELETE ON concepts FOR EACH ROW EXECUTE FUNCTION experiment_protect_asset();
CREATE TRIGGER experiment_link_guard BEFORE INSERT OR UPDATE OR DELETE ON links FOR EACH ROW EXECUTE FUNCTION experiment_protect_asset();
CREATE TRIGGER experiment_kit_guard BEFORE INSERT OR UPDATE OR DELETE ON kit_definitions FOR EACH ROW EXECUTE FUNCTION experiment_protect_asset();
CREATE TRIGGER experiment_kit_concept_guard BEFORE INSERT OR UPDATE OR DELETE ON kit_concept_items FOR EACH ROW EXECUTE FUNCTION experiment_protect_asset();
CREATE TRIGGER experiment_kit_link_guard BEFORE INSERT OR UPDATE OR DELETE ON kit_link_items FOR EACH ROW EXECUTE FUNCTION experiment_protect_asset();
CREATE FUNCTION experiment_lock_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM maps WHERE id=OLD.map_id) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_lock_protected'; END IF;RETURN OLD;
 END IF;
 IF NEW.map_id<>OLD.map_id OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_lock_protected'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER experiment_lock_guard BEFORE UPDATE OR DELETE ON experiment_asset_locks FOR EACH ROW EXECUTE FUNCTION experiment_lock_row_guard();
CREATE FUNCTION experiment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_record_immutable';
END $$;
CREATE TRIGGER experiment_version_immutable BEFORE UPDATE OR DELETE ON experiment_material_versions FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
CREATE TRIGGER experiment_seeds_immutable BEFORE UPDATE OR DELETE ON experiment_material_seeds FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
CREATE TRIGGER experiment_run_immutable BEFORE UPDATE OR DELETE ON experiment_runs FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
CREATE TRIGGER experiment_membership_immutable BEFORE UPDATE OR DELETE ON experiment_run_sessions FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
CREATE FUNCTION experiment_validate_version() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE goal uuid;BEGIN
 SELECT goal_map_id INTO goal FROM kit_definitions WHERE id=NEW.kit_id;
 IF goal IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_invalid_kit'; END IF;
 PERFORM experiment_lock_asset(goal);
 IF NOT EXISTS(SELECT 1 FROM maps WHERE id=goal AND type='GOAL') OR
 NOT EXISTS(SELECT 1 FROM concepts WHERE map_id=goal AND merged_into_concept_id IS NULL) OR
 EXISTS(SELECT 1 FROM concepts c WHERE c.map_id=goal AND c.merged_into_concept_id IS NULL AND NOT EXISTS(SELECT 1 FROM kit_concept_items i WHERE i.kit_definition_id=NEW.kit_id AND i.source_concept_id=c.id)) OR
 EXISTS(SELECT 1 FROM kit_concept_items i LEFT JOIN concepts c ON c.id=i.source_concept_id WHERE i.kit_definition_id=NEW.kit_id AND (c.map_id<>goal OR c.merged_into_concept_id IS NOT NULL)) OR
 EXISTS(SELECT 1 FROM links l WHERE l.map_id=goal AND NOT EXISTS(SELECT 1 FROM kit_link_items i WHERE i.kit_definition_id=NEW.kit_id AND i.source_link_id=l.id)) OR
 EXISTS(SELECT 1 FROM kit_link_items i JOIN links l ON l.id=i.source_link_id JOIN concepts a ON a.id=l.source_concept_id JOIN concepts b ON b.id=l.target_concept_id WHERE i.kit_definition_id=NEW.kit_id AND (l.map_id<>goal OR a.map_id<>goal OR b.map_id<>goal OR a.merged_into_concept_id IS NOT NULL OR b.merged_into_concept_id IS NOT NULL)) THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_invalid_kit';END IF;
 NEW.creation_tx=txid_current();RETURN NEW;
END $$;
CREATE TRIGGER experiment_version_validate BEFORE INSERT ON experiment_material_versions FOR EACH ROW EXECUTE FUNCTION experiment_validate_version();
CREATE FUNCTION experiment_validate_seed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM experiment_material_versions v JOIN kit_concept_items i ON i.kit_definition_id=v.kit_id WHERE v.id=NEW.version_id AND i.id=NEW.kit_concept_item_id AND v.creation_tx=txid_current()) THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_invalid_seed';END IF;RETURN NEW;
END $$;
CREATE TRIGGER experiment_seed_validate BEFORE INSERT ON experiment_material_seeds FOR EACH ROW EXECUTE FUNCTION experiment_validate_seed();
CREATE FUNCTION experiment_require_seeds() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM experiment_material_seeds WHERE version_id=NEW.id) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_seed_required';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER experiment_seed_required AFTER INSERT ON experiment_material_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION experiment_require_seeds();

CREATE FUNCTION experiment_session_is_foundation(target uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM sessions WHERE id=target AND protocol_key='SBKB_INTEGRATION_V1')
$$;
CREATE FUNCTION experiment_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.protocol_key='SBKB_INTEGRATION_V1' OR (TG_OP='UPDATE' AND NEW.protocol_key='SBKB_INTEGRATION_V1') THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_storage_only';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
CREATE TRIGGER experiment_session_guard BEFORE UPDATE OR DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION experiment_session_guard();
CREATE FUNCTION experiment_stage_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (TG_OP<>'INSERT' AND experiment_session_is_foundation(OLD.session_id)) OR
 (TG_OP<>'DELETE' AND experiment_session_is_foundation(NEW.session_id) AND (TG_OP<>'INSERT' OR NEW.status<>'PENDING' OR NEW.started_at IS NOT NULL OR NEW.completed_at IS NOT NULL)) THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_storage_only';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
CREATE TRIGGER experiment_stage_guard BEFORE INSERT OR UPDATE OR DELETE ON session_stages FOR EACH ROW EXECUTE FUNCTION experiment_stage_guard();
CREATE FUNCTION experiment_no_map() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM session_stages WHERE id=NEW.session_stage_id AND experiment_session_is_foundation(session_id)) THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_storage_only';END IF;RETURN NEW;
END $$;
CREATE TRIGGER experiment_no_map BEFORE INSERT OR UPDATE ON maps FOR EACH ROW EXECUTE FUNCTION experiment_no_map();
CREATE FUNCTION experiment_check_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;expected text[];actual text[];BEGIN
 IF TG_TABLE_NAME='sessions' THEN target=NEW.id;ELSE target=NEW.session_id;END IF;
 IF NOT experiment_session_is_foundation(target) THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM sessions s JOIN experiment_run_sessions p ON p.session_id=s.id JOIN experiment_runs r ON r.id=p.run_id JOIN experiment_material_versions v ON v.id=r.material_version_id
 WHERE s.id=target AND s.research_kit_definition_id=v.kit_id AND s.lesson_video_url=v.video_ref AND s.group_activity_seconds=v.integration_seconds) THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_membership_mismatch';END IF;
 SELECT array_agg(stage_type ORDER BY order_index) INTO actual FROM session_stages WHERE session_id=target;
 IF actual IS DISTINCT FROM ARRAY['LESSON','PRIOR_MAP','KB_MAP','INTEGRATION_MAP']::text[] OR
 EXISTS(SELECT 1 FROM session_stages WHERE session_id=target AND order_index NOT BETWEEN 0 AND 3) THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_stages_mismatch';END IF;
 SELECT array_agg(x::text ORDER BY x::text) INTO expected FROM (SELECT seed.kit_concept_item_id x FROM experiment_run_sessions p JOIN experiment_runs r ON r.id=p.run_id JOIN experiment_material_seeds seed ON seed.version_id=r.material_version_id WHERE p.session_id=target) t;
 SELECT array_agg(kit_concept_item_id::text ORDER BY kit_concept_item_id::text) INTO actual FROM session_seed_concepts WHERE session_id=target;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_seeds_mismatch';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER experiment_session_complete AFTER INSERT ON sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION experiment_check_session();
CREATE CONSTRAINT TRIGGER experiment_stage_complete AFTER INSERT OR UPDATE OR DELETE ON session_stages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION experiment_check_session();
CREATE FUNCTION experiment_membership_validate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT experiment_session_is_foundation(NEW.session_id) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_membership_mismatch'; END IF;NEW.creation_tx=txid_current();RETURN NEW;
END $$;
CREATE TRIGGER experiment_membership_validate BEFORE INSERT ON experiment_run_sessions FOR EACH ROW EXECUTE FUNCTION experiment_membership_validate();
CREATE CONSTRAINT TRIGGER experiment_membership_complete AFTER INSERT ON experiment_run_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION experiment_check_session();
CREATE FUNCTION experiment_session_seed_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE target uuid;BEGIN
 target=CASE WHEN TG_OP='DELETE' THEN OLD.session_id ELSE NEW.session_id END;
 IF (TG_OP<>'INSERT' AND experiment_session_is_foundation(OLD.session_id)) OR (experiment_session_is_foundation(target) AND (TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM experiment_run_sessions WHERE session_id=target AND creation_tx=txid_current()))) THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_storage_only'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
CREATE TRIGGER experiment_session_seed_guard BEFORE INSERT OR UPDATE OR DELETE ON session_seed_concepts FOR EACH ROW EXECUTE FUNCTION experiment_session_seed_guard();
CREATE CONSTRAINT TRIGGER experiment_session_seed_complete AFTER INSERT OR UPDATE OR DELETE ON session_seed_concepts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION experiment_check_session();
CREATE FUNCTION experiment_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM experiment_material_versions) OR EXISTS(SELECT 1 FROM experiment_runs) OR EXISTS(SELECT 1 FROM sessions WHERE protocol_key='SBKB_INTEGRATION_V1') THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='experiment_truncate_protected';END IF;RETURN NULL;
END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['maps','concepts','links','kit_definitions','kit_concept_items','kit_link_items','experiment_asset_locks','experiment_material_versions','experiment_material_seeds','experiment_runs','experiment_run_sessions','sessions','session_stages','session_seed_concepts'] LOOP
 EXECUTE format('CREATE TRIGGER experiment_truncate_guard BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION experiment_no_truncate()',t);
END LOOP;END $$;
`);
export const down = () => {
  throw new Error(
    "Preserve experiment foundation data; disable writes and roll forward",
  );
};
