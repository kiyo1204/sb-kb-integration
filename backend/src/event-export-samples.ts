import {
  EXPORT_VERSION,
  parseFilters,
  csvRows,
  commonColumns,
  detailColumns,
  type ExportEvent,
} from "./event-export-contract.js";
import { csvLine } from "./csv.js";
import { dataDictionary } from "./event-export-dictionary.js";
const sid = "11111111-1111-4111-8111-111111111111",
  exp = "22222222-2222-4222-8222-222222222222",
  map = "33333333-3333-4333-8333-333333333333",
  stage = "44444444-4444-4444-8444-444444444444",
  concept = "55555555-5555-4555-8555-555555555555",
  question = "66666666-6666-4666-8666-666666666666";
const priorStage = "44444444-4444-4444-8444-444444444445",
  assessmentStage = "44444444-4444-4444-8444-444444444446",
  expMap = "77777777-7777-4777-8777-777777777777",
  expStage = "88888888-8888-4888-8888-888888888888";
const legacy = "legacy:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function event(n: number, patch: Partial<ExportEvent>): ExportEvent {
  return {
    feedback_match:null,
    event_id: "00000000-0000-4000-8000-" + String(n).padStart(12, "0"),
    source_format: "EVENT",
    schema_version: 1,
    session_id: sid,
    learner_id: "P-99999999-9999-4999-8999-999999999991",
    study_group: "CONTROL",
    activity: "LESSON",
    stage_id: stage,
    map_id: null,
    actor_type: "LEARNER",
    event_type: "VIDEO_PLAY",
    target_type: "VIDEO",
    target_id: null,
    outcome: "SUCCESS",
    reason_code: null,
    sequence_number: String(n),
    sequence_scope: "SESSION",
    client_timestamp: null,
    client_time_quality: "MISSING",
    server_timestamp: new Date(
      Date.parse("2026-01-01T00:00:00Z") + n * 1000,
    ).toISOString(),
    related_event_id: null,
    related_legacy_operation_log_id: null,
    before_quality: "MISSING",
    after_quality: "MISSING",
    payload_status: "NO_PAYLOAD",
    boundary_status: "NOT_APPLICABLE",
    legacy_boundary_count: null,
    legacy_boundary_last_id: null,
    before: null,
    after: null,
    details: {},
    stage_started_at: "2026-01-01T00:00:00.000Z",
    server_elapsed_ms: n * 1000,
    elapsed_quality: "COMPUTED_SERVER_DIFFERENCE",
    ...patch,
  };
}
const before = {
  snapshotVersion: 1,
  mapId: map,
  mapType: "PRIOR",
  basedOnMapId: null,
  kitDefinitionId: null,
  concepts: [
    {
      id: concept,
      mapId: map,
      label: "練習用の部品A",
      positionX: 10,
      positionY: 20,
      mergedIntoConceptId: null,
      provenance: [],
    },
  ],
  links: [],
};
const after = {
  ...before,
  concepts: [{ ...before.concepts[0], label: "練習用の部品A改" }],
};
const mapPatch = {
  schema_version: 2,
  stage_id: priorStage,
  map_id: map,
  activity: "PRIOR_MAP",
  target_type: "MAP",
  target_id: map,
  legacy_boundary_count: "1",
  legacy_boundary_last_id: legacy.slice(7),
  boundary_status: "AFTER_LEGACY_BOUNDARY",
};
export const sampleEvents: ExportEvent[] = [
  event(0, {
    event_id: legacy,
    source_format: "LEGACY",
    schema_version: null,
    map_id: map,
    stage_id: priorStage,
    activity: "PRIOR_MAP",
    actor_type: "UNKNOWN",
    event_type: "ADD_CONCEPT",
    target_type: "CONCEPT",
    target_id: concept,
    outcome: "UNKNOWN",
    sequence_number: "1",
    sequence_scope: "MAP",
    client_time_quality: "UNKNOWN",
    before_quality: "UNKNOWN",
    after_quality: "UNKNOWN",
    after: {
      id: concept,
      mapId: map,
      label: "練習用の部品A",
      positionX: 10,
      positionY: 20,
    },
    payload_status: "EXPORTED",
    boundary_status: "WITHIN_LEGACY_BOUNDARY",
    legacy_boundary_count: "1",
    legacy_boundary_last_id: legacy.slice(7),
  }),
  event(1, {
    event_type: "VIDEO_SEEK",
    details: { fromSeconds: 3, toSeconds: 8 },
    payload_status: "EXPORTED",
    client_timestamp: "2026-01-01T00:00:01.000Z",
    client_time_quality: "OBSERVED",
  }),
  event(2, {
    ...mapPatch,
    event_type: "EDIT_CONCEPT",
    target_type: "CONCEPT",
    target_id: concept,
    before,
    after,
    before_quality: "OBSERVED",
    after_quality: "OBSERVED",
    payload_status: "EXPORTED",
  }),
  event(3, {
    ...mapPatch,
    event_type: "MAP_SUBMIT",
    before: after,
    after,
    before_quality: "OBSERVED",
    after_quality: "OBSERVED",
    payload_status: "EXPORTED",
  }),
  event(4, {
    ...mapPatch,
    event_type: "ADD_LINK",
    target_type: "LINK",
    target_id: null,
    outcome: "REJECTED",
    reason_code: "VALIDATION",
  }),
  event(5, {
    ...mapPatch,
    event_type: "ADD_LINK",
    target_type: "LINK",
    target_id: null,
    outcome: "CANCELLED",
    reason_code: "USER_CANCELLED",
  }),
  event(6, {
    event_type: "STAGE_PAUSE",
    target_type: "STAGE",
    target_id: stage,
    outcome: "UNKNOWN",
    reason_code: "UNKNOWN",
  }),
  event(7, {
    schema_version: 3,
    stage_id: assessmentStage,
    event_type: "ASSESSMENT_EDIT",
    target_type: "ASSESSMENT",
    target_id: question,
    activity: "PRE_ASSESSMENT",
    before: { questionId: question, answer: null },
    after: { questionId: question, answer: "=2+2\n練習用の記述です。" },
    before_quality: "OBSERVED",
    after_quality: "OBSERVED",
    payload_status: "EXPORTED",
  }),
  event(8, {
    schema_version: 3,
    stage_id: assessmentStage,
    event_type: "ASSESSMENT_SUBMIT",
    target_type: "ASSESSMENT",
    target_id: assessmentStage,
    activity: "PRE_ASSESSMENT",
  }),
  event(9, {
    schema_version: 4,
    event_type: "RESEARCH_ANALYSIS_VIEW",
    target_type: "SESSION",
    target_id: sid,
    actor_type: "RESEARCHER",
    activity: null,
    stage_id: null,
    stage_started_at: null,
    server_elapsed_ms: null,
    elapsed_quality: "MISSING",
    client_time_quality: "NOT_APPLICABLE",
    before_quality: "NOT_APPLICABLE",
    after_quality: "NOT_APPLICABLE",
  }),
  event(10, {
    schema_version: 2,
    stage_id: expStage,
    session_id: exp,
    learner_id: "P-99999999-9999-4999-8999-999999999992",
    study_group: "EXPERIMENTAL",
    activity: "INTEGRATION_MAP",
    event_type: "MAP_AUTO_SUBMIT",
    target_type: "MAP",
    map_id: expMap,
    target_id: expMap,
    actor_type: "SYSTEM",
    sequence_number: "1",
    before: { ...before, mapId: expMap, mapType: "INTEGRATION", concepts: [] },
    after: { ...before, mapId: expMap, mapType: "INTEGRATION", concepts: [] },
    before_quality: "OBSERVED",
    after_quality: "OBSERVED",
    payload_status: "EXPORTED",
    boundary_status: "AFTER_LEGACY_BOUNDARY",
    legacy_boundary_count: "0",
  }),
  event(11, {
    schema_version: 4,
    session_id: null,
    learner_id: null,
    study_group: null,
    activity: null,
    stage_id: null,
    event_type: "SESSION_CREATE",
    target_type: "SESSION",
    actor_type: "RESEARCHER",
    outcome: "FAILURE",
    reason_code: "SERVER",
    sequence_number: "1",
    sequence_scope: "GLOBAL",
    client_time_quality: "NOT_APPLICABLE",
    before_quality: "NOT_APPLICABLE",
    after_quality: "NOT_APPLICABLE",
    stage_started_at: null,
    server_elapsed_ms: null,
    elapsed_quality: "MISSING",
  }),
  event(12,{
    ...mapPatch,schema_version:5,event_type:"MOVE_LINK",target_type:"LINK",target_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
    before:{...after,links:[{id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",mapId:map,label:"練習用の関係",sourceConceptId:concept,targetConceptId:concept,provenance:[],labelPositionX:10,labelPositionY:20}]},
    after:{...after,links:[{id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",mapId:map,label:"練習用の関係",sourceConceptId:concept,targetConceptId:concept,provenance:[],labelPositionX:30,labelPositionY:40}]},before_quality:"OBSERVED",after_quality:"OBSERVED",payload_status:"EXPORTED",
  }),
  ...([false,true,"REJECTED","FAILURE"] as const).map((result,index)=>event(13+index,{
    schema_version:6,event_type:"FEEDBACK_CHECK",target_type:"FEEDBACK",map_id:"77777777-7777-4777-8777-777777777778",target_id:"77777777-7777-4777-8777-777777777778",stage_id:"44444444-4444-4444-8444-444444444447",activity:"KB_MAP",
    outcome:typeof result==="boolean"?"SUCCESS":result,reason_code:typeof result==="boolean"?null:result==="REJECTED"?"VALIDATION":"SERVER",
    payload_status:typeof result==="boolean"?"EXPORTED":"NO_PAYLOAD",details:typeof result==="boolean"?{matched:result}:{},feedback_match:typeof result==="boolean"?result:null,client_time_quality:"NOT_APPLICABLE",before_quality:"NOT_APPLICABLE",after_quality:"NOT_APPLICABLE",
  })),

];
export function sampleFiles() {
  const files: Record<string, string> = {},
    filters = parseFilters({})!,
    snapshot = "2026-01-01T00:01:00.000Z",
    id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  files["events.json"] =
    JSON.stringify(
      {
        export_schema_version: EXPORT_VERSION,
        export_id: id,
        snapshot_at: snapshot,
        filters,
        events: sampleEvents,
        event_count: sampleEvents.length,
        payload_warning_count: 0,
        boundary_warning_count: 0,
      },
      null,
      2,
    ) + "\n";
  const counts: Record<string, number> = {};
  for (const [name, cols] of Object.entries({
    "events.csv": commonColumns,
    ...detailColumns,
  })) {
    const selected = sampleEvents.flatMap((e) => {
      const row = csvRows(e)[name];
      return row ? [row] : [];
    });
    counts[name] = selected.length;
    files[name] =
      "\uFEFF" +
      cols.join(",") +
      "\r\n" +
      selected.map((row) => csvLine(row, cols)).join("");
  }
  files["data-dictionary.md"] = dataDictionary();
  files["manifest.json"] =
    JSON.stringify(
      {
        exportId: id,
        exportSchemaVersion: EXPORT_VERSION,
        snapshotAt: snapshot,
        expiresAt: "2026-01-01T00:16:00.000Z",
        eventCount: sampleEvents.length,
        filters,
        files: Object.entries(files).map(([name, text]) => ({
          name,
          rows:
            name === "events.json"
              ? sampleEvents.length
              : (counts[name] ?? null),
          bytes: Buffer.byteLength(text),
        })),
        payloadWarnings: 0,
        boundaryWarnings: 0,
        auditSaved: null,
      },
      null,
      2,
    ) + "\n";
  return files;
}
