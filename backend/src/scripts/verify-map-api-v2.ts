import {verifyMockTestUrl} from "./mock-db.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createLearnerToken, storeLearnerToken } from "../access-control.js";
await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const base = process.env.API_BASE_URL ?? "http://127.0.0.1:3000";
const researcher = process.env.RESEARCHER_API_TOKEN!;
const kit = "66666666-6666-4666-8666-666666666662";
const credential = createLearnerToken();
let sessionId: string;
async function call<T>(path: string, status: number, method = "GET", body?: unknown, token = credential.token): Promise<T> {
  const res = await fetch(`${base}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data: unknown = await res.json();
  assert.equal(res.status, status, `${method} ${path} ${JSON.stringify(data)}`);
  return data as T;
}
type Flow = { stages: Array<{id:string;stageType:string}> };
type Undo = { status:string;sequenceNumber:number;canUndo:boolean;canRedo:boolean };
try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const s=await client.query<{id:string}>(`INSERT INTO sessions(protocol_key,participant_code,lesson_video_url,research_kit_definition_id) VALUES('STAGE1_4',$1,'/test.mp4',$2::uuid) RETURNING id`,[`test-${randomUUID()}`,kit]);
    sessionId=s.rows[0]!.id;
    for (const [i,stage] of ["LESSON","PRIOR_MAP","KB_MAP","INTEGRATION_MAP"].entries()) await client.query("INSERT INTO session_stages(session_id,stage_type,order_index) VALUES($1::uuid,$2,$3)",[sessionId,stage,i]);
    await storeLearnerToken(client,sessionId,credential.hash); await client.query("COMMIT");
  } finally { client.release(); }
  const flow=await call<Flow>(`/sessions/${sessionId}/flow`,200);
  const stage=(name:string)=>flow.stages.find(item=>item.stageType===name)!.id;
  await call(`/sessions/${sessionId}/start`,200,"POST",{});
  await call(`/session-stages/${stage("LESSON")}/start`,200,"POST",{});
  await call(`/session-stages/${stage("LESSON")}/complete`,200,"POST",{});
  await call(`/session-stages/${stage("PRIOR_MAP")}/start`,200,"POST",{});
  const map=await call<{id:string;concepts:Array<{id:string}>}>(`/session-stages/${stage("PRIOR_MAP")}/prior-map`,201,"POST");
  const mapData=await call<{concepts:Array<{id:string}>}>(`/maps/${map.id}`,200);
  const anchor=mapData.concepts[0]!.id;
  const legacyId=randomUUID(), legacyOperation=randomUUID();
  const legacyConcept={id:legacyId,mapId:map.id,label:"旧履歴の概念",positionX:50,positionY:50};
  await pool.query("INSERT INTO concepts(id,map_id,label,position_x,position_y) VALUES($1::uuid,$2::uuid,$3,$4,$5)",[legacyId,map.id,legacyConcept.label,legacyConcept.positionX,legacyConcept.positionY]);
  await pool.query(`INSERT INTO map_operation_logs(id,map_id,operation_type,target_type,target_id,after,sequence_number) VALUES($1::uuid,$2::uuid,'ADD_CONCEPT','CONCEPT',$3::uuid,$4::jsonb,1)`,[legacyOperation,map.id,legacyId,JSON.stringify(legacyConcept)]);
  await pool.query(`CREATE FUNCTION reject_test_event() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END; $$ LANGUAGE plpgsql`);
  await pool.query("CREATE TRIGGER reject_test_event BEFORE INSERT ON research_events FOR EACH ROW EXECUTE FUNCTION reject_test_event()");
  try {
    await call(`/maps/${map.id}/concepts`,409,"POST",{label:"記録失敗",positionX:100,positionY:100});
    assert.equal((await pool.query("SELECT 1 FROM map_history_boundaries WHERE map_id=$1::uuid",[map.id])).rowCount,0);
    assert.equal((await pool.query("SELECT 1 FROM concepts WHERE map_id=$1::uuid AND label=$2",[map.id,"記録失敗"])).rowCount,0);
    assert.equal((await pool.query("SELECT 1 FROM map_operation_logs WHERE map_id=$1::uuid",[map.id])).rowCount,1);
  } finally {
    await pool.query("DROP TRIGGER reject_test_event ON research_events");
    await pool.query("DROP FUNCTION reject_test_event()");
  }
  const added=await call<{id:string}>(`/maps/${map.id}/concepts`,201,"POST",{label:"概念",positionX:100,positionY:100});
  const beforeCancellation=await call<{concepts:unknown[];links:unknown[]}>(`/maps/${map.id}`,200);
  const cancellationKey=randomUUID();
  async function cancelPendingLinkCreation() {
    const response=await fetch(`${base}/api/maps/${map.id}/operation-cancellations/ADD_LINK`,{
      method:"POST",headers:{Authorization:`Bearer ${credential.token}`,"Idempotency-Key":cancellationKey},
    });
    const body=await response.json() as {eventId?:string;operationOutcome?:string;logSaved?:boolean};
    return {status:response.status,body};
  }
  const cancellation=await cancelPendingLinkCreation();
  assert.equal(cancellation.status,201);
  assert.equal(cancellation.body.operationOutcome,"CANCELLED");
  assert.equal(cancellation.body.logSaved,true);
  const duplicateCancellation=await cancelPendingLinkCreation();
  assert.equal(duplicateCancellation.status,200);
  assert.equal(duplicateCancellation.body.eventId,cancellation.body.eventId);
  const cancellationRows=await pool.query<{
    eventType:string;targetType:string;targetId:string|null;outcome:string;reasonCode:string;
    actorType:string;beforeState:unknown;afterState:unknown;details:unknown;
  }>(`SELECT event_type AS "eventType",target_type AS "targetType",target_id AS "targetId",outcome,
       reason_code AS "reasonCode",actor_type AS "actorType",before_state AS "beforeState",
       after_state AS "afterState",details
     FROM research_events WHERE event_id=$1::uuid`,[cancellation.body.eventId]);
  assert.deepEqual(cancellationRows.rows[0],{
    eventType:"ADD_LINK",targetType:"LINK",targetId:null,outcome:"CANCELLED",reasonCode:"USER_CANCELLED",
    actorType:"LEARNER",beforeState:null,afterState:null,details:{},
  });
  const afterCancellation=await call<{concepts:unknown[];links:unknown[]}>(`/maps/${map.id}`,200);
  assert.deepEqual(afterCancellation,beforeCancellation);
  const cancellationReplay=await call<{status:string;reason?:string}>(`/research/sessions/${sessionId}/maps/${map.id}/mixed-history`,200,"GET",undefined,researcher);
  assert.equal(cancellationReplay.status,"REPLAYABLE",cancellationReplay.reason);
  const invalidCancellation=await fetch(`${base}/api/maps/${map.id}/operation-cancellations/ADD_LINK`,{
    method:"POST",headers:{Authorization:`Bearer ${credential.token}`,"Content-Type":"application/json","Idempotency-Key":randomUUID()},
    body:JSON.stringify({label:"secret input must not be accepted"}),
  });
  assert.equal(invalidCancellation.status,400);
  assert.ok(!(await invalidCancellation.text()).includes("secret input"));
  assert.equal((await pool.query(`SELECT 1 FROM research_events WHERE map_id=$1::uuid AND event_type='ADD_LINK' AND outcome='CANCELLED'`,[map.id])).rowCount,1);
  async function historyAction(action: "UNDO"|"REDO") {
    const current=await call<Undo>(`/maps/${map.id}/undo-redo`,200);
    return call<{relatedOperationLogId:string}>(`/maps/${map.id}/undo-redo`,200,"POST",{action,expectedSequenceNumber:current.sequenceNumber,idempotencyKey:randomUUID()});
  }
  await historyAction("UNDO");
  assert.equal((await historyAction("UNDO")).relatedOperationLogId,legacyOperation);
  const legacyUndo=await pool.query<{related:string}>(`SELECT related_legacy_operation_log_id AS related FROM research_events WHERE map_id=$1::uuid AND event_type='UNDO' ORDER BY sequence_number DESC LIMIT 1`,[map.id]);
  assert.equal(legacyUndo.rows[0]?.related,legacyOperation);
  assert.equal((await historyAction("REDO")).relatedOperationLogId,legacyOperation);
  await historyAction("REDO");
  await call(`/concepts/${added.id}/label`,200,"PATCH",{label:"概念を編集"});
  await call(`/concepts/${added.id}/position`,200,"PATCH",{positionX:200,positionY:100});
  const link=await call<{id:string}>(`/maps/${map.id}/links`,201,"POST",{label:"関係",sourceConceptId:anchor,targetConceptId:added.id});
  await call(`/links/${link.id}/label`,200,"PATCH",{label:"関係を編集"});
  await call(`/links/${link.id}/reconnect`,200,"PATCH",{sourceConceptId:added.id,targetConceptId:anchor});
  const beforeUndo=await call<Undo>(`/maps/${map.id}/undo-redo`,200); assert.equal(beforeUndo.canUndo,true);
  const key=randomUUID();
  await call(`/maps/${map.id}/undo-redo`,200,"POST",{action:"UNDO",expectedSequenceNumber:beforeUndo.sequenceNumber,idempotencyKey:key});
  const redo=await call<Undo>(`/maps/${map.id}/undo-redo`,200); assert.equal(redo.canRedo,true);
  await call(`/maps/${map.id}/undo-redo`,200,"POST",{action:"REDO",expectedSequenceNumber:redo.sequenceNumber,idempotencyKey:randomUUID()});
  await call(`/links/${link.id}`,200,"DELETE",{});
  await call(`/concepts/${added.id}`,200,"DELETE",{});
  const neutral = await call<{id:string}>(`/maps/${map.id}/concepts`,201,"POST",{label:"password",positionX:10,positionY:10});
  await call(`/concepts/${neutral.id}`,200,"DELETE",{});
  const concurrent=await Promise.all(["並行A","並行B"].map(label=>call<{id:string}>(`/maps/${map.id}/concepts`,201,"POST",{label,positionX:20,positionY:20})));
  for (const item of concurrent) await call(`/concepts/${item.id}`,200,"DELETE",{});
  const otherCredential=createLearnerToken();
  const otherClient=await pool.connect();
  try { await otherClient.query("BEGIN");const otherSession=await otherClient.query<{id:string}>(`INSERT INTO sessions(protocol_key,participant_code,lesson_video_url,research_kit_definition_id) VALUES('STAGE1_4',$1,'/test.mp4',$2::uuid) RETURNING id`,[`other-${randomUUID()}`,kit]);await storeLearnerToken(otherClient,otherSession.rows[0]!.id,otherCredential.hash);await otherClient.query("COMMIT"); }
  catch(error){await otherClient.query("ROLLBACK");throw error;}finally{otherClient.release();}
  const beforeUnauthorized=await pool.query<{count:string}>("SELECT count(*)::text AS count FROM research_events WHERE map_id=$1::uuid",[map.id]);
  const wrongSession=await fetch(`${base}/api/maps/${map.id}/concepts`,{method:"POST",headers:{Authorization:`Bearer ${otherCredential.token}`,"Content-Type":"application/json"},body:JSON.stringify({label:"他Session",positionX:1,positionY:1})});
  assert.equal(wrongSession.status,404);
  const anonymous=await fetch(`${base}/api/maps/${map.id}/concepts`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({label:"匿名",positionX:1,positionY:1})});
  assert.equal(anonymous.status,401);
  const wrongSessionCancellation=await fetch(`${base}/api/maps/${map.id}/operation-cancellations/ADD_LINK`,{method:"POST",headers:{Authorization:`Bearer ${otherCredential.token}`}});
  assert.equal(wrongSessionCancellation.status,404);
  const anonymousCancellation=await fetch(`${base}/api/maps/${map.id}/operation-cancellations/ADD_LINK`,{method:"POST"});
  assert.equal(anonymousCancellation.status,401);
  assert.equal((await pool.query<{count:string}>("SELECT count(*)::text AS count FROM research_events WHERE map_id=$1::uuid",[map.id])).rows[0]!.count,beforeUnauthorized.rows[0]!.count);
  const boundary=await pool.query<{count:string}>("SELECT count(*)::text AS count FROM map_history_boundaries WHERE map_id=$1::uuid",[map.id]); assert.equal(boundary.rows[0]!.count,"1");
  const old=await pool.query<{count:string}>("SELECT count(*)::text AS count FROM map_operation_logs WHERE map_id=$1::uuid",[map.id]); assert.equal(old.rows[0]!.count,"1");
  const events=await pool.query<{eventType:string;outcome:string}>(`SELECT event_type AS "eventType",outcome FROM research_events WHERE map_id=$1::uuid ORDER BY sequence_number`,[map.id]);
  for(const type of ["ADD_CONCEPT","EDIT_CONCEPT","MOVE_CONCEPT","ADD_LINK","EDIT_LINK","RECONNECT_LINK","UNDO","REDO","DELETE_LINK","DELETE_CONCEPT"]) assert.ok(events.rows.some(row=>row.eventType===type),type);
  const replay=await call<{status:string;reason?:string}>(`/research/sessions/${sessionId}/maps/${map.id}/mixed-history`,200,"GET",undefined,researcher); assert.equal(replay.status,"REPLAYABLE",replay.reason);
  const count=events.rows.length;
  const beforeReject=await call<{concepts:unknown[]}>(`/maps/${map.id}`,200);
  const rejected=await call<{operationOutcome:string;logSaved:boolean}>(`/maps/${map.id}/concepts`,400,"POST",{label:"https://example.com",positionX:100,positionY:100});
  assert.equal(rejected.operationOutcome,"REJECTED"); assert.equal(rejected.logSaved,true);
  await call(`/maps/${map.id}/concepts`,400,"POST",{label:"概".repeat(513),positionX:100,positionY:100});
  const overLimit=await call<{operationOutcome:string;logSaved:boolean}>(`/maps/${map.id}/concepts`,409,"POST",{label:"座標上限",positionX:10000001,positionY:100});
  assert.equal(overLimit.operationOutcome,"REJECTED"); assert.equal(overLimit.logSaved,true);
  const afterReject=await call<{concepts:unknown[]}>(`/maps/${map.id}`,200);
  assert.deepEqual(afterReject.concepts,beforeReject.concepts);
  const rejectedRows=await pool.query<{eventType:string;outcome:string;reasonCode:string;beforeState:unknown;afterState:unknown}>(
    `SELECT event_type AS "eventType",outcome,reason_code AS "reasonCode",before_state AS "beforeState",after_state AS "afterState"
     FROM research_events WHERE map_id=$1::uuid AND outcome='REJECTED' ORDER BY sequence_number`,[map.id]);
  assert.equal(rejectedRows.rowCount,3);
  assert.ok(rejectedRows.rows.every(row=>row.eventType==="ADD_CONCEPT"&&row.reasonCode==="VALIDATION"&&row.beforeState===null&&row.afterState===null));
  const idemKey=randomUUID();
  const repeatedEventIds:string[]=[];
  for(let retry=0;retry<2;retry++) {
    const response=await fetch(`${base}/api/maps/${map.id}/concepts`,{method:"POST",headers:{Authorization:`Bearer ${credential.token}`,"Content-Type":"application/json","Idempotency-Key":idemKey},body:JSON.stringify({label:"https://retry.example",positionX:1,positionY:1})});
    assert.equal(response.status,400);
    const body=await response.json() as {logSaved:boolean;eventId:string};assert.equal(body.logSaved,true);repeatedEventIds.push(body.eventId);
  }
  assert.equal(repeatedEventIds[0],repeatedEventIds[1]);
  assert.equal((await pool.query("SELECT 1 FROM research_events WHERE map_id=$1::uuid",[map.id])).rowCount,count+4);
  const rejectedReplay=await call<{status:string;reason?:string}>(`/research/sessions/${sessionId}/maps/${map.id}/mixed-history`,200,"GET",undefined,researcher);
  assert.equal(rejectedReplay.status,"REPLAYABLE",rejectedReplay.reason);
  const beforeFailure=await call<{concepts:unknown[]}>(`/maps/${map.id}`,200);
  await pool.query(`CREATE FUNCTION reject_test_event() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END; $$ LANGUAGE plpgsql`);
  await pool.query("CREATE TRIGGER reject_test_event BEFORE INSERT ON research_events FOR EACH ROW EXECUTE FUNCTION reject_test_event()");
  try {
    const failed=await call<{operationOutcome:string;logSaved:boolean}>(`/maps/${map.id}/concepts`,409,"POST",{label:"失敗を確認する概念",positionX:100,positionY:100});
    assert.equal(failed.operationOutcome,"FAILURE"); assert.equal(failed.logSaved,false);
    const afterFailure=await call<{concepts:unknown[]}>(`/maps/${map.id}`,200);
    assert.deepEqual(afterFailure.concepts,beforeFailure.concepts);
    assert.equal((await pool.query("SELECT 1 FROM research_events WHERE map_id=$1::uuid",[map.id])).rowCount,count+4);
  } finally {
    await pool.query("DROP TRIGGER reject_test_event ON research_events");
    await pool.query("DROP FUNCTION reject_test_event()");
  }
  const beforeDbFailure=await pool.query("SELECT id,label FROM concepts WHERE map_id=$1::uuid ORDER BY id",[map.id]);
  await pool.query(`CREATE FUNCTION reject_concept_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'secret exception body must not be recorded'; END; $$ LANGUAGE plpgsql`);
  await pool.query("CREATE TRIGGER reject_concept_insert BEFORE INSERT ON concepts FOR EACH ROW EXECUTE FUNCTION reject_concept_insert()");
  try {
    const failed=await call<{operationOutcome:string;logSaved:boolean;message?:string}>(`/maps/${map.id}/concepts`,500,"POST",{label:"失敗した入力値",positionX:100,positionY:100});
    assert.equal(failed.operationOutcome,"FAILURE");assert.equal(failed.logSaved,true);
    assert.ok(!JSON.stringify(failed).includes("secret exception body"));
    assert.deepEqual((await pool.query("SELECT id,label FROM concepts WHERE map_id=$1::uuid ORDER BY id",[map.id])).rows,beforeDbFailure.rows);
    const failureEvent=await pool.query<{reasonCode:string;details:unknown;beforeState:unknown;afterState:unknown}>(
      `SELECT reason_code AS "reasonCode",details,before_state AS "beforeState",after_state AS "afterState"
       FROM research_events WHERE map_id=$1::uuid AND event_type='ADD_CONCEPT' AND outcome='FAILURE'`,[map.id]);
    assert.equal(failureEvent.rowCount,1);assert.equal(failureEvent.rows[0]!.reasonCode,"SERVER");
    assert.deepEqual(failureEvent.rows[0]!.details,{});assert.equal(failureEvent.rows[0]!.beforeState,null);assert.equal(failureEvent.rows[0]!.afterState,null);
    const afterFailureReplay=await call<{status:string;reason?:string}>(`/research/sessions/${sessionId}/maps/${map.id}/mixed-history`,200,"GET",undefined,researcher);
    assert.equal(afterFailureReplay.status,"REPLAYABLE",afterFailureReplay.reason);
  } finally {
    await pool.query("DROP TRIGGER reject_concept_insert ON concepts");
    await pool.query("DROP FUNCTION reject_concept_insert()");
  }
  await call(`/maps/${map.id}/submit`,200,"POST");
  assert.equal((await pool.query("SELECT 1 FROM research_events WHERE map_id=$1::uuid AND event_type='MAP_SUBMIT'",[map.id])).rowCount,1);
  const beforeSubmitted=await pool.query("SELECT id,label FROM concepts WHERE map_id=$1::uuid ORDER BY id",[map.id]);
  const submittedEdit=await call<{operationOutcome:string;logSaved:boolean}>(`/maps/${map.id}/concepts`,404,"POST",{label:"提出後の編集",positionX:1,positionY:1});
  assert.equal(submittedEdit.operationOutcome,"REJECTED");assert.equal(submittedEdit.logSaved,true);
  assert.deepEqual((await pool.query("SELECT id,label FROM concepts WHERE map_id=$1::uuid ORDER BY id",[map.id])).rows,beforeSubmitted.rows);
  assert.equal((await pool.query("SELECT 1 FROM research_events WHERE map_id=$1::uuid AND event_type='ADD_CONCEPT' AND outcome='REJECTED' AND reason_code='PERMISSION'",[map.id])).rowCount,1);
  const snapshot=(await pool.query("SELECT * FROM map_initial_snapshots WHERE map_id=$1",[map.id])).rows[0];
  await pool.query("DELETE FROM map_initial_snapshots WHERE map_id=$1",[map.id]);
  try{const missing=await call<{status:string;reason:string;state:unknown}>(`/research/sessions/${sessionId}/maps/${map.id}/mixed-history`,200,"GET",undefined,researcher);assert.equal(missing.status,"UNAVAILABLE");assert.equal(missing.state,null);assert.ok(missing.reason.length>0);}finally{await pool.query("INSERT INTO map_initial_snapshots(map_id,snapshot_version,snapshot,captured_at) VALUES($1,$2,$3,$4)",[map.id,snapshot.snapshot_version,snapshot.snapshot,snapshot.captured_at]);}
  console.log("Map API v2 write, rollback, undo, missing snapshot and replay checks succeeded");
} finally { await pool.end(); }
