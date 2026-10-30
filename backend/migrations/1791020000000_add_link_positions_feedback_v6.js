export const up = pgm => { pgm.sql(`
ALTER TABLE links ADD COLUMN label_position_x double precision, ADD COLUMN label_position_y double precision;
ALTER TABLE links ADD CONSTRAINT links_label_position_pair CHECK ((label_position_x IS NULL AND label_position_y IS NULL) OR (label_position_x IS NOT NULL AND label_position_y IS NOT NULL AND label_position_x BETWEEN -10000000 AND 10000000 AND label_position_y BETWEEN -10000000 AND 10000000));
ALTER TABLE research_events DROP CONSTRAINT research_events_schema_version_check;
ALTER TABLE research_events ADD CONSTRAINT research_events_schema_version_check CHECK(schema_version IN(1,2,3,4,5,6));
CREATE FUNCTION map_event_state_v5_valid(s jsonb, target uuid) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE l jsonb;
BEGIN
 IF s IS NULL OR NOT(s ?& ARRAY['snapshotVersion','mapId','mapType','basedOnMapId','kitDefinitionId','concepts','links']) OR jsonb_typeof(s)<>'object' OR s->'snapshotVersion'<>'1'::jsonb OR s->>'mapId'<>target::text OR jsonb_typeof(s->'concepts')<>'array' OR jsonb_typeof(s->'links')<>'array' OR octet_length(s::text)>4200000 OR jsonb_array_length(s->'concepts')>1000 OR jsonb_array_length(s->'links')>2000 THEN RETURN false; END IF;
 FOR l IN SELECT value FROM jsonb_array_elements(s->'links') LOOP
  IF jsonb_typeof(l)<>'object' OR l - ARRAY['id','mapId','label','sourceConceptId','targetConceptId','provenance','labelPositionX','labelPositionY'] <> '{}'::jsonb OR NOT(l ?& ARRAY['id','mapId','label','sourceConceptId','targetConceptId','provenance']) OR (l ? 'labelPositionX')<>(l ? 'labelPositionY') THEN RETURN false; END IF;
  IF l ? 'labelPositionX' THEN
   IF jsonb_typeof(l->'labelPositionX')<>'number' OR jsonb_typeof(l->'labelPositionY')<>'number' OR NOT((l->>'labelPositionX')::numeric BETWEEN -10000000 AND 10000000) OR NOT((l->>'labelPositionY')::numeric BETWEEN -10000000 AND 10000000) THEN RETURN false; END IF;
  END IF;
 END LOOP; RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
ALTER TABLE research_events ADD CONSTRAINT research_events_v5_shape CHECK(schema_version<>5 OR (
 map_id IS NOT NULL AND event_type IN('ADD_CONCEPT','EDIT_CONCEPT','MOVE_CONCEPT','DELETE_CONCEPT','MERGE_CONCEPT','IMPORT_KIT_CONCEPT','ADD_LINK','EDIT_LINK','MOVE_LINK','DELETE_LINK','RECONNECT_LINK','IMPORT_KIT_LINK','UNDO','REDO','MAP_SAVE','MAP_KIT_ASSIGN','MAP_SUBMIT','MAP_AUTO_SUBMIT') AND
 (before_state IS NULL OR map_event_state_v5_valid(before_state,map_id)) AND (after_state IS NULL OR map_event_state_v5_valid(after_state,map_id)) AND (outcome<>'SUCCESS' OR (before_state IS NOT NULL AND after_state IS NOT NULL))
) IS TRUE);
ALTER TABLE research_events ADD CONSTRAINT research_events_move_link_version CHECK(event_type<>'MOVE_LINK' OR schema_version=5);
ALTER TABLE research_events ADD CONSTRAINT research_events_v6_shape CHECK(schema_version<>6 OR (
 event_type='FEEDBACK_CHECK' AND target_type='FEEDBACK' AND map_id IS NOT NULL AND stage_id IS NOT NULL AND target_id=map_id AND before_state IS NULL AND after_state IS NULL AND related_event_id IS NULL AND related_legacy_operation_log_id IS NULL AND idempotency_key IS NULL AND client_timestamp IS NULL AND client_time_quality='NOT_APPLICABLE' AND before_quality='NOT_APPLICABLE' AND after_quality='NOT_APPLICABLE' AND
 ((outcome='SUCCESS' AND reason_code IS NULL AND details - 'matched'='{}'::jsonb AND jsonb_typeof(details->'matched')='boolean') OR (outcome IN('REJECTED','FAILURE') AND reason_code IN('VALIDATION','PERMISSION','DEADLINE','CONFLICT','SERVER') AND details='{}'::jsonb))
) IS TRUE);
`); };
export const down = () => { throw new Error("Saved positions and event contracts must be retained"); };
