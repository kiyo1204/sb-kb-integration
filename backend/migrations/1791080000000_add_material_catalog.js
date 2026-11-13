/** Additive R03/R04 catalog. Existing material versions and research rows are untouched. */
export const up = (pgm) =>
  pgm.sql(`
CREATE TABLE material_catalog_series(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE material_catalog_versions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 series_id uuid NOT NULL REFERENCES material_catalog_series ON DELETE RESTRICT,
 version_number integer NOT NULL CHECK(version_number>0),
 edit_revision integer NOT NULL DEFAULT 1 CHECK(edit_revision>0),
 state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','PUBLISHED')),
 body jsonb NOT NULL,
 base_version_id uuid REFERENCES material_catalog_versions ON DELETE RESTRICT,
 foundation_version_id uuid UNIQUE REFERENCES experiment_material_versions ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 UNIQUE(series_id,version_number),
 CHECK((state='DRAFT' AND foundation_version_id IS NULL AND completed_at IS NULL) OR
       (state='PUBLISHED' AND foundation_version_id IS NOT NULL AND completed_at IS NOT NULL)));
CREATE UNIQUE INDEX material_catalog_one_draft ON material_catalog_versions(series_id) WHERE state='DRAFT';
-- Draft resource IDs are advisory selections, not ownership. Stale selections
-- must not prevent editing/deleting otherwise unused Goal/Kit resources.
-- Publication validates them and creates the real immutable foundation FKs.
CREATE TABLE material_catalog_requests(
 request_key uuid PRIMARY KEY, action text NOT NULL CHECK(action IN ('CREATE','SAVE','PUBLISH','NEXT')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 version_id uuid NOT NULL REFERENCES material_catalog_versions ON DELETE RESTRICT,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
-- Administrative material operations stay out of participant research events.
-- No free text, credentials or exception details are accepted here.
CREATE TABLE material_catalog_audit(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 action text NOT NULL CHECK(action IN ('CREATE','SAVE','CHECK','PUBLISH','NEXT','READ','LIST','ASSETS')),
 target_id uuid, actor_type text NOT NULL DEFAULT 'RESEARCHER' CHECK(actor_type='RESEARCHER'),
 http_status integer NOT NULL CHECK(http_status BETWEEN 200 AND 599),
 outcome text NOT NULL CHECK(outcome IN ('SUCCESS','REJECTED','FAILURE')),
 reason text CHECK(reason IN ('VALIDATION','CONFLICT','SERVER')),
 reason_code text NOT NULL CHECK(reason_code IN ('ok','not_found','material_invalid_request','material_not_ready','material_sensitive_text','material_revision_conflict','material_immutable','material_draft_exists','material_asset_conflict','material_storage_unavailable','safety_budget_exceeded','safety_lookup_unavailable')),
 server_timestamp timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((http_status<400 AND outcome='SUCCESS' AND reason IS NULL) OR
       (http_status>=400 AND http_status<500 AND outcome='REJECTED' AND reason IN ('VALIDATION','CONFLICT')) OR
       (http_status>=500 AND outcome='FAILURE' AND reason='SERVER')));
CREATE FUNCTION material_catalog_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b jsonb;v record;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='material_immutable'; END IF;
 b=NEW.body;
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR
 NOT b ?& ARRAY['title','researcherDescription','videoRef','sbInstructions','kbInstructions','integrationInstructions','kitId','seedConceptItemIds','integrationSeconds'] OR
 (SELECT count(*) FROM jsonb_object_keys(b))<>9 OR
 EXISTS(SELECT 1 FROM jsonb_each(b) e WHERE e.key IN ('title','researcherDescription','videoRef','sbInstructions','kbInstructions','integrationInstructions') AND jsonb_typeof(e.value)<>'string') OR
 length(b->>'title')>120 OR length(b->>'videoRef')>2048 OR
 EXISTS(SELECT 1 FROM jsonb_each_text(b) e WHERE e.key IN ('researcherDescription','sbInstructions','kbInstructions','integrationInstructions') AND length(e.value)>10000) OR
 (b->'kitId'<>'null'::jsonb AND (jsonb_typeof(b->'kitId')<>'string' OR b->>'kitId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')) OR
 jsonb_typeof(b->'seedConceptItemIds') IS DISTINCT FROM 'array' OR
 (b->'integrationSeconds'<>'null'::jsonb AND (jsonb_typeof(b->'integrationSeconds')<>'number' OR b->>'integrationSeconds' !~ '^[1-9][0-9]{0,9}$' OR (b->>'integrationSeconds')::numeric>2147483647)) THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='material_invalid_body';END IF;
 IF jsonb_array_length(b->'seedConceptItemIds')>1000 OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(b->'seedConceptItemIds') x WHERE jsonb_typeof(x)<>'string' OR x#>>'{}' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') OR
 (SELECT count(*)<>count(DISTINCT lower(x)) FROM jsonb_array_elements_text(b->'seedConceptItemIds') x) THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='material_invalid_body';END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.state='PUBLISHED' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='material_immutable'; END IF;
  IF NEW.id<>OLD.id OR NEW.series_id<>OLD.series_id OR NEW.version_number<>OLD.version_number OR NEW.base_version_id IS DISTINCT FROM OLD.base_version_id OR NEW.created_at<>OLD.created_at OR NEW.edit_revision<>OLD.edit_revision+1 THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='material_revision_conflict';END IF;
  NEW.updated_at=clock_timestamp();
 ELSE
  NEW.created_at=clock_timestamp();NEW.updated_at=NEW.created_at;
 END IF;
 IF NEW.base_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM material_catalog_versions x WHERE x.id=NEW.base_version_id AND x.series_id=NEW.series_id AND x.state='PUBLISHED' AND x.version_number<NEW.version_number) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='material_invalid_base';END IF;
 IF NEW.state='PUBLISHED' THEN
  SELECT * INTO v FROM experiment_material_versions WHERE id=NEW.foundation_version_id;
  IF v.id IS NULL OR b->>'title'<>v.title OR b->>'videoRef'<>v.video_ref OR b->>'sbInstructions'<>v.sb_instructions OR b->>'kbInstructions'<>v.kb_instructions OR b->>'integrationInstructions'<>v.integration_instructions OR (b->>'kitId')::uuid IS DISTINCT FROM v.kit_id OR (b->>'integrationSeconds')::integer IS DISTINCT FROM v.integration_seconds OR
  EXISTS(SELECT x::uuid FROM jsonb_array_elements_text(b->'seedConceptItemIds') x EXCEPT SELECT kit_concept_item_id FROM experiment_material_seeds WHERE version_id=v.id) OR
  EXISTS(SELECT kit_concept_item_id FROM experiment_material_seeds WHERE version_id=v.id EXCEPT SELECT x::uuid FROM jsonb_array_elements_text(b->'seedConceptItemIds') x) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='material_foundation_mismatch';END IF;
  NEW.completed_at=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER material_catalog_validate BEFORE INSERT OR UPDATE OR DELETE ON material_catalog_versions FOR EACH ROW EXECUTE FUNCTION material_catalog_validate();
CREATE TRIGGER material_catalog_series_immutable BEFORE UPDATE OR DELETE ON material_catalog_series FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
CREATE TRIGGER material_catalog_request_immutable BEFORE UPDATE OR DELETE ON material_catalog_requests FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
CREATE TRIGGER material_catalog_audit_immutable BEFORE UPDATE OR DELETE ON material_catalog_audit FOR EACH ROW EXECUTE FUNCTION experiment_immutable();
CREATE FUNCTION material_catalog_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM material_catalog_versions) OR EXISTS(SELECT 1 FROM material_catalog_audit) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='material_immutable';END IF;RETURN NULL;
END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['material_catalog_series','material_catalog_versions','material_catalog_requests','material_catalog_audit'] LOOP
 EXECUTE format('CREATE TRIGGER material_catalog_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION material_catalog_no_truncate()',t);
END LOOP;END $$;
CREATE FUNCTION material_catalog_kit_available(target uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM kit_definitions k JOIN maps m ON m.id=k.goal_map_id WHERE k.id=target AND m.type='GOAL'
 AND EXISTS(SELECT 1 FROM concepts c WHERE c.map_id=m.id AND c.merged_into_concept_id IS NULL)
 AND NOT EXISTS(SELECT 1 FROM concepts c WHERE c.map_id=m.id AND c.merged_into_concept_id IS NULL AND NOT EXISTS(SELECT 1 FROM kit_concept_items i WHERE i.kit_definition_id=k.id AND i.source_concept_id=c.id))
 AND NOT EXISTS(SELECT 1 FROM kit_concept_items i JOIN concepts c ON c.id=i.source_concept_id WHERE i.kit_definition_id=k.id AND (c.map_id<>m.id OR c.merged_into_concept_id IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM links l WHERE l.map_id=m.id AND NOT EXISTS(SELECT 1 FROM kit_link_items i WHERE i.kit_definition_id=k.id AND i.source_link_id=l.id))
 AND NOT EXISTS(SELECT 1 FROM kit_link_items i JOIN links l ON l.id=i.source_link_id JOIN concepts a ON a.id=l.source_concept_id JOIN concepts b ON b.id=l.target_concept_id WHERE i.kit_definition_id=k.id AND (l.map_id<>m.id OR a.map_id<>m.id OR b.map_id<>m.id OR a.merged_into_concept_id IS NOT NULL OR b.merged_into_concept_id IS NOT NULL)))
$$;
`);
export const down = () => {
  throw new Error(
    "Preserve material catalog data; disable writes and roll forward",
  );
};
