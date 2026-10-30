import {verifyMockTestUrl} from "./mock-db.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
const waitForSystemPass = () => new Promise<void>(resolve => setTimeout(resolve, 1400));
import { createStage1Session } from "../sessions.js";
await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const token=process.env.RESEARCHER_API_TOKEN!;
const base=process.env.API_BASE_URL??"http://127.0.0.1:3017";
async function api(path:string,status:number,method="GET",body?:unknown,credential=token) {
 const response=await fetch(base+"/api"+path,{method,headers:{Authorization:"Bearer "+credential,...(body===undefined?{}:{"Content-Type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();assert.equal(response.status,status,path+": "+text);
 return {data:response.headers.get("content-type")?.includes("json")?JSON.parse(text):text,logSaved:response.headers.get("x-research-event-saved")};
}
async function autoFixture(group: "CONTROL"|"EXPERIMENTAL" = "EXPERIMENTAL", withMap=true) {
 const c=await pool.connect();
 try {
  await c.query("BEGIN");
  const s=await createStage1Session(c,{participantCode:"system-"+randomUUID(),lessonVideoUrl:"/dummy.mp4",kitDefinitionId:"66666666-6666-4666-8666-666666666662",studyGroup:group,groupActivitySeconds:60});
  const stage=s.stages.find(st=>st.stageType===(group==="CONTROL"?"SELF_STUDY":"INTEGRATION_MAP"))!;
  await c.query("UPDATE sessions SET status='IN_PROGRESS',started_at=now() WHERE id=$1",[s.id]);
  await c.query("UPDATE session_stages SET status='COMPLETED',started_at=now(),completed_at=now() WHERE session_id=$1 AND order_index<$2",[s.id,stage.orderIndex]);
  await c.query("UPDATE session_stages SET status='IN_PROGRESS',started_at=now()-interval '2 minutes' WHERE id=$1",[stage.id]);
  const map=withMap&&group==="EXPERIMENTAL"?await c.query("INSERT INTO maps(type,session_stage_id) VALUES('INTEGRATION',$1) RETURNING id",[stage.id]):{rows:[{id:null}]};
  if(map.rows[0].id) {
    const snapshot={snapshotVersion:1,mapId:map.rows[0].id,mapType:"INTEGRATION",basedOnMapId:null,kitDefinitionId:null,concepts:[],links:[]};
    await c.query("INSERT INTO map_initial_snapshots(map_id,snapshot_version,snapshot) VALUES($1,1,$2::jsonb)",[map.rows[0].id,JSON.stringify(snapshot)]);
  }
  await c.query("COMMIT");return {session:s.id,stage:stage.id,map:map.rows[0].id};
 }catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
}
try {
 await api("/research/stage1/settings",200,"PUT",{minutes:2});
 await api("/research/stage1/settings",400,"PUT",{minutes:-1});
 const created=(await api("/research/stage1/sessions",201,"POST",{participantCode:"audit-"+randomUUID(),videoUrl:"/dummy.mp4",kitDefinitionId:"66666666-6666-4666-8666-666666666662",studyGroup:"CONTROL"})).data;
 let events=(await api("/research/sessions/"+created.id+"/events",200)).data.events;
 assert.equal(events.filter((e:{eventType:string})=>e.eventType==="SESSION_CREATE").length,1);
 assert.equal(events[0].actorType,"RESEARCHER");
 assert.ok(!JSON.stringify(events).includes(created.learnerAccessToken));
 await api("/research/sessions/"+created.id+"/export",409);
 await api("/research/sessions/"+created.id+"/events",403,"GET",undefined,created.learnerAccessToken);
 await api("/research/system/events",403,"GET",undefined,created.learnerAccessToken);
 await api("/research/stage1/settings",401,"PUT",{minutes:2},"invalid");
 const forged={schemaVersion:1,eventType:"MAP_AUTO_SUBMIT",targetType:"MAP",mapId:randomUUID(),outcome:"SUCCESS",clientTimeQuality:"NOT_APPLICABLE"};
 await api("/sessions/"+created.id+"/events",403,"POST",forged,created.learnerAccessToken);
 await api("/sessions/"+created.id+"/events",403,"POST",forged);
 const before=await pool.query("SELECT learner_access_token_hash FROM sessions WHERE id=$1",[created.id]);
 await pool.query("CREATE OR REPLACE FUNCTION issue7_fail_audit() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''private-exception-token''; END'");
 await pool.query("CREATE TRIGGER issue7_fail_audit BEFORE INSERT ON research_events FOR EACH ROW WHEN(NEW.schema_version IN(2,4,5) AND NEW.outcome='SUCCESS') EXECUTE FUNCTION issue7_fail_audit()");
 try {
  const rejectedCode="rollback-"+randomUUID();
  const creationFailed=await api("/research/stage1/sessions",500,"POST",{participantCode:rejectedCode,videoUrl:"/dummy.mp4",kitDefinitionId:"66666666-6666-4666-8666-666666666662",studyGroup:"CONTROL"});
  assert.equal(creationFailed.logSaved,"true");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sessions WHERE participant_code=$1",[rejectedCode])).rows[0].n,0);
  const failed=await api("/research/stage1/sessions/"+created.id+"/learner-token",500,"POST",{});
  assert.equal(failed.logSaved,"true");
  assert.ok(!JSON.stringify(failed).includes("private-exception-token"));
  assert.deepEqual((await pool.query("SELECT learner_access_token_hash FROM sessions WHERE id=$1",[created.id])).rows,before.rows);
  const failure=await autoFixture();
  await Promise.all([waitForSystemPass(),waitForSystemPass()]);
  assert.equal((await pool.query("SELECT status FROM maps WHERE id=$1",[failure.map])).rows[0].status,"DRAFT");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM research_events WHERE map_id=$1 AND event_type='MAP_AUTO_SUBMIT' AND outcome='FAILURE'",[failure.map])).rows[0].n,1);
 } finally {await pool.query("DROP TRIGGER issue7_fail_audit ON research_events");}
 await Promise.all([waitForSystemPass(),waitForSystemPass(),waitForSystemPass()]);
 const control=await autoFixture("CONTROL");
 const missing=await autoFixture("EXPERIMENTAL",false);
 await Promise.all([waitForSystemPass(),waitForSystemPass()]);
 for(const fixture of [control,missing]) {
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM research_events WHERE stage_id=$1 AND event_type='STAGE_DEADLINE' AND outcome='SUCCESS'",[fixture.stage])).rows[0].n,1);
  assert.equal((await pool.query("SELECT status FROM session_stages WHERE id=$1",[fixture.stage])).rows[0].status,"IN_PROGRESS");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM maps WHERE session_stage_id=$1",[fixture.stage])).rows[0].n,0);
 }
 const auto=await pool.query("SELECT map_id,count(*)::int AS n FROM research_events WHERE schema_version IN (2,5) AND event_type='MAP_AUTO_SUBMIT' AND outcome='SUCCESS' GROUP BY map_id");
 assert.ok(auto.rowCount);assert.ok(auto.rows.every(row=>row.n===1));
 const invalid=await pool.query("SELECT count(*)::int AS n FROM research_events e JOIN maps m ON m.id=e.map_id JOIN session_stages st ON st.id=m.session_stage_id WHERE e.event_type='MAP_AUTO_SUBMIT' AND e.outcome='SUCCESS' AND (m.status<>'SUBMITTED' OR m.auto_submitted_at IS NULL OR e.actor_type<>'SYSTEM')");
 assert.equal(invalid.rows[0].n,0);
 const goal=await pool.query("INSERT INTO maps(type) VALUES('GOAL') RETURNING id");
 const concept=await pool.query("INSERT INTO concepts(map_id,label,position_x,position_y) VALUES($1,'Dummy',0,0) RETURNING id",[goal.rows[0].id]);
 await api("/concepts/"+concept.rows[0].id,200,"DELETE");
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM concepts WHERE id=$1",[concept.rows[0].id])).rows[0].n,0);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM research_events WHERE target_id=$1 AND schema_version=4 AND event_type='DELETE_CONCEPT' AND outcome='SUCCESS'",[concept.rows[0].id])).rows[0].n,1);
 const completed=await pool.query("SELECT id FROM sessions WHERE protocol_key='STAGE1_4' AND status='COMPLETED' LIMIT 1");
 assert.ok(completed.rows[0],"Run Stage1 integration first to provide a completed legacy fixture");
 const id=completed.rows[0].id;
 await api("/research/stage1/sessions/"+id+"/analysis",200);
 await api("/research/sessions/"+id+"/export",200);
 await api("/research/stage1/sessions/"+id+"/operations.csv",200);
 events=(await api("/research/sessions/"+id+"/events",200)).data.events;
 assert.ok(events.some((e:{eventType:string})=>e.eventType==="RESEARCH_ANALYSIS_VIEW"));
 assert.ok(events.some((e:{eventType:string})=>e.eventType==="RESEARCH_EXPORT"));
 const all=(await pool.query("SELECT * FROM research_events WHERE schema_version=4")).rows;
 assert.ok(all.every(e=>e.before_state===null&&e.after_state===null&&JSON.stringify(e.details)==="{}"));
 assert.ok(!JSON.stringify(all).includes(token));assert.ok(!JSON.stringify(all).includes("private-exception-token"));
 const global=(await api("/research/system/events",200)).data.events;
 assert.ok(global.some((e:{eventType:string;outcome:string})=>e.eventType==="SESSION_SETTINGS_CHANGE"&&e.outcome==="SUCCESS"));
 assert.ok(global.some((e:{eventType:string;outcome:string})=>e.eventType==="SESSION_SETTINGS_CHANGE"&&e.outcome==="REJECTED"));
 await pool.query("CREATE TRIGGER issue7_fail_audit BEFORE INSERT ON research_events FOR EACH ROW WHEN(NEW.schema_version=4) EXECUTE FUNCTION issue7_fail_audit()");
 try {
  const delivered=await api("/research/stage1/sessions/"+id+"/analysis",200);
  assert.equal(delivered.logSaved,"false");
  const settingsBefore=(await pool.query("SELECT group_activity_seconds FROM research_settings WHERE id=1")).rows;
  const failed=await api("/research/stage1/settings",500,"PUT",{minutes:3});
  assert.equal(failed.logSaved,"false");
  assert.deepEqual((await pool.query("SELECT group_activity_seconds FROM research_settings WHERE id=1")).rows,settingsBefore);
 }finally {await pool.query("DROP TRIGGER issue7_fail_audit ON research_events");}
 console.log("Researcher/system audit API, atomic failure, deletion retention, recovery and concurrency: OK");
} finally {await pool.end();}

