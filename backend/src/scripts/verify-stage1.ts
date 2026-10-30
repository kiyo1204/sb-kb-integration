import {verifyMockTestUrl} from "./mock-db.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createLearnerToken, storeLearnerToken } from "../access-control.js";
import { getSession } from "../sessions.js";
import { insertResearchEvent } from "../research-events.js";
import type { MapHistorySnapshot } from "../map-history.js";

const apiBase=process.env.API_BASE_URL ?? "http://127.0.0.1:3000";
await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const researcherToken=process.env.RESEARCHER_API_TOKEN ?? "";
assert.ok(researcherToken && researcherToken.length>=32);
let currentToken=researcherToken;
const kitId="66666666-6666-4666-8666-666666666662";
const kitConcepts=[
  "77777777-7777-4777-8777-777777777781",
  "77777777-7777-4777-8777-777777777782",
  "77777777-7777-4777-8777-777777777783",
];
const kitLinkId="88888888-8888-4888-8888-888888888882";
let authoredGoalMapId:string|null=null;

async function api<T>(path:string,status:number,method="GET",body?:unknown):Promise<T>{
  const res=await fetch(`${apiBase}/api${path}`,{
    method,headers:{Authorization:`Bearer ${currentToken}`,
      ...(body===undefined?{}:{"Content-Type":"application/json"})},
    body:body===undefined?undefined:JSON.stringify(body),
  });
  const contentType=res.headers.get("content-type")??"";
  const data:unknown=contentType.includes("json")?await res.json():await res.text();
  assert.equal(res.status,status,`${method} ${path}: ${JSON.stringify(data)}`);
  return data as T;
}
type Stage={id:string;stageType:string;status:string;mapId:string|null};
type Session={id:string;status:string;protocolKey:string;stages:Stage[];learnerAccessToken:string};

// The public creation API now creates only STAGE1_6. Keep the existing
// four-stage compatibility checks using a legacy fixture in the test database.
async function legacySession(participantCode:string):Promise<Session>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const result=await client.query<{id:string}>(
      `INSERT INTO sessions (protocol_key,participant_code,lesson_video_url,research_kit_definition_id)
       VALUES ('STAGE1_4',$1,'/lesson-test.mp4',$2::uuid) RETURNING id`,[participantCode,kitId]);
    const id=result.rows[0]!.id;
    for(const [index,type] of ["LESSON","PRIOR_MAP","KB_MAP","INTEGRATION_MAP"].entries())
      await client.query("INSERT INTO session_stages (session_id,stage_type,order_index) VALUES ($1::uuid,$2,$3)",[id,type,index]);
    const credential=createLearnerToken();
    await storeLearnerToken(client,id,credential.hash);
    const session=await getSession(client,id);
    if(!session) throw new Error("Legacy session fixture could not be loaded");
    await client.query("COMMIT");
    return {...session,learnerAccessToken:credential.token};
  }catch(error){
    await client.query("ROLLBACK").catch(()=>undefined);
    throw error;
  }finally{client.release();}
}
type MapData={
 id:string;type:string;status:string;sessionProtocolKey:string|null;
 kitDefinitionId:string|null;basedOnMapId:string|null;
 concepts:Array<{id:string;label:string;positionX:number;positionY:number}>;
 links:Array<{id:string;label:string;sourceConceptId:string;targetConceptId:string}>};
type Provenance={id:string;relationType:string;createdAt:string;
  targetConceptId?:string;sourceConceptId?:string;targetLinkId?:string;sourceLinkId?:string};
type ReplayConcept={id:string;mapId:string;label:string;positionX:number;positionY:number;
  mergedIntoConceptId:string|null;provenance:Provenance[]};
type ReplayLink={id:string;mapId:string;sourceConceptId:string;targetConceptId:string;
  label:string;provenance:Provenance[]};
type ReplayState={snapshotVersion:1;mapId:string;mapType:string;basedOnMapId:string|null;
  kitDefinitionId:string|null;concepts:ReplayConcept[];links:ReplayLink[]};
type ReplayResponse={status:string;reason:string|null;sequenceNumber:number;
  operation:{id:string;sequenceNumber:string;operationType:string;targetType:string;
    targetId:string;before:unknown;after:unknown;relatedOperationLogId:string|null;
    clientTimestamp:string|null;serverTimestamp:string}|null;
  beforeState:ReplayState|null;afterState:ReplayState|null};
type UndoRedoState={mapId:string;status:"AVAILABLE"|"UNAVAILABLE"|"PARTIAL";
  sequenceNumber:number;canUndo:boolean;canRedo:boolean;
  undoOperation:{id:string;operationType:string}|null;
  redoOperation:{id:string;operationType:string}|null;reason:string|null};
type KitBuildFeedback={configurationComplete:boolean;matched:boolean;
  concepts:{matched:number;total:number};
  relations:{matched:number;total:number};message:string};
type UndoRedoResponse={operationId:string;relatedOperationLogId:string;
  sequenceNumber:string;duplicate:boolean;state:UndoRedoState};

function canonicalHistory(state:ReplayState){
  const byId=(a:{id:string},b:{id:string})=>a.id.localeCompare(b.id);
  return {
    snapshotVersion:state.snapshotVersion,mapId:state.mapId,mapType:state.mapType,
    basedOnMapId:state.basedOnMapId,kitDefinitionId:state.kitDefinitionId,
    concepts:state.concepts.map(item=>({...item,provenance:[...item.provenance].sort(byId)}))
      .sort(byId),
    links:state.links.map(item=>({...item,provenance:[...item.provenance].sort(byId)}))
      .sort(byId),
  };
}

async function verifyMapHistory(sessionId:string,mapId:string){
  const currentEvents = await pool.query<{eventType:string}>(`SELECT event_type AS "eventType" FROM research_events WHERE map_id=$1::uuid AND schema_version IN (2,5) ORDER BY sequence_number`,[mapId]);
  if (currentEvents.rowCount) {
    const mixed = await api<{status:string;reason?:string}>(`/research/sessions/${sessionId}/maps/${mapId}/mixed-history`,200);
    assert.equal(mixed.status,"REPLAYABLE",mixed.reason);
    return currentEvents.rows.map(event=>event.eventType);
  }
  const first=await api<ReplayResponse>(
    `/research/stage1/sessions/${sessionId}/maps/${mapId}/history?sequenceNumber=0`,200);
  assert.equal(first.status,"REPLAYABLE");
  assert.equal(first.operation,null);
  assert.ok(first.beforeState&&first.afterState);
  assert.deepEqual(canonicalHistory(first.beforeState),canonicalHistory(first.afterState));
  const logs=await pool.query<{
    id:string;sequenceNumber:string;operationType:string;targetType:string;targetId:string;
    before:unknown;after:unknown;relatedOperationLogId:string|null;
    clientTimestamp:Date|null;serverTimestamp:Date;
  }>(`SELECT id,sequence_number AS "sequenceNumber",operation_type AS "operationType",
            target_type AS "targetType",target_id AS "targetId",before,after,
            related_operation_log_id AS "relatedOperationLogId",
            client_timestamp AS "clientTimestamp",server_timestamp AS "serverTimestamp"
     FROM map_operation_logs WHERE map_id=$1::uuid ORDER BY sequence_number,id`,[mapId]);
  let finalReplay:ReplayResponse=first;
  for(const log of logs.rows){
    const replay=await api<ReplayResponse>(
      `/research/stage1/sessions/${sessionId}/maps/${mapId}/history?sequenceNumber=${log.sequenceNumber}`,200);
    assert.equal(replay.status,"REPLAYABLE",`${log.operationType} at #${log.sequenceNumber}: ${replay.reason}`);
    assert.equal(replay.operation?.id,log.id);
    assert.equal(replay.operation?.sequenceNumber,log.sequenceNumber);
    assert.equal(replay.operation?.relatedOperationLogId,log.relatedOperationLogId);
    assert.equal(replay.operation?.clientTimestamp,
      log.clientTimestamp===null?null:log.clientTimestamp.toISOString());
    assert.equal(replay.operation?.serverTimestamp,log.serverTimestamp.toISOString());
    assert.deepEqual(replay.operation?.before,log.before);
    assert.deepEqual(replay.operation?.after,log.after);
    assert.ok(replay.beforeState&&replay.afterState);
    const before=replay.beforeState;
    const after=replay.afterState;
    if(log.operationType==="ADD_CONCEPT"||log.operationType==="IMPORT_KIT_CONCEPT"){
      assert.equal(before.concepts.some(item=>item.id===log.targetId),false);
      assert.equal(after.concepts.some(item=>item.id===log.targetId),true);
    }else if(log.operationType==="EDIT_CONCEPT"||log.operationType==="MOVE_CONCEPT"){
      const old=before.concepts.find(item=>item.id===log.targetId);
      const next=after.concepts.find(item=>item.id===log.targetId);
      assert.ok(old&&next);
      if(log.operationType==="MOVE_CONCEPT")
        assert.notDeepEqual([old.positionX,old.positionY],[next.positionX,next.positionY]);
    }else if(log.operationType==="DELETE_CONCEPT"){
      const snapshot=log.before as {concept?:{id:string};incidentLinks?:Array<{id:string}>};
      assert.ok(before.concepts.some(item=>item.id===snapshot.concept?.id));
      assert.equal(after.concepts.some(item=>item.id===log.targetId),false);
      for(const link of snapshot.incidentLinks??[])
        assert.equal(after.links.some(item=>item.id===link.id),false);
    }else if(log.operationType==="ADD_LINK"||log.operationType==="IMPORT_KIT_LINK"){
      assert.equal(before.links.some(item=>item.id===log.targetId),false);
      assert.equal(after.links.some(item=>item.id===log.targetId),true);
    }else if(log.operationType==="EDIT_LINK"){
      const old=before.links.find(item=>item.id===log.targetId);
      const next=after.links.find(item=>item.id===log.targetId);
      assert.ok(old&&next);
      assert.notEqual(old.label,next.label);
    }else if(log.operationType==="RECONNECT_LINK"){
      const old=before.links.find(item=>item.id===log.targetId);
      const next=after.links.find(item=>item.id===log.targetId);
      assert.ok(old&&next);
      assert.equal(old.id,next.id);
      assert.notDeepEqual([old.sourceConceptId,old.targetConceptId],
        [next.sourceConceptId,next.targetConceptId]);
    }else if(log.operationType==="DELETE_LINK"){
      assert.equal(before.links.some(item=>item.id===log.targetId),true);
      assert.equal(after.links.some(item=>item.id===log.targetId),false);
    }else if(log.operationType==="MERGE_CONCEPT"){
      const sources=(log.before as {concepts:Array<{id:string}>}).concepts;
      assert.ok(after.concepts.some(item=>item.id===log.targetId));
      for(const source of sources)
        assert.equal(after.concepts.find(item=>item.id===source.id)?.mergedIntoConceptId,log.targetId);
    }else if(log.operationType==="UNDO"||log.operationType==="REDO"){
      const beforeAction=log.before as {relatedOperationLogId:string;relatedOperationType:string};
      const afterAction=log.after as {relatedOperationLogId:string;relatedOperationType:string};
      assert.ok(log.relatedOperationLogId);
      assert.equal(beforeAction.relatedOperationLogId,log.relatedOperationLogId);
      assert.equal(afterAction.relatedOperationLogId,log.relatedOperationLogId);
      assert.equal(beforeAction.relatedOperationType,afterAction.relatedOperationType);
      assert.ok(replay.operation?.relatedOperationLogId);
    }
    finalReplay=replay;
  }
  assert.ok(finalReplay.afterState);
  const mapRow=await pool.query<{type:string;basedOnMapId:string|null;kitDefinitionId:string|null}>(
    `SELECT type,based_on_map_id AS "basedOnMapId",
            kit_definition_id AS "kitDefinitionId" FROM maps WHERE id=$1::uuid`,[mapId]);
  const conceptRows=await pool.query<Omit<ReplayConcept,"provenance">>(
    `SELECT id,map_id AS "mapId",label,position_x AS "positionX",position_y AS "positionY",
            merged_into_concept_id AS "mergedIntoConceptId" FROM concepts WHERE map_id=$1::uuid`,[mapId]);
  const conceptIds=conceptRows.rows.map(item=>item.id);
  const conceptProvenance=conceptIds.length?await pool.query<Provenance>(
    `SELECT id,target_concept_id AS "targetConceptId",source_concept_id AS "sourceConceptId",
            relation_type AS "relationType",created_at AS "createdAt"
     FROM concept_provenance WHERE target_concept_id=ANY($1::uuid[])`,[conceptIds]):{rows:[] as Provenance[]};
  const linkRows=await pool.query<Omit<ReplayLink,"provenance">>(
    `SELECT id,map_id AS "mapId",source_concept_id AS "sourceConceptId",
            target_concept_id AS "targetConceptId",label FROM links WHERE map_id=$1::uuid`,[mapId]);
  const linkIds=linkRows.rows.map(item=>item.id);
  const linkProvenance=linkIds.length?await pool.query<Provenance>(
    `SELECT id,target_link_id AS "targetLinkId",source_link_id AS "sourceLinkId",
            relation_type AS "relationType",created_at AS "createdAt"
     FROM link_provenance WHERE target_link_id=ANY($1::uuid[])`,[linkIds]):{rows:[] as Provenance[]};
  const dbState:ReplayState={
    snapshotVersion:1,mapId,mapType:mapRow.rows[0]!.type,
    basedOnMapId:mapRow.rows[0]!.basedOnMapId,kitDefinitionId:mapRow.rows[0]!.kitDefinitionId,
    concepts:conceptRows.rows.map(item=>({ ...item,
      provenance:conceptProvenance.rows.filter(p=>p.targetConceptId===item.id)
        .map(p=>({...p,createdAt:new Date(p.createdAt).toISOString()})),
    })),
    links:linkRows.rows.map(item=>({ ...item,
      provenance:linkProvenance.rows.filter(p=>p.targetLinkId===item.id)
        .map(p=>({...p,createdAt:new Date(p.createdAt).toISOString()})),
    })),
  };
  assert.deepEqual(canonicalHistory(finalReplay.afterState),canonicalHistory(dbState),
    `Final replay state differs from Map ${mapId} in PostgreSQL.`);
  const logCount=await pool.query<{count:number}>(
    `SELECT count(*)::int AS count FROM map_operation_logs WHERE map_id=$1::uuid`,[mapId]);
  assert.equal(logCount.rows[0]?.count,logs.rows.length,
    "Read-only replay must not append or remove operation logs.");
  return logs.rows.map(item=>item.operationType);
}
async function runUndoRedo(mapId:string,action:"UNDO"|"REDO",idempotencyKey=randomUUID()){
  const state=await api<UndoRedoState>(`/maps/${mapId}/undo-redo`,200);
  assert.equal(state.status,"AVAILABLE");
  assert.equal(action==="UNDO"?state.canUndo:state.canRedo,true,
    `${action} should be available for ${mapId}`);
  const target=action==="UNDO"?state.undoOperation:state.redoOperation;
  assert.ok(target);
  const originalBefore=await pool.query<{id:string;operationType:string;before:unknown;after:unknown}>(
    `SELECT id,operation_type AS "operationType",before,after FROM map_operation_logs WHERE id=$1::uuid
     UNION ALL SELECT event_id AS id,event_type AS "operationType",before_state AS before,after_state AS after FROM research_events WHERE event_id=$1::uuid`,[target.id]);
  assert.equal(originalBefore.rowCount,1);
  const result=await api<UndoRedoResponse>(`/maps/${mapId}/undo-redo`,200,"POST",{
    action,expectedSequenceNumber:state.sequenceNumber,idempotencyKey,
    clientTimestamp:new Date().toISOString(),
  });
  assert.equal(result.relatedOperationLogId,target.id);
  assert.equal(result.state.sequenceNumber,state.sequenceNumber+1);
  assert.equal(result.duplicate,false);
  const originalAfter=await pool.query<{id:string;operationType:string;before:unknown;after:unknown}>(
    `SELECT id,operation_type AS "operationType",before,after FROM map_operation_logs WHERE id=$1::uuid
     UNION ALL SELECT event_id AS id,event_type AS "operationType",before_state AS before,after_state AS after FROM research_events WHERE event_id=$1::uuid`,[target.id]);
  assert.deepEqual(originalAfter.rows,originalBefore.rows,
    "Undo/Redo must leave the original event immutable.");
  return result;
}
function stage(s:Session,type:string){
  const result=s.stages.find(x=>x.stageType===type);
  assert.ok(result,`Missing ${type}`);return result;
}
async function startStage(s:Session,type:string){
  return api(`/session-stages/${stage(s,type).id}/start`,200,"POST",{});
}
async function run(){
  try{
    await api("/sessions",404,"POST",{});
    await api("/explanation-prompts",404);
    const authoredGoal=await api<{id:string;title:string}>(
      "/research/goal-maps",201,"POST",{title:`作成UI検証 ${randomUUID()}`});
    authoredGoalMapId=authoredGoal.id;
    assert.equal(authoredGoal.title.startsWith("作成UI検証 "),true);
    const authoredConcept=await api<{id:string}>(
      `/maps/${authoredGoal.id}/concepts`,201,"POST",{
        label:"検証概念",positionX:120,positionY:140,
      });
    const authoredTarget=await api<{id:string}>(
      `/maps/${authoredGoal.id}/concepts`,201,"POST",{
        label:"検証対象",positionX:420,positionY:260,
      });
    const authoredLink=await api<{id:string}>(
      `/maps/${authoredGoal.id}/links`,201,"POST",{
        label:"関係する",sourceConceptId:authoredConcept.id,
        targetConceptId:authoredTarget.id,
      });
    const authoredKit=await api<{id:string}>(
      `/maps/${authoredGoal.id}/kits`,201,"POST",{
        name:"作成UI検証Kit",conceptIds:[authoredConcept.id,authoredTarget.id],
        linkIds:[authoredLink.id],
      });
    const authoredGoalDetail=await api<MapData & {title:string;kitDefinitionName:string}>(
      `/maps/${authoredGoal.id}`,200);
    assert.equal(authoredGoalDetail.type,"GOAL");
    assert.equal(authoredGoalDetail.title,authoredGoal.title);
    assert.equal(authoredGoalDetail.kitDefinitionId,authoredKit.id);
    assert.equal(authoredGoalDetail.kitDefinitionName,"作成UI検証Kit");
    const goalMapList=await api<{goalMaps:Array<{id:string;kitDefinitionId:string|null}>}>(
      "/research/goal-maps",200);
    assert.ok(goalMapList.goalMaps.some(item=>
      item.id===authoredGoal.id&&item.kitDefinitionId===authoredKit.id));
    const developmentGoal=await pool.query<{id:string}>(
      `SELECT goal_map_id AS id FROM kit_definitions WHERE id=$1::uuid`,[kitId]);
    const firstGoalConcept=await pool.query<{id:string}>(
      `SELECT id FROM concepts WHERE map_id=$1::uuid AND merged_into_concept_id IS NULL
       ORDER BY id LIMIT 1`,[developmentGoal.rows[0]!.id]);
    assert.ok(firstGoalConcept.rows[0]);
    const incompleteKit=await api<{id:string}>(
      `/maps/${developmentGoal.rows[0]!.id}/kits`,201,"POST",{
        name:`テスト用部分Kit ${randomUUID()}`,
        conceptIds:[firstGoalConcept.rows[0]!.id],linkIds:[],
      });
    await api("/research/stage1/settings",200,"PUT",{minutes:10});
    await api("/research/stage1/sessions",422,"POST",{
      participantCode:"TEST-STAGE1-PARTIAL-KIT",
      videoUrl:"/lesson-test.mp4",kitDefinitionId:incompleteKit.id,studyGroup:"EXPERIMENTAL",
    });
    const retiredSessionId=randomUUID();
    await pool.query(
      "INSERT INTO sessions (id,protocol_key) VALUES ($1::uuid,'STANDARD_7')",
      [retiredSessionId],
    );
    const retiredStages=["TUTORIAL","PRE_EXPLANATION","PRIOR_MAP","LESSON","KB_MAP","INTEGRATION_MAP","POST_EXPLANATION"];
    for(const [orderIndex,stageType] of retiredStages.entries()){
      await pool.query(
        "INSERT INTO session_stages (session_id,stage_type,order_index) VALUES ($1::uuid,$2,$3)",
        [retiredSessionId,stageType,orderIndex],
      );
    }
    await api(`/sessions/${retiredSessionId}`,404);
    await api(`/sessions/${retiredSessionId}/flow`,404);
    await api(`/sessions/${retiredSessionId}/start`,404,"POST",{});
    const created=await legacySession("TEST-STAGE1");
    await api(`/session-stages/${created.stages[0]!.id}/explanation`,404);
    await api(`/session-stages/${created.stages[0]!.id}/tutorial-map`,404,"POST",{});
    const other=await legacySession("TEST-STAGE1-B");
    await api(`/sessions/${other.id}/start`,200,"POST",{});
    await startStage(other,"LESSON");
    await api(`/session-stages/${stage(other,"LESSON").id}/complete`,200,"POST",{});
    await startStage(other,"PRIOR_MAP");
    const otherMap=await api<MapData>(
      `/session-stages/${stage(other,"PRIOR_MAP").id}/prior-map`,201,"POST");
    const unauthenticated=await fetch(`${apiBase}/api/sessions/${created.id}`);
    assert.equal(unauthenticated.status,401);
    const unauthenticatedKitFeedback=await fetch(`${apiBase}/api/maps/${otherMap.id}/kit-feedback`);
    assert.equal(unauthenticatedKitFeedback.status,401);
    currentToken=other.learnerAccessToken;
    await api(`/sessions/${other.id}`,200);
    currentToken=created.learnerAccessToken;
    const me=await api<{role:string;sessionId:string}>("/me",200);
    assert.equal(me.role,"learner");
    assert.equal(me.sessionId,created.id);
    await api("/research/goal-maps",403);
    await api(`/maps/${authoredGoal.id}`,404);
    await api(`/maps/${authoredGoal.id}/concepts`,404,"POST",{
      label:"学習者の不正編集",positionX:1,positionY:1,
    });
    await api(`/sessions/${created.id}`,200);
    await api(`/sessions/${other.id}`,404);
    await api(`/maps/${otherMap.id}/undo-redo`,404);
    await api(`/maps/${otherMap.id}/submit`,404,"POST",{});
    await api(`/maps/${otherMap.id}/concepts`,404,"POST",
      {label:"不正追加",positionX:1,positionY:1});
    await api(`/maps/${otherMap.id}/kit-feedback`,404);
    await api("/maps/44444444-4444-4444-8444-444444444442",404);
    await api("/kits/66666666-6666-4666-8666-666666666661",404);
    await api(`/research/stage1/sessions/${created.id}/analysis`,403);
    await api(`/research/sessions/${created.id}/export`,403);
    await api(`/maps/${otherMap.id}/undo-redo`,404);
    const kitParts=await api<{
      goalMapId?: string; concepts:Array<{kitConceptItemId:string;sourceConceptId?:string}>;
      links:Array<{kitLinkItemId:string;sourceConceptId?:string;targetConceptId?:string}>;
    }>(`/kits/${kitId}`,200);
    assert.equal(kitParts.goalMapId,undefined);
    assert.equal(kitParts.concepts[0]?.sourceConceptId,undefined);
    assert.equal(kitParts.links[0]?.sourceConceptId,undefined);
    assert.equal(kitParts.links[0]?.targetConceptId,undefined);
    assert.equal(created.protocolKey,"STAGE1_4");
    assert.deepEqual(created.stages.map(s=>s.stageType),
      ["LESSON","PRIOR_MAP","KB_MAP","INTEGRATION_MAP"]);
    currentToken=researcherToken;
    const rotated=await api<{learnerAccessToken:string}>(
      `/research/stage1/sessions/${other.id}/learner-token`,200,"POST",{});
    assert.notEqual(rotated.learnerAccessToken,other.learnerAccessToken);
    currentToken=other.learnerAccessToken;
    await api("/me",401);
    currentToken=researcherToken;
    await api(`/research/stage1/sessions/${created.id}/analysis`,409);
    currentToken=created.learnerAccessToken;
    await api(`/sessions/${created.id}/start`,200,"POST",{});

    // Future-stage skip remains guarded.
    await api(`/session-stages/${stage(created,"PRIOR_MAP").id}/start`,409,"POST",{});
    await startStage(created,"LESSON");
    await api(`/session-stages/${stage(created,"LESSON").id}/complete`,200,"POST",{});

    await startStage(created,"PRIOR_MAP");
    const learner=await api<MapData>(
      `/session-stages/${stage(created,"PRIOR_MAP").id}/prior-map`,
      201,"POST");
    let prior=await api<MapData>(`/maps/${learner.id}`,200);
    assert.equal(prior.sessionProtocolKey,"STAGE1_4");
    assert.deepEqual(prior.concepts.map(x=>x.label),["注意"]);
    assert.equal(prior.links.length,0);
    const beforeLinkCancellation=prior;
    const beforeCancelProgress=await pool.query<{sessionStatus:string;stageStatus:string;mapStatus:string}>(
      `SELECT s.status AS "sessionStatus",st.status AS "stageStatus",m.status AS "mapStatus"
       FROM maps m JOIN session_stages st ON st.id=m.session_stage_id
       JOIN sessions s ON s.id=st.session_id WHERE m.id=$1::uuid`,[learner.id]);
    await pool.query(`CREATE FUNCTION reject_test_cancel_event() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'private cancellation trigger detail'; END; $$ LANGUAGE plpgsql`);
    await pool.query("CREATE TRIGGER reject_test_cancel_event BEFORE INSERT ON research_events FOR EACH ROW EXECUTE FUNCTION reject_test_cancel_event()");
    try {
      const failedCancellation=await fetch(`${apiBase}/api/maps/${learner.id}/operation-cancellations/ADD_LINK`,{
        method:"POST",headers:{Authorization:`Bearer ${created.learnerAccessToken}`,"Idempotency-Key":randomUUID()},
      });
      assert.equal(failedCancellation.status,500);
      const failedCancellationBody=await failedCancellation.json() as {operationOutcome:string;logSaved:boolean};
      assert.equal(failedCancellationBody.operationOutcome,"CANCELLED");assert.equal(failedCancellationBody.logSaved,false);
      assert.ok(!JSON.stringify(failedCancellationBody).includes("private cancellation trigger detail"));
      assert.equal((await pool.query("SELECT 1 FROM map_history_boundaries WHERE map_id=$1::uuid",[learner.id])).rowCount,0);
      assert.equal((await pool.query("SELECT 1 FROM research_events WHERE map_id=$1::uuid AND outcome='CANCELLED'",[learner.id])).rowCount,0);
      const afterFailedCancellation=await api<MapData>(`/maps/${learner.id}`,200);
      assert.deepEqual(afterFailedCancellation.concepts,beforeLinkCancellation.concepts);
      assert.deepEqual(afterFailedCancellation.links,beforeLinkCancellation.links);
      assert.deepEqual(await pool.query(
        `SELECT s.status AS "sessionStatus",st.status AS "stageStatus",m.status AS "mapStatus"
         FROM maps m JOIN session_stages st ON st.id=m.session_stage_id
         JOIN sessions s ON s.id=st.session_id WHERE m.id=$1::uuid`,[learner.id]),beforeCancelProgress);
    } finally {
      await pool.query("DROP TRIGGER reject_test_cancel_event ON research_events");
      await pool.query("DROP FUNCTION reject_test_cancel_event()");
    }
    const cancellationKey=randomUUID();
    const cancelledResponse=await fetch(`${apiBase}/api/maps/${learner.id}/operation-cancellations/ADD_LINK`,{
      method:"POST",headers:{Authorization:`Bearer ${created.learnerAccessToken}`,"Idempotency-Key":cancellationKey},
    });
    assert.equal(cancelledResponse.status,201);
    const cancelled=await cancelledResponse.json() as {eventId:string;operationOutcome:string;logSaved:boolean};
    assert.equal(cancelled.operationOutcome,"CANCELLED");assert.equal(cancelled.logSaved,true);
    const duplicateCancelResponse=await fetch(`${apiBase}/api/maps/${learner.id}/operation-cancellations/ADD_LINK`,{
      method:"POST",headers:{Authorization:`Bearer ${created.learnerAccessToken}`,"Idempotency-Key":cancellationKey},
    });
    assert.equal(duplicateCancelResponse.status,200);
    const duplicateCancel=await duplicateCancelResponse.json() as {eventId:string};
    assert.equal(duplicateCancel.eventId,cancelled.eventId);
    const afterLinkCancellation=await api<MapData>(`/maps/${learner.id}`,200);
    assert.deepEqual(afterLinkCancellation.concepts,beforeLinkCancellation.concepts);
    assert.deepEqual(afterLinkCancellation.links,beforeLinkCancellation.links);
    async function cancelStage1MapOperation(eventType:string,targetId?:string,targetMapId=learner.id,idempotencyKey=randomUUID()) {
      const targetPath=targetId?`/${targetId}`:"";
      const response=await fetch(`${apiBase}/api/maps/${targetMapId}/operation-cancellations/${eventType}${targetPath}`,{
        method:"POST",headers:{Authorization:`Bearer ${created.learnerAccessToken}`,"Idempotency-Key":idempotencyKey},
      });
      return {response,body:await response.json() as {eventId?:string;operationOutcome?:string;logSaved?:boolean}};
    }
    for(const [eventType,targetId] of [
      ["ADD_CONCEPT",undefined],
      ["EDIT_CONCEPT",prior.concepts[0]!.id],
      ["DELETE_CONCEPT",prior.concepts[0]!.id],
      ["MAP_SUBMIT",undefined],
    ] as const) {
      const cancelledOperation=await cancelStage1MapOperation(eventType,targetId);
      assert.equal(cancelledOperation.response.status,201,eventType);
      assert.equal(cancelledOperation.body.operationOutcome,"CANCELLED");
      assert.equal(cancelledOperation.body.logSaved,true);
      const savedCancel=await pool.query<{eventType:string;outcome:string;reasonCode:string;targetId:string|null;beforeState:unknown;afterState:unknown}>(
        `SELECT event_type AS "eventType",outcome,reason_code AS "reasonCode",target_id AS "targetId",
           before_state AS "beforeState",after_state AS "afterState"
         FROM research_events WHERE event_id=$1::uuid`,[cancelledOperation.body.eventId]);
      assert.deepEqual(savedCancel.rows[0],{
        eventType,outcome:"CANCELLED",reasonCode:"USER_CANCELLED",
        targetId:targetId??(eventType==="MAP_SUBMIT"?learner.id:null),beforeState:null,afterState:null,
      });
    }
    const submitCancelKey=randomUUID();
    const firstSubmitCancel=await cancelStage1MapOperation("MAP_SUBMIT",undefined,learner.id,submitCancelKey);
    const duplicateSubmitCancel=await cancelStage1MapOperation("MAP_SUBMIT",undefined,learner.id,submitCancelKey);
    assert.equal(firstSubmitCancel.response.status,201);
    assert.equal(duplicateSubmitCancel.response.status,200);
    assert.equal(duplicateSubmitCancel.body.eventId,firstSubmitCancel.body.eventId);
    const conflictingSubmitCancelKey=await fetch(`${apiBase}/api/maps/${learner.id}/operation-cancellations/EDIT_CONCEPT/${prior.concepts[0]!.id}`,{
      method:"POST",headers:{Authorization:`Bearer ${created.learnerAccessToken}`,"Idempotency-Key":submitCancelKey},
    });
    assert.equal(conflictingSubmitCancelKey.status,409);
    const afterOtherCancellations=await api<MapData>(`/maps/${learner.id}`,200);
    assert.deepEqual(afterOtherCancellations.concepts,beforeLinkCancellation.concepts);
    assert.deepEqual(afterOtherCancellations.links,beforeLinkCancellation.links);
    assert.equal(afterOtherCancellations.status,"DRAFT");
    assert.deepEqual(await pool.query(
      `SELECT s.status AS "sessionStatus",st.status AS "stageStatus",m.status AS "mapStatus"
       FROM maps m JOIN session_stages st ON st.id=m.session_stage_id
       JOIN sessions s ON s.id=st.session_id WHERE m.id=$1::uuid`,[learner.id]),beforeCancelProgress);
    const beforeRejectedMapOperation=await api<MapData>(`/maps/${learner.id}`,200);
    const rejectedMapOperation=await api<{operationOutcome:string;logSaved:boolean}>(
      `/maps/${learner.id}/concepts`,400,"POST",{label:"https://private.example",positionX:20,positionY:20});
    assert.equal(rejectedMapOperation.operationOutcome,"REJECTED");assert.equal(rejectedMapOperation.logSaved,true);
    const afterRejectedMapOperation=await api<MapData>(`/maps/${learner.id}`,200);
    assert.deepEqual(afterRejectedMapOperation.concepts,beforeRejectedMapOperation.concepts);
    assert.deepEqual(afterRejectedMapOperation.links,beforeRejectedMapOperation.links);
    await pool.query(`CREATE FUNCTION reject_stage1_concept_insert() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'private mutation failure detail'; END; $$ LANGUAGE plpgsql`);
    await pool.query("CREATE TRIGGER reject_stage1_concept_insert BEFORE INSERT ON concepts FOR EACH ROW EXECUTE FUNCTION reject_stage1_concept_insert()");
    try {
      const failedMapOperation=await fetch(`${apiBase}/api/maps/${learner.id}/concepts`,{
        method:"POST",headers:{Authorization:`Bearer ${created.learnerAccessToken}`,"Content-Type":"application/json"},
        body:JSON.stringify({label:"private failed input",positionX:30,positionY:30}),
      });
      assert.equal(failedMapOperation.status,500);
      const failedMapBody=await failedMapOperation.json() as {operationOutcome:string;logSaved:boolean};
      assert.equal(failedMapBody.operationOutcome,"FAILURE");assert.equal(failedMapBody.logSaved,true);
      assert.ok(!JSON.stringify(failedMapBody).includes("private mutation failure detail"));
      assert.ok(!JSON.stringify(failedMapBody).includes("private failed input"));
      const failureEvent=await pool.query<{reasonCode:string;beforeState:unknown;afterState:unknown;details:unknown}>(
        `SELECT reason_code AS "reasonCode",before_state AS "beforeState",after_state AS "afterState",details
         FROM research_events WHERE map_id=$1::uuid AND event_type='ADD_CONCEPT' AND outcome='FAILURE'`,[learner.id]);
      assert.equal(failureEvent.rowCount,1);assert.equal(failureEvent.rows[0]!.reasonCode,"SERVER");
      assert.equal(failureEvent.rows[0]!.beforeState,null);assert.equal(failureEvent.rows[0]!.afterState,null);
      assert.deepEqual(failureEvent.rows[0]!.details,{});
      const afterFailedMapOperation=await api<MapData>(`/maps/${learner.id}`,200);
      assert.deepEqual(afterFailedMapOperation.concepts,beforeRejectedMapOperation.concepts);
      assert.deepEqual(afterFailedMapOperation.links,beforeRejectedMapOperation.links);
    } finally {
      await pool.query("DROP TRIGGER reject_stage1_concept_insert ON concepts");
      await pool.query("DROP FUNCTION reject_stage1_concept_insert()");
    }
    const invalidCancelType=await fetch(`${apiBase}/api/maps/${learner.id}/operation-cancellations/SESSION_CREATE`,{
      method:"POST",headers:{Authorization:`Bearer ${created.learnerAccessToken}`},
    });
    assert.equal(invalidCancelType.status,400);
    const invalidCancelTarget=await fetch(`${apiBase}/api/maps/${learner.id}/operation-cancellations/EDIT_CONCEPT/${randomUUID()}`,{
      method:"POST",headers:{Authorization:`Bearer ${created.learnerAccessToken}`},
    });
    assert.equal(invalidCancelTarget.status,404);
    const cancelEvent=await pool.query<{eventType:string;outcome:string;reasonCode:string;actorType:string;targetId:string|null;beforeState:unknown;afterState:unknown}>(
      `SELECT event_type AS "eventType",outcome,reason_code AS "reasonCode",actor_type AS "actorType",
         target_id AS "targetId",before_state AS "beforeState",after_state AS "afterState"
       FROM research_events WHERE event_id=$1::uuid`,[cancelled.eventId]);
    assert.deepEqual(cancelEvent.rows[0],{eventType:"ADD_LINK",outcome:"CANCELLED",reasonCode:"USER_CANCELLED",
      actorType:"LEARNER",targetId:null,beforeState:null,afterState:null});
    currentToken=researcherToken;
    const cancelReplay=await api<{status:string;reason?:string}>(
      `/research/sessions/${created.id}/maps/${learner.id}/mixed-history`,200);
    assert.equal(cancelReplay.status,"REPLAYABLE",cancelReplay.reason);
    currentToken=created.learnerAccessToken;
    const anchor=prior.concepts[0];
    const added=await api<{id:string}>(`/maps/${learner.id}/concepts`,201,"POST",
      {label:"学習者が作った概念",positionX:500,positionY:220});
    const link=await api<{id:string}>(`/maps/${learner.id}/links`,201,"POST",
      {label:"関連している",sourceConceptId:anchor.id,targetConceptId:added.id});
    const reversibleConcept=await api<{id:string}>(`/maps/${learner.id}/concepts`,201,"POST",{
      label:"可逆な概念",positionX:620,positionY:230,
    });
    await runUndoRedo(learner.id,"UNDO");
    let scratchNow=await api<MapData>(`/maps/${learner.id}`,200);
    assert.equal(scratchNow.concepts.some(item=>item.id===reversibleConcept.id),false);
    await runUndoRedo(learner.id,"REDO");
    scratchNow=await api<MapData>(`/maps/${learner.id}`,200);
    assert.equal(scratchNow.concepts.some(item=>item.id===reversibleConcept.id),true,
      "Redo restores the original Concept ID.");

    await api(`/concepts/${reversibleConcept.id}/label`,200,"PATCH",{label:"編集済み概念"});
    await runUndoRedo(learner.id,"UNDO");
    scratchNow=await api<MapData>(`/maps/${learner.id}`,200);
    assert.equal(scratchNow.concepts.find(item=>item.id===reversibleConcept.id)?.label,"可逆な概念");
    await runUndoRedo(learner.id,"REDO");

    await api(`/concepts/${reversibleConcept.id}/position`,200,"PATCH",{
      positionX:690,positionY:290,
    });
    await runUndoRedo(learner.id,"UNDO");
    scratchNow=await api<MapData>(`/maps/${learner.id}`,200);
    assert.deepEqual(
      [scratchNow.concepts.find(item=>item.id===reversibleConcept.id)?.positionX,
       scratchNow.concepts.find(item=>item.id===reversibleConcept.id)?.positionY],
      [620,230],
    );
    await runUndoRedo(learner.id,"REDO");

    const scratchReconnectTarget=await api<{id:string}>(`/maps/${learner.id}/concepts`,201,"POST",{
      label:"再接続先",positionX:850,positionY:280,
    });
    currentToken=researcherToken;
    await api(`/maps/${learner.id}/undo-redo`,200);
    await api(`/maps/${learner.id}/undo-redo`,403,"POST",{
      action:"UNDO",expectedSequenceNumber:0,idempotencyKey:randomUUID(),
    });
    currentToken=created.learnerAccessToken;
    const unauthenticatedUndo=await fetch(`${apiBase}/api/maps/${learner.id}/undo-redo`);
    assert.equal(unauthenticatedUndo.status,401);
    const reversibleLink=await api<{id:string}>(`/maps/${learner.id}/links`,201,"POST",{
      label:"変更前の関係",sourceConceptId:anchor.id,targetConceptId:reversibleConcept.id,
    });
    await runUndoRedo(learner.id,"UNDO");
    scratchNow=await api<MapData>(`/maps/${learner.id}`,200);
    assert.equal(scratchNow.links.some(item=>item.id===reversibleLink.id),false);
    await runUndoRedo(learner.id,"REDO");
    scratchNow=await api<MapData>(`/maps/${learner.id}`,200);
    assert.equal(scratchNow.links.some(item=>item.id===reversibleLink.id),true,
      "Redo restores the original Link ID.");

    await api(`/links/${reversibleLink.id}/label`,200,"PATCH",{label:"編集後の関係"});
    await runUndoRedo(learner.id,"UNDO");
    scratchNow=await api<MapData>(`/maps/${learner.id}`,200);
    assert.equal(scratchNow.links.find(item=>item.id===reversibleLink.id)?.label,"変更前の関係");
    await runUndoRedo(learner.id,"REDO");
    await api(`/links/${reversibleLink.id}/reconnect`,200,"PATCH",{
      sourceConceptId:reversibleConcept.id,targetConceptId:scratchReconnectTarget.id,
    });
    await runUndoRedo(learner.id,"UNDO");
    scratchNow=await api<MapData>(`/maps/${learner.id}`,200);
    assert.deepEqual(
      [scratchNow.links.find(item=>item.id===reversibleLink.id)?.sourceConceptId,
       scratchNow.links.find(item=>item.id===reversibleLink.id)?.targetConceptId],
      [anchor.id,reversibleConcept.id],
    );
    await runUndoRedo(learner.id,"REDO");
    await api(`/links/${reversibleLink.id}`,200,"DELETE",{});
    await runUndoRedo(learner.id,"UNDO");
    scratchNow=await api<MapData>(`/maps/${learner.id}`,200);
    assert.equal(scratchNow.links.some(item=>item.id===reversibleLink.id),true);
    await runUndoRedo(learner.id,"REDO");
    scratchNow=await api<MapData>(`/maps/${learner.id}`,200);
    assert.equal(scratchNow.links.some(item=>item.id===reversibleLink.id),false);

    const branchConcept=await api<{id:string}>(`/maps/${learner.id}/concepts`,201,"POST",{
      label:"分岐確認用",positionX:940,positionY:330,
    });
    const concurrentState=await api<UndoRedoState>(`/maps/${learner.id}/undo-redo`,200);
    const concurrentBody={action:"UNDO",expectedSequenceNumber:concurrentState.sequenceNumber,
      idempotencyKey:randomUUID(),clientTimestamp:new Date().toISOString()};
    const concurrentResults=await Promise.all([1,2].map(async()=>{
      const response=await fetch(`${apiBase}/api/maps/${learner.id}/undo-redo`,{
        method:"POST",headers:{Authorization:`Bearer ${currentToken}`,"Content-Type":"application/json"},
        body:JSON.stringify({...concurrentBody,idempotencyKey:randomUUID()}),
      });
      return {status:response.status,body:await response.json() as {state?:UndoRedoState}};
    }));
    assert.deepEqual(concurrentResults.map(item=>item.status).sort(),[200,409],
      "Only one action with the same expected sequence may commit.");
    const stateAfterRace=await api<UndoRedoState>(`/maps/${learner.id}/undo-redo`,200);
    assert.equal(stateAfterRace.canRedo,true);
    const redoAfterRace=await runUndoRedo(learner.id,"REDO");
    assert.equal(redoAfterRace.relatedOperationLogId,concurrentState.undoOperation?.id);
    await api(`/concepts/${branchConcept.id}`,200,"DELETE",{});

    const idempotentConcept=await api<{id:string}>(`/maps/${learner.id}/concepts`,201,"POST",{
      label:"再送確認用",positionX:1060,positionY:340,
    });
    const idempotentState=await api<UndoRedoState>(`/maps/${learner.id}/undo-redo`,200);
    const idempotencyKey=randomUUID();
    const undoRequest={action:"UNDO",expectedSequenceNumber:idempotentState.sequenceNumber,
      idempotencyKey,clientTimestamp:new Date().toISOString()};
    const [firstUndo,secondUndo]=await Promise.all([
      api<UndoRedoResponse>(`/maps/${learner.id}/undo-redo`,200,"POST",undoRequest),
      api<UndoRedoResponse>(`/maps/${learner.id}/undo-redo`,200,"POST",undoRequest),
    ]);
    assert.equal(firstUndo.operationId,secondUndo.operationId);
    assert.deepEqual([firstUndo.duplicate,secondUndo.duplicate].sort(),[false,true]);
    await runUndoRedo(learner.id,"REDO");
    await api(`/concepts/${idempotentConcept.id}`,200,"DELETE",{});

    await api<{id:string}>(`/maps/${learner.id}/concepts`,201,"POST",{
      label:"Redo無効化の起点",positionX:1180,positionY:350,
    });
    await runUndoRedo(learner.id,"UNDO");
    const redoAvailable=await api<UndoRedoState>(`/maps/${learner.id}/undo-redo`,200);
    assert.equal(redoAvailable.canRedo,true);
    const replacement=await api<{id:string}>(`/maps/${learner.id}/concepts`,201,"POST",{
      label:"Redo枝を破棄",positionX:1300,positionY:360,
    });
    const redoInvalidated=await api<UndoRedoState>(`/maps/${learner.id}/undo-redo`,200);
    assert.equal(redoInvalidated.canRedo,false,
      "A normal edit after Undo invalidates Redo.");
    await api(`/concepts/${replacement.id}`,200,"DELETE",{});
    await api(`/concepts/${reversibleConcept.id}`,200,"DELETE",{});
    await api(`/concepts/${scratchReconnectTarget.id}`,200,"DELETE",{});

    const toDelete=await api<{id:string}>(`/maps/${learner.id}/concepts`,201,"POST",
      {label:"削除する概念",positionX:750,positionY:240});
    const cascadeLink=await api<{id:string}>(`/maps/${learner.id}/links`,201,"POST",
      {label:"削除される関係",sourceConceptId:added.id,targetConceptId:toDelete.id});
    await api(`/concepts/${toDelete.id}`,200,"DELETE",{});
    const deleted=await pool.query<{id:string;before:{concepts:Array<{id:string}>;links:Array<{id:string}>};after:{concepts:Array<{id:string}>;links:Array<{id:string}>}}>(
      `SELECT event_id AS id,before_state AS before,after_state AS after FROM research_events
       WHERE map_id=$1::uuid AND event_type='DELETE_CONCEPT'
       ORDER BY sequence_number DESC LIMIT 1`,[learner.id]);
    assert.ok(deleted.rows[0]?.before.concepts.some(item=>item.id===toDelete.id));
    assert.ok(deleted.rows[0]?.before.links.some(item=>item.id===cascadeLink.id));
    assert.ok(!deleted.rows[0]?.after.concepts.some(item=>item.id===toDelete.id));
    assert.ok(!deleted.rows[0]?.after.links.some(item=>item.id===cascadeLink.id));
    const cascadeConceptProvenance=await pool.query<{id:string}>(
      `SELECT id FROM concept_provenance WHERE target_concept_id=$1::uuid`,[toDelete.id]);
    await runUndoRedo(learner.id,"UNDO");
    scratchNow=await api<MapData>(`/maps/${learner.id}`,200);
    assert.equal(scratchNow.concepts.some(item=>item.id===toDelete.id),true,
      "Undo Concept deletion restores the same Concept ID.");
    assert.equal(scratchNow.links.some(item=>item.id===cascadeLink.id),true,
      "Undo Concept deletion restores cascaded Link IDs.");
    const restoredCascadeLink=await pool.query<{count:number}>(
      `SELECT count(*)::int AS count FROM links WHERE id=$1::uuid`,[cascadeLink.id]);
    assert.equal(restoredCascadeLink.rows[0]?.count,1);
    assert.deepEqual(await pool.query<{id:string}>(
      `SELECT id FROM concept_provenance WHERE target_concept_id=$1::uuid`,[toDelete.id]),
      cascadeConceptProvenance,
    );
    await runUndoRedo(learner.id,"REDO");
    await api(`/maps/${learner.id}/submit`,200,"POST");
    await api(`/maps/${learner.id}`,404);
    await api(`/maps/${learner.id}/undo-redo`,404);
    currentToken=researcherToken;
    prior=await api<MapData>(`/maps/${learner.id}`,200);
    assert.equal(prior.status,"SUBMITTED");
    const submittedUndoState=await api<UndoRedoState>(`/maps/${learner.id}/undo-redo`,200);
    assert.equal(submittedUndoState.canUndo,false);
    assert.equal(submittedUndoState.canRedo,false);
    await api(`/maps/${learner.id}/undo-redo`,403,"POST",{
      action:"UNDO",expectedSequenceNumber:submittedUndoState.sequenceNumber,
      idempotencyKey:randomUUID(),
    });
    currentToken=created.learnerAccessToken;

    await startStage(created,"KB_MAP");
    const kb=await api<MapData>(`/kits/${kitId}/kb-map`,201,"POST",
      {sessionStageId:stage(created,"KB_MAP").id});
    assert.equal(kb.type,"KB");
    const kbBefore=await api<MapData>(`/maps/${kb.id}`,200);
    assert.equal(kbBefore.links.length,0);
    assert.equal(kbBefore.concepts.length,0);
    const kitLinkCancellation=await fetch(`${apiBase}/api/maps/${kb.id}/operation-cancellations/IMPORT_KIT_LINK`,{
      method:"POST",headers:{Authorization:`Bearer ${created.learnerAccessToken}`,"Idempotency-Key":randomUUID()},
    });
    assert.equal(kitLinkCancellation.status,201);
    const cancelledKitLink=await kitLinkCancellation.json() as {eventId:string;operationOutcome:string;logSaved:boolean};
    assert.equal(cancelledKitLink.operationOutcome,"CANCELLED");assert.equal(cancelledKitLink.logSaved,true);
    const kbAfterCancel=await api<MapData>(`/maps/${kb.id}`,200);
    assert.deepEqual(kbAfterCancel.concepts,kbBefore.concepts);
    assert.deepEqual(kbAfterCancel.links,kbBefore.links);
    const kitCancelEvent=await pool.query<{eventType:string;outcome:string;reasonCode:string;targetId:string|null;beforeState:unknown;afterState:unknown}>(
      `SELECT event_type AS "eventType",outcome,reason_code AS "reasonCode",target_id AS "targetId",
         before_state AS "beforeState",after_state AS "afterState"
       FROM research_events WHERE event_id=$1::uuid`,[cancelledKitLink.eventId]);
    assert.deepEqual(kitCancelEvent.rows[0],{eventType:"IMPORT_KIT_LINK",outcome:"CANCELLED",
      reasonCode:"USER_CANCELLED",targetId:null,beforeState:null,afterState:null});
    const logsBeforeKitFeedback=await pool.query<{count:number}>(
      `SELECT count(*)::int AS count FROM map_operation_logs WHERE map_id=$1::uuid`,[kb.id]);
    const emptyKitFeedback=await api<KitBuildFeedback>(`/maps/${kb.id}/kit-feedback`,200);
    assert.equal(emptyKitFeedback.matched,false);
    assert.deepEqual(emptyKitFeedback.concepts,{matched:0,total:3});
    assert.deepEqual(emptyKitFeedback.relations,{matched:0,total:2});
    assert.equal(JSON.stringify(emptyKitFeedback).includes("goalMapId"),false);
    assert.equal(JSON.stringify(emptyKitFeedback).includes("sourceConceptId"),false);
    const logsAfterKitFeedback=await pool.query<{count:number}>(
      `SELECT count(*)::int AS count FROM map_operation_logs WHERE map_id=$1::uuid`,[kb.id]);
    assert.deepEqual(logsAfterKitFeedback.rows,logsBeforeKitFeedback.rows,
      "Kit-Build feedback checks must not create OperationLog events.");
    await api(`/maps/${kb.id}/submit`,409,"POST");
    const materialized=[];
    for(let i=0;i<kitConcepts.length;i++){
      materialized.push(await api<{id:string}>(
        `/maps/${kb.id}/kit-concepts/${kitConcepts[i]}/import`,201,"POST",
        {positionX:150+i*200,positionY:170}));
    }
    const kbImports=await pool.query<{targetId:string;afterId:string}>(
      `SELECT target_id AS "targetId", (SELECT item->>'id' FROM jsonb_array_elements(after_state->'concepts') item WHERE item->>'id'=target_id::text) AS "afterId"
       FROM research_events
       WHERE map_id=$1 AND event_type='IMPORT_KIT_CONCEPT'
       ORDER BY sequence_number`,[kb.id]);
    assert.deepEqual(kbImports.rows.map(row=>row.targetId),materialized.map(item=>item.id));
    assert.ok(kbImports.rows.every(row=>row.targetId===row.afterId));
    const conceptsReadyFeedback=await api<KitBuildFeedback>(
      `/maps/${kb.id}/kit-feedback`,200);
    assert.equal(conceptsReadyFeedback.matched,false);
    assert.deepEqual(conceptsReadyFeedback.concepts,{matched:3,total:3});
    assert.deepEqual(conceptsReadyFeedback.relations,{matched:0,total:2});
    const kbLink=await api<{id:string}>(`/maps/${kb.id}/kit-links/${kitLinkId}`,201,"POST",{
      sourceConceptId:materialized[2].id,targetConceptId:materialized[0].id,
    });
    const wrongRelationFeedback=await api<KitBuildFeedback>(
      `/maps/${kb.id}/kit-feedback`,200);
    assert.equal(wrongRelationFeedback.matched,false);
    assert.deepEqual(wrongRelationFeedback.relations,{matched:0,total:2});
    await api(`/maps/${kb.id}/submit`,409,"POST");
    const kbLinkProvenance=await pool.query<{id:string}>(
      `SELECT id FROM link_provenance WHERE target_link_id=$1::uuid ORDER BY id`,[kbLink.id]);
    await runUndoRedo(kb.id,"UNDO");
    assert.equal((await api<MapData>(`/maps/${kb.id}`,200)).links.some(x=>x.id===kbLink.id),false);
    await runUndoRedo(kb.id,"REDO");
    assert.equal((await api<MapData>(`/maps/${kb.id}`,200)).links.some(x=>x.id===kbLink.id),true);
    assert.deepEqual(await pool.query<{id:string}>(
      `SELECT id FROM link_provenance WHERE target_link_id=$1::uuid ORDER BY id`,[kbLink.id]),
      kbLinkProvenance);
    const reconnectedKitLink=await api<{
      id:string;sourceConceptId:string;targetConceptId:string;
    }>(`/links/${kbLink.id}/reconnect`,200,"PATCH",{
      sourceConceptId:materialized[0]!.id,targetConceptId:materialized[1]!.id,
    });
    assert.equal(reconnectedKitLink.id,kbLink.id);
    const oneRelationReadyFeedback=await api<KitBuildFeedback>(
      `/maps/${kb.id}/kit-feedback`,200);
    assert.equal(oneRelationReadyFeedback.matched,false);
    assert.deepEqual(oneRelationReadyFeedback.relations,{matched:1,total:2});
    const secondKitLinkItemId=kitParts.links.find(
      item=>item.kitLinkItemId!==kitLinkId)?.kitLinkItemId;
    assert.ok(secondKitLinkItemId);
    await api(`/maps/${kb.id}/kit-links/${secondKitLinkItemId}`,201,"POST",{
      sourceConceptId:materialized[1]!.id,targetConceptId:materialized[2]!.id,
    });
    const completedKitFeedback=await api<KitBuildFeedback>(
      `/maps/${kb.id}/kit-feedback`,200);
    assert.equal(completedKitFeedback.matched,true);
    assert.deepEqual(completedKitFeedback.concepts,{matched:3,total:3});
    assert.deepEqual(completedKitFeedback.relations,{matched:2,total:2});
    await api(`/maps/${kb.id}/submit`,200,"POST");

    await startStage(created,"INTEGRATION_MAP");
    const integration=await api<MapData>(`/session-stages/${stage(created,"INTEGRATION_MAP").id}/integration-map`,201,"POST");
    assert.equal(integration.basedOnMapId,null);
    const integrationBeforeMergeCancel=await api<MapData>(`/maps/${integration.id}`,200);
    const mergeCancelResponse=await fetch(`${apiBase}/api/maps/${integration.id}/operation-cancellations/MERGE_CONCEPT`,{
      method:"POST",headers:{Authorization:`Bearer ${created.learnerAccessToken}`,"Idempotency-Key":randomUUID()},
    });
    assert.equal(mergeCancelResponse.status,201);
    const mergeCancel=await mergeCancelResponse.json() as {eventId:string;operationOutcome:string;logSaved:boolean};
    assert.equal(mergeCancel.operationOutcome,"CANCELLED");assert.equal(mergeCancel.logSaved,true);
    const integrationAfterMergeCancel=await api<MapData>(`/maps/${integration.id}`,200);
    assert.deepEqual(integrationAfterMergeCancel.concepts,integrationBeforeMergeCancel.concepts);
    assert.deepEqual(integrationAfterMergeCancel.links,integrationBeforeMergeCancel.links);
    assert.equal(integrationAfterMergeCancel.status,"DRAFT");
    await api(`/research/stage1/sessions/${created.id}/maps/${integration.id}/history?sequenceNumber=0`,403);
    await api(`/research/sessions/${created.id}/maps/${integration.id}/mixed-history`,403);
    await api(`/maps/${integration.id}/kit-definition`,200,"PATCH",
      {kitDefinitionId:kitId});
    const current=await api<MapData>(`/maps/${integration.id}`,200);
    assert.equal(current.concepts.length,prior.concepts.length);
    const temporary=await api<{id:string}>(`/maps/${integration.id}/concepts`,201,"POST",{
      label:"履歴確認用の一時概念",positionX:1040,positionY:360,
    });
    const integrationReconnectTarget=current.concepts[1];
    assert.ok(integrationReconnectTarget);
    const movableLink=await api<{id:string;sourceConceptId:string;targetConceptId:string}>(
      `/maps/${integration.id}/links`,201,"POST",{
        label:"一時的な関係",sourceConceptId:temporary.id,targetConceptId:current.concepts[0].id,
      });
    const beforeLinkEditCancellations=await api<MapData>(`/maps/${integration.id}`,200);
    for(const eventType of ["EDIT_LINK","RECONNECT_LINK","DELETE_LINK"] as const) {
      const cancelledOperation=await cancelStage1MapOperation(eventType,movableLink.id,integration.id);
      assert.equal(cancelledOperation.response.status,201,eventType);
      assert.equal(cancelledOperation.body.operationOutcome,"CANCELLED");
      assert.equal(cancelledOperation.body.logSaved,true);
    }
    const afterLinkEditCancellations=await api<MapData>(`/maps/${integration.id}`,200);
    assert.deepEqual(afterLinkEditCancellations.concepts,beforeLinkEditCancellations.concepts);
    assert.deepEqual(afterLinkEditCancellations.links,beforeLinkEditCancellations.links);
    await api(`/links/${movableLink.id}/label`,200,"PATCH",{label:"編集した一時関係"});
    await api(`/concepts/${temporary.id}/position`,200,"PATCH",{
      positionX:1110,positionY:420,
    });
    const reconnected=await api<{id:string;sourceConceptId:string;targetConceptId:string}>(
      `/links/${movableLink.id}/reconnect`,200,"PATCH",{
        sourceConceptId:integrationReconnectTarget.id,targetConceptId:temporary.id,
      });
    assert.equal(reconnected.id,movableLink.id);
    const kitConcept=await api<{id:string}>(
      `/maps/${integration.id}/kit-concepts/${kitConcepts[0]}/import`,201,"POST",
      {positionX:840,positionY:240});
    const importedConceptProvenance=await pool.query<{id:string}>(
      `SELECT id FROM concept_provenance WHERE target_concept_id=$1::uuid ORDER BY id`,[kitConcept.id]);
    await runUndoRedo(integration.id,"UNDO");
    assert.equal((await api<MapData>(`/maps/${integration.id}`,200)).concepts
      .some(item=>item.id===kitConcept.id),false);
    await runUndoRedo(integration.id,"REDO");
    assert.equal((await api<MapData>(`/maps/${integration.id}`,200)).concepts
      .some(item=>item.id===kitConcept.id),true);
    assert.deepEqual(await pool.query<{id:string}>(
      `SELECT id FROM concept_provenance WHERE target_concept_id=$1::uuid ORDER BY id`,[kitConcept.id]),
      importedConceptProvenance);
    await api(`/concepts/${kitConcept.id}/label`,200,"PATCH",{label:"編集済みKit概念"});
    const importedKitLink=await api<{id:string}>(
      `/maps/${integration.id}/kit-links/${kitLinkId}/import`,201,"POST",{
      sourceConceptId:current.concepts[0].id,targetConceptId:kitConcept.id,
    });
    const importedKitLinkProvenance=await pool.query<{id:string}>(
      `SELECT id FROM link_provenance WHERE target_link_id=$1::uuid ORDER BY id`,[importedKitLink.id]);
    await runUndoRedo(integration.id,"UNDO");
    assert.equal((await api<MapData>(`/maps/${integration.id}`,200)).links
      .some(item=>item.id===importedKitLink.id),false);
    await runUndoRedo(integration.id,"REDO");
    assert.equal((await api<MapData>(`/maps/${integration.id}`,200)).links
      .some(item=>item.id===importedKitLink.id),true);
    assert.deepEqual(await pool.query<{id:string}>(
      `SELECT id FROM link_provenance WHERE target_link_id=$1::uuid ORDER BY id`,[importedKitLink.id]),
      importedKitLinkProvenance);
    const deletedLink=await api<{id:string}>(`/maps/${integration.id}/links`,201,"POST",{
      label:"明示削除する関係",sourceConceptId:current.concepts[0].id,
      targetConceptId:kitConcept.id,
    });
    await api(`/links/${deletedLink.id}`,200,"DELETE",{});
    await api(`/concepts/${temporary.id}`,200,"DELETE",{});
    const spareKitConcept=await api<{id:string}>(
      `/maps/${integration.id}/kit-concepts/${kitConcepts[1]}/import`,201,"POST",
      {positionX:1030,positionY:450});
    const spareKitConceptProvenance=await pool.query<{id:string}>(
      `SELECT id FROM concept_provenance WHERE target_concept_id=$1::uuid ORDER BY id`,
      [spareKitConcept.id]);
    const otherKitLinkItemId=kitParts.links.find(item=>item.kitLinkItemId!==kitLinkId)?.kitLinkItemId;
    assert.ok(otherKitLinkItemId);
    const cascadedKitLink=await api<{id:string}>(
      `/maps/${integration.id}/kit-links/${otherKitLinkItemId}/import`,201,"POST",{
        sourceConceptId:current.concepts[0]!.id,targetConceptId:spareKitConcept.id,
      });
    const cascadedKitLinkProvenance=await pool.query<{id:string}>(
      `SELECT id FROM link_provenance WHERE target_link_id=$1::uuid ORDER BY id`,
      [cascadedKitLink.id]);
    await api(`/concepts/${spareKitConcept.id}`,200,"DELETE",{});
    assert.equal((await api<MapData>(`/maps/${integration.id}`,200)).links
      .some(item=>item.id===cascadedKitLink.id),false);
    await runUndoRedo(integration.id,"UNDO");
    let afterKitCascadeUndo=await api<MapData>(`/maps/${integration.id}`,200);
    assert.ok(afterKitCascadeUndo.concepts.some(item=>item.id===spareKitConcept.id));
    assert.ok(afterKitCascadeUndo.links.some(item=>item.id===cascadedKitLink.id));
    assert.deepEqual(await pool.query<{id:string}>(
      `SELECT id FROM concept_provenance WHERE target_concept_id=$1::uuid ORDER BY id`,
      [spareKitConcept.id]),spareKitConceptProvenance);
    assert.deepEqual(await pool.query<{id:string}>(
      `SELECT id FROM link_provenance WHERE target_link_id=$1::uuid ORDER BY id`,
      [cascadedKitLink.id]),cascadedKitLinkProvenance);
    await runUndoRedo(integration.id,"REDO");
    afterKitCascadeUndo=await api<MapData>(`/maps/${integration.id}`,200);
    assert.equal(afterKitCascadeUndo.concepts.some(item=>item.id===spareKitConcept.id),false);
    assert.equal(afterKitCascadeUndo.links.some(item=>item.id===cascadedKitLink.id),false);
    const mergeFirst=await api<{id:string}>(`/maps/${integration.id}/concepts`,201,"POST",{
      label:"Merge元A",positionX:1200,positionY:140,
    });
    const mergeSecond=await api<{id:string}>(`/maps/${integration.id}/concepts`,201,"POST",{
      label:"Merge元B",positionX:1450,positionY:140,
    });
    const mergeLink=await api<{id:string}>(`/maps/${integration.id}/links`,201,"POST",{
      label:"Merge対象の関係",sourceConceptId:mergeFirst.id,targetConceptId:mergeSecond.id,
    });
    const merged=await api<{concept:{id:string};incidentLinks:Array<{id:string}>}>(
      `/maps/${integration.id}/concepts/merge`,201,"POST",{
        conceptIds:[mergeFirst.id,mergeSecond.id],label:"Merge結果",
      });
    assert.equal(merged.incidentLinks[0]?.id,mergeLink.id);
    const mergeResultProvenance=await pool.query<{id:string}>(
      `SELECT id FROM concept_provenance WHERE target_concept_id=$1::uuid ORDER BY id`,
      [merged.concept.id]);
    const mergeLinkProvenance=await pool.query<{id:string}>(
      `SELECT id FROM link_provenance WHERE target_link_id=$1::uuid ORDER BY id`,
      [mergeLink.id]);
    await runUndoRedo(integration.id,"UNDO");
    let afterMergeUndo=await api<MapData>(`/maps/${integration.id}`,200);
    assert.ok(afterMergeUndo.concepts.some(item=>item.id===mergeFirst.id));
    assert.ok(afterMergeUndo.concepts.some(item=>item.id===mergeSecond.id));
    assert.equal(afterMergeUndo.concepts.some(item=>item.id===merged.concept.id),false);
    assert.deepEqual(
      [afterMergeUndo.links.find(item=>item.id===mergeLink.id)?.sourceConceptId,
       afterMergeUndo.links.find(item=>item.id===mergeLink.id)?.targetConceptId],
      [mergeFirst.id,mergeSecond.id],
    );
    assert.equal((await pool.query<{count:number}>(
      `SELECT count(*)::int AS count FROM concept_provenance WHERE target_concept_id=$1::uuid`,
      [merged.concept.id])).rows[0]?.count,0);
    await runUndoRedo(integration.id,"REDO");
    afterMergeUndo=await api<MapData>(`/maps/${integration.id}`,200);
    assert.ok(afterMergeUndo.concepts.some(item=>item.id===merged.concept.id));
    assert.deepEqual(await pool.query<{id:string}>(
      `SELECT id FROM concept_provenance WHERE target_concept_id=$1::uuid ORDER BY id`,
      [merged.concept.id]),mergeResultProvenance);
    assert.deepEqual(await pool.query<{id:string}>(
      `SELECT id FROM link_provenance WHERE target_link_id=$1::uuid ORDER BY id`,
      [mergeLink.id]),mergeLinkProvenance);
    await api(`/maps/${integration.id}/submit`,200,"POST");
    const flow=await api<{session:{status:string};currentStage:null}>(
      `/sessions/${created.id}/flow`,200);
    assert.equal(flow.session.status,"COMPLETED");
    assert.equal(flow.currentStage,null);
    currentToken=researcherToken;
    for (const item of [learner, kb, integration]) {
      const verified = await api<{status:string;reason?:string;state:ReplayState;newApplied:number}>(`/research/sessions/${created.id}/maps/${item.id}/mixed-history`,200);
      assert.equal(verified.status,"REPLAYABLE",verified.reason);
      assert.ok(verified.newApplied > 0);
      assert.equal(verified.state.mapId,item.id);
      const saved = await pool.query<{count:number}>("SELECT count(*)::int AS count FROM map_operation_logs WHERE map_id=$1::uuid",[item.id]);
      assert.equal(saved.rows[0]?.count,0);
    }
    const priorReplayTypes=await verifyMapHistory(created.id,learner.id);
    const kbReplayTypes=await verifyMapHistory(created.id,kb.id);
    const integrationReplayTypes=await verifyMapHistory(created.id,integration.id);
    for (const item of [learner, kb, integration]) {
      const mixed = await api<{status:string;reason?:string;state:ReplayState}>(`/research/sessions/${created.id}/maps/${item.id}/mixed-history`, 200);
      assert.equal(mixed.status,"REPLAYABLE",mixed.reason);
      assert.equal(mixed.state.mapId,item.id);
    }
    const beforeBoundary = await api<{status:string;state:MapHistorySnapshot}>(`/research/sessions/${created.id}/maps/${learner.id}/mixed-history`,200);
    assert.equal(beforeBoundary.status,"REPLAYABLE");
    const setupBoundary = await pool.connect();
    try {
      await setupBoundary.query("BEGIN");
      await setupBoundary.query("SELECT id FROM maps WHERE id=$1::uuid FOR UPDATE",[learner.id]);
      const old = await setupBoundary.query<{id:string}>("SELECT id FROM map_operation_logs WHERE map_id=$1::uuid ORDER BY sequence_number",[learner.id]);
      const existingBoundary = await setupBoundary.query("SELECT 1 FROM map_history_boundaries WHERE map_id=$1::uuid",[learner.id]);
      if (!existingBoundary.rowCount) {
        await setupBoundary.query("INSERT INTO map_history_boundaries(map_id,legacy_count,legacy_last_id,boundary_snapshot) VALUES($1::uuid,$2,$3::uuid,$4::jsonb)",[learner.id,old.rows.length,old.rows.at(-1)?.id ?? null,JSON.stringify(beforeBoundary.state)]);
        assert.ok(await insertResearchEvent(setupBoundary,created.id,"SYSTEM",{schemaVersion:2,eventType:"MAP_SAVE",targetType:"MAP",mapId:learner.id,outcome:"SUCCESS",clientTimeQuality:"NOT_APPLICABLE",before:beforeBoundary.state,after:beforeBoundary.state}));
      }
      await setupBoundary.query("COMMIT");
    } catch (error) { await setupBoundary.query("ROLLBACK"); throw error; }
    finally { setupBoundary.release(); }
    const afterBoundary = await api<{status:string;newApplied:number;state:MapHistorySnapshot}>(`/research/sessions/${created.id}/maps/${learner.id}/mixed-history`,200);
    assert.equal(afterBoundary.status,"REPLAYABLE");
    assert.ok(afterBoundary.newApplied>=1);
    const boundaryUndo = await api<{status:string;canUndo:boolean;canRedo:boolean}>(`/maps/${learner.id}/undo-redo`,200);
    assert.equal(boundaryUndo.status,"AVAILABLE");
    assert.equal(boundaryUndo.canUndo,false);
    assert.equal(boundaryUndo.canRedo,false);
    const corrupted = structuredClone(afterBoundary.state);
    assert.ok(corrupted.concepts[0]);
    corrupted.concepts[0].positionX += 10;
    const mismatchClient = await pool.connect();
    try {
      await mismatchClient.query("BEGIN");
      assert.ok(await insertResearchEvent(mismatchClient,created.id,"SYSTEM",{schemaVersion:2,eventType:"MOVE_CONCEPT",targetType:"CONCEPT",targetId:corrupted.concepts[0].id,mapId:learner.id,outcome:"SUCCESS",clientTimeQuality:"NOT_APPLICABLE",before:afterBoundary.state,after:corrupted}));
      await mismatchClient.query("COMMIT");
    } catch (error) { await mismatchClient.query("ROLLBACK"); throw error; }
    finally { mismatchClient.release(); }
    const mismatch = await api<{status:string;reason:string;state:null}>(`/research/sessions/${created.id}/maps/${learner.id}/mixed-history`,200);
    assert.equal(mismatch.status,"PARTIAL");
    assert.equal(mismatch.state,null);
    const moveEvents=await pool.query<{count:number}>(
      `SELECT count(*)::int AS count FROM research_events
       WHERE map_id=$1::uuid AND event_type='MOVE_CONCEPT' AND target_id=$2::uuid`,
      [integration.id,temporary.id]);
    assert.equal(moveEvents.rows[0]?.count,1,
      "A completed Concept move should create one MOVE_CONCEPT event.");
    assert.ok(priorReplayTypes.includes("DELETE_CONCEPT"));
    assert.ok(kbReplayTypes.includes("IMPORT_KIT_CONCEPT"));
    assert.ok(kbReplayTypes.includes("ADD_LINK"));
    for(const type of [
      "ADD_CONCEPT","EDIT_CONCEPT","MOVE_CONCEPT","DELETE_CONCEPT",
      "ADD_LINK","EDIT_LINK","DELETE_LINK","RECONNECT_LINK",
      "IMPORT_KIT_CONCEPT","IMPORT_KIT_LINK","MERGE_CONCEPT",
    ]) assert.ok(integrationReplayTypes.includes(type),`Missing replay coverage for ${type}`);
    const exportData=await api<{
      session:{protocolKey:string};
      maps:Array<{type:string;researchRole:string;operationLogs:Array<{
        id:string;operationType:string;relatedOperationLogId:string|null;
        historySource?:string;schemaVersion?:number;eventType?:string;sequenceNumber:string;
        relatedEventId?:string|null;relatedLegacyOperationLogId?:string|null;
        outcome?:string;
      }>;
        historySnapshotVersion:number|null;initialSnapshot:ReplayState|null}>;
      stages:unknown[];
    }>(`/research/sessions/${created.id}/export`,200);
    assert.equal(exportData.session.protocolKey,"STAGE1_4");
    assert.equal(exportData.stages.length,4);
    assert.deepEqual(exportData.maps.map(m=>m.researchRole).sort(),
      ["integration_map","kitbuild_map","learner_map"]);
    assert.ok(exportData.maps.every(m=>m.historySnapshotVersion===1&&m.initialSnapshot));
    const exportedOperations=exportData.maps.flatMap(map=>map.operationLogs);
    const exportedById=new Map(exportedOperations.map(operation=>[operation.id,operation]));
    const undoRedoExports=exportedOperations.filter(operation=>
      operation.operationType==="UNDO"||operation.operationType==="REDO");
    assert.ok(undoRedoExports.length>0);
    assert.ok(exportedOperations.some(op=>op.historySource==="EVENT"&&[2,5].includes(op.schemaVersion??0)));
    assert.ok(exportedOperations.some(op=>op.eventType==="ADD_LINK"&&op.outcome==="CANCELLED"));
    assert.ok(exportedOperations.some(op=>op.eventType==="IMPORT_KIT_LINK"&&op.outcome==="CANCELLED"));
    assert.ok(exportedOperations.some(op=>op.eventType==="ADD_CONCEPT"&&op.outcome==="CANCELLED"));
    assert.ok(exportedOperations.some(op=>op.eventType==="EDIT_CONCEPT"&&op.outcome==="CANCELLED"));
    assert.ok(exportedOperations.some(op=>op.eventType==="DELETE_CONCEPT"&&op.outcome==="CANCELLED"));
    assert.ok(exportedOperations.some(op=>op.eventType==="EDIT_LINK"&&op.outcome==="CANCELLED"));
    assert.ok(exportedOperations.some(op=>op.eventType==="RECONNECT_LINK"&&op.outcome==="CANCELLED"));
    assert.ok(exportedOperations.some(op=>op.eventType==="DELETE_LINK"&&op.outcome==="CANCELLED"));
    assert.ok(exportedOperations.some(op=>op.eventType==="MERGE_CONCEPT"&&op.outcome==="CANCELLED"));
    assert.ok(exportedOperations.some(op=>op.eventType==="MAP_SUBMIT"&&op.outcome==="CANCELLED"));
    assert.ok(exportedOperations.some(op=>op.eventType==="ADD_CONCEPT"&&op.outcome==="REJECTED"));
    assert.ok(exportedOperations.some(op=>op.eventType==="ADD_CONCEPT"&&op.outcome==="FAILURE"));
    assert.ok(exportedOperations.some(op=>op.operationType==="MAP_SUBMIT"));
    assert.ok(exportData.maps.every(m=>m.operationLogs.every((op,index)=>Number(op.sequenceNumber)===index+1)));
    const integratedHistory=exportData.maps.find(m=>m.researchRole==="integration_map")!;
    const finalHistory=await api<{status:string;afterState:{mapId:string}}>(
      `/research/stage1/sessions/${created.id}/maps/${integration.id}/history?sequenceNumber=${integratedHistory.operationLogs.length}`,200);
    assert.equal(finalHistory.status,"REPLAYABLE");
    assert.equal(finalHistory.afterState.mapId,integration.id);
    const mergeCancellationSequence=integratedHistory.operationLogs.findIndex(operation=>
      operation.eventType==="MERGE_CONCEPT"&&operation.outcome==="CANCELLED")+1;
    assert.ok(mergeCancellationSequence>0);
    const cancelledOperationHistory=await api<{
      status:string;operation:{outcome?:string}|null;beforeState:ReplayState;afterState:ReplayState;
    }>(`/research/stage1/sessions/${created.id}/maps/${integration.id}/history?sequenceNumber=${mergeCancellationSequence}`,200);
    assert.equal(cancelledOperationHistory.status,"REPLAYABLE");
    assert.equal(cancelledOperationHistory.operation?.outcome,"CANCELLED");
    assert.deepEqual(cancelledOperationHistory.beforeState,cancelledOperationHistory.afterState);
    for(const operation of undoRedoExports){
      if(operation.historySource==="EVENT"&&operation.outcome!=="SUCCESS") {
        assert.equal(operation.relatedEventId??operation.relatedLegacyOperationLogId??null,null);
        continue;
      }
      const related=operation.historySource==="EVENT"?
        operation.relatedEventId??operation.relatedLegacyOperationLogId:operation.relatedOperationLogId;
      assert.ok(related);
      assert.ok(exportedById.has(related));
      assert.notEqual(exportedById.get(related)?.operationType,"UNDO");
      assert.notEqual(exportedById.get(related)?.operationType,"REDO");
    }

    const analysis=await api<{
      operations:Array<{id:string;mapId:string;operationType:string;
        relatedOperationLogId:string|null;elapsedMs:number|null}>;
      operationCounts:Record<string,number>;
      features:{
        featureVersion:string;ordinaryEditEvents:number;undoEvents:number;redoEvents:number;
        scratchConcepts:number;kbConcepts:number;
        integrationLinks:number;retainedScratchPropositions:number;
        inheritedToAddedPropositions:number;kitConceptPartCount:number;
        kitLinkPartCount:number;kitConceptImportEvents:number;
        kitLinkImportEvents:number;currentKitConceptUsageRate:number|null;
        currentKitLinkUsageRate:number|null;
      };
    }>(`/research/stage1/sessions/${created.id}/analysis`,200);
    assert.equal(analysis.features.featureVersion,"stage1-descriptive-v2");
    assert.ok(analysis.features.ordinaryEditEvents>0);
    assert.ok(analysis.features.undoEvents>0);
    assert.ok(analysis.features.redoEvents>0);
    assert.equal(analysis.operationCounts.UNDO,analysis.features.undoEvents);
    assert.equal(analysis.operationCounts.REDO,analysis.features.redoEvents);
    assert.equal(analysis.features.scratchConcepts,2);
    assert.equal(analysis.features.kbConcepts,3);
    assert.equal(analysis.features.integrationLinks,3);
    assert.equal(analysis.features.retainedScratchPropositions,1);
    assert.equal(analysis.features.inheritedToAddedPropositions,1);
    assert.equal(analysis.features.kitConceptPartCount,3);
    assert.equal(analysis.features.kitLinkPartCount,2);
    assert.equal(analysis.features.kitConceptImportEvents,2);
    assert.equal(analysis.features.kitLinkImportEvents,2);
    assert.equal(analysis.features.currentKitConceptUsageRate,1/3);
    assert.equal(analysis.features.currentKitLinkUsageRate,1/2);
    const featureCsv=await fetch(`${apiBase}/api/research/stage1/sessions/${created.id}/features.csv`,
      {headers:{Authorization:`Bearer ${currentToken}`}});
    assert.equal(featureCsv.status,200);
    const featureCsvContent=await featureCsv.text();
    assert.ok(featureCsvContent.includes("retainedScratchPropositions"));
    assert.ok(featureCsvContent.includes("stage1-descriptive-v2"));
    assert.ok(analysis.operationCounts.ADD_CONCEPT>=2);
    assert.ok(analysis.operations.some(o=>o.operationType==="IMPORT_KIT_LINK"));
    const currentMap=await api<MapData>(`/maps/${integration.id}`,200);
    const rated=currentMap.links[0];
    assert.ok(rated);
    await api(`/research/stage1/sessions/${created.id}/evaluations`,201,"POST",{
      mapId:integration.id,linkId:rated.id,evaluatorCode:"R1",
      snapshotSide:"CURRENT",category:"P",rationale:"要検討のため暫定分類",
    });
    await api(`/research/stage1/sessions/${created.id}/evaluations`,201,"POST",{
      mapId:learner.id,linkId:cascadeLink.id,eventId:deleted.rows[0].id,
      evaluatorCode:"R1",snapshotSide:"BEFORE",category:"U",
      rationale:"削除時に巻き込まれた命題の記録",
    });
    await api(`/research/stage1/sessions/${created.id}/evaluations`,404,"POST",{
      mapId:integration.id,linkId:cascadeLink.id,eventId:deleted.rows[0].id,
      evaluatorCode:"R1",snapshotSide:"BEFORE",category:"U",rationale:"別マップの参照",
    });
    await api(`/research/stage1/sessions/${created.id}/reflections`,201,"POST",{
      mapId:integration.id,reportedByCode:"R1",
      noteText:"操作していない関係についての振り返りも保存",
      linkId:rated.id,
    });
    const undoOperation=analysis.operations.find(operation=>operation.operationType==="UNDO");
    assert.ok(undoOperation);
    await api(`/research/stage1/sessions/${created.id}/reflections`,201,"POST",{
      mapId:undoOperation.mapId,eventId:undoOperation.id,reportedByCode:"R1",
      noteText:"Undo時点のMap状態についての分析メモ",
    });
    await api(`/research/stage1/sessions/${created.id}/reflections`,404,"POST",{
      mapId:undoOperation.mapId===learner.id?integration.id:learner.id,
      eventId:undoOperation.id,reportedByCode:"R1",noteText:"別マップの参照",
    });
    const checked=await api<{
      propositionEvaluations:Array<{linkId:string;subjectSnapshot:{id:string};snapshotSide:string}>;
      reflectionNotes:Array<{operationLogId:string|null;eventId:string|null;noteText:string}>;
    }>(
      `/research/stage1/sessions/${created.id}/analysis`,200);
    assert.equal(checked.propositionEvaluations.length,2);
    assert.ok(checked.propositionEvaluations.some(e=>
      e.linkId===cascadeLink.id && e.subjectSnapshot.id===cascadeLink.id &&
      e.snapshotSide==="BEFORE"));
    assert.equal(checked.reflectionNotes.length,2);
    assert.ok(checked.reflectionNotes.some(note=>
      note.eventId===undoOperation.id&&note.noteText.includes("Undo時点")));
    for (const [suffix,expected] of [
      ["evaluations.csv","P"],
      ["reflections.csv","操作していない関係"],
    ] as const) {
      const csvResult=await fetch(
        `${apiBase}/api/research/stage1/sessions/${created.id}/${suffix}`,
        {headers:{Authorization:`Bearer ${currentToken}`}});
      assert.equal(csvResult.status,200);
      assert.ok((await csvResult.text()).includes(expected));
    }
    const csvResponse=await fetch(
      `${apiBase}/api/research/stage1/sessions/${created.id}/operations.csv`,
      {headers:{Authorization:`Bearer ${currentToken}`}});
    assert.equal(csvResponse.status,200);
    const csv=await csvResponse.text();
    assert.ok(csv.includes("IMPORT_KIT_LINK"));
    assert.ok(csv.includes(created.id));
    assert.ok(csv.includes("sequenceNumber"));
    const legacyFixture=await pool.query<{sessionId:string;mapId:string;linkId:string;logId:string}>(
      `WITH s AS (INSERT INTO sessions(protocol_key,participant_code,lesson_video_url,research_kit_definition_id,status,started_at,completed_at)
         VALUES('STAGE1_4',$1,'/test.mp4',$2::uuid,'COMPLETED',now(),now()) RETURNING id),
       st AS (INSERT INTO session_stages(session_id,stage_type,order_index) SELECT id,'PRIOR_MAP',0 FROM s RETURNING id,session_id),
       m AS (INSERT INTO maps(type,status,session_stage_id,submitted_at) SELECT 'PRIOR','SUBMITTED',id,now() FROM st RETURNING id),
       a AS (INSERT INTO concepts(map_id,label,position_x,position_y) SELECT id,'A',0,0 FROM m RETURNING id,map_id),
       b AS (INSERT INTO concepts(map_id,label,position_x,position_y) SELECT id,'B',1,0 FROM m RETURNING id,map_id),
       l AS (INSERT INTO links(map_id,source_concept_id,target_concept_id,label) SELECT a.map_id,a.id,b.id,'旧関係' FROM a,b RETURNING id,map_id,source_concept_id,target_concept_id,label),
       op AS (INSERT INTO map_operation_logs(map_id,operation_type,target_type,target_id,after,sequence_number)
         SELECT map_id,'ADD_LINK','LINK',id,jsonb_build_object('id',id,'mapId',map_id,'sourceConceptId',source_concept_id,'targetConceptId',target_concept_id,'label',label),1 FROM l RETURNING id)
       SELECT (SELECT id FROM s) AS "sessionId",(SELECT id FROM m) AS "mapId",(SELECT id FROM l) AS "linkId",(SELECT id FROM op) AS "logId"`,
      [`legacy-annotation-${randomUUID()}`,kitId]);
    const oldRef=legacyFixture.rows[0]!;
    await api(`/research/stage1/sessions/${oldRef.sessionId}/evaluations`,201,"POST",{
      mapId:oldRef.mapId,linkId:oldRef.linkId,operationLogId:oldRef.logId,
      evaluatorCode:"R1",snapshotSide:"AFTER",category:"P",rationale:"旧履歴を参照",
    });
    await api(`/research/stage1/sessions/${oldRef.sessionId}/reflections`,201,"POST",{
      mapId:oldRef.mapId,operationLogId:oldRef.logId,reportedByCode:"R1",noteText:"旧履歴のメモ",
    });
    const preserved=await pool.query<{operationLogId:string;eventId:string|null}>(
      `SELECT operation_log_id AS "operationLogId",event_id AS "eventId"
       FROM research_proposition_evaluations WHERE session_id=$1::uuid`,[oldRef.sessionId]);
    assert.equal(preserved.rows[0]?.operationLogId,oldRef.logId);
    assert.equal(preserved.rows[0]?.eventId,null);
    const preservedNote=await pool.query<{operationLogId:string;eventId:string|null}>(
      `SELECT operation_log_id AS "operationLogId",event_id AS "eventId"
       FROM research_reflection_notes WHERE session_id=$1::uuid`,[oldRef.sessionId]);
    assert.equal(preservedNote.rows[0]?.operationLogId,oldRef.logId);
    assert.equal(preservedNote.rows[0]?.eventId,null);
    const learnerExport=await fetch(`${apiBase}/api/research/sessions/${created.id}/export`,
      {headers:{Authorization:`Bearer ${created.learnerAccessToken}`}});
    assert.equal(learnerExport.status,403);
    const learnerAnalysis=await fetch(`${apiBase}/api/research/stage1/sessions/${created.id}/analysis`,
      {headers:{Authorization:`Bearer ${created.learnerAccessToken}`}});
    assert.equal(learnerAnalysis.status,403);
    assert.ok(link.id);
    await pool.query("DELETE FROM map_initial_snapshots WHERE map_id=$1::uuid",[kb.id]);
    const unavailableHistory=await api<ReplayResponse & {reason:string}>(
      `/research/stage1/sessions/${created.id}/maps/${kb.id}/history?sequenceNumber=0`,200);
    assert.equal(unavailableHistory.status,"UNAVAILABLE");
    assert.equal(unavailableHistory.beforeState,null);
    assert.equal(unavailableHistory.afterState,null);
    const goalMap=await pool.query<{id:string}>(
      "SELECT goal_map_id AS id FROM kit_definitions WHERE id=$1::uuid",[kitId]);
    await api(`/research/stage1/sessions/${created.id}/maps/${goalMap.rows[0]!.id}/history?sequenceNumber=0`,404);
    console.log("Stage1 research E2E succeeded",created.id);
  }finally{
    if(authoredGoalMapId){
      const cleanup=await pool.connect();
      try{
        await cleanup.query("BEGIN");
        await cleanup.query("DELETE FROM kit_definitions WHERE goal_map_id=$1::uuid",[authoredGoalMapId]);
        await cleanup.query("DELETE FROM map_operation_logs WHERE map_id=$1::uuid",[authoredGoalMapId]);
        await cleanup.query("DELETE FROM links WHERE map_id=$1::uuid",[authoredGoalMapId]);
        await cleanup.query("DELETE FROM concepts WHERE map_id=$1::uuid",[authoredGoalMapId]);
        await cleanup.query("DELETE FROM maps WHERE id=$1::uuid AND type='GOAL'",[authoredGoalMapId]);
        await cleanup.query("COMMIT");
      }catch(error){
        await cleanup.query("ROLLBACK").catch(()=>undefined);
        console.error("Failed to clean up Goal Map authoring test data",error);
        process.exitCode=1;
      }finally{
        cleanup.release();
      }
    }
    await pool.end();
  }
}
run().catch(e=>{console.error(e);process.exitCode=1;});
