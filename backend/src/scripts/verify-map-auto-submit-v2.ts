import {verifyMockTestUrl} from "./mock-db.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sessionId=randomUUID(), stageId=randomUUID(), mapId=randomUUID();
const kitId="66666666-6666-4666-8666-666666666662";
try {
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO sessions(id,status,started_at,protocol_key,participant_code,lesson_video_url,research_kit_definition_id,study_group,group_activity_seconds) VALUES($1::uuid,'IN_PROGRESS',clock_timestamp()-interval '2 minutes','STAGE1_6',$2,'/test.mp4',$3::uuid,'EXPERIMENTAL',1)`,[sessionId,`test-${randomUUID()}`,kitId]);
    await client.query(`INSERT INTO session_stages(id,session_id,stage_type,order_index,status,started_at) VALUES($1::uuid,$2::uuid,'INTEGRATION_MAP',0,'IN_PROGRESS',clock_timestamp()-interval '1 minute')`,[stageId,sessionId]);
    await client.query(`INSERT INTO maps(id,type,status,session_stage_id,kit_definition_id) VALUES($1::uuid,'INTEGRATION','DRAFT',$2::uuid,$3::uuid)`,[mapId,stageId,kitId]);
    const snapshot={snapshotVersion:1,mapId,mapType:"INTEGRATION",basedOnMapId:null,kitDefinitionId:kitId,concepts:[],links:[]};
    await client.query(`INSERT INTO map_initial_snapshots(map_id,snapshot_version,snapshot) VALUES($1::uuid,1,$2::jsonb)`,[mapId,JSON.stringify(snapshot)]);
    await client.query("COMMIT");
  } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  let submitted=false;
  for(let i=0;i<50;i++) {
    const result=await pool.query<{status:string}>("SELECT status FROM maps WHERE id=$1::uuid",[mapId]);
    if(result.rows[0]?.status==="SUBMITTED") { submitted=true; break; }
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.ok(submitted,"Expired integration was not auto-submitted");
  const event=await pool.query<{actorType:string;outcome:string}>(`SELECT actor_type AS "actorType",outcome FROM research_events WHERE map_id=$1::uuid AND event_type='MAP_AUTO_SUBMIT'`,[mapId]);
  assert.equal(event.rowCount,1); assert.equal(event.rows[0]!.actorType,"SYSTEM"); assert.equal(event.rows[0]!.outcome,"SUCCESS");
  const stage=await pool.query<{status:string}>("SELECT status FROM session_stages WHERE id=$1::uuid",[stageId]); assert.equal(stage.rows[0]!.status,"IN_PROGRESS");
  const response=await fetch(`${process.env.API_BASE_URL}/api/research/sessions/${sessionId}/maps/${mapId}/mixed-history`,{headers:{Authorization:`Bearer ${process.env.RESEARCHER_API_TOKEN}`}});
  assert.equal(response.status,200); const result=await response.json() as {status:string;reason?:string}; assert.equal(result.status,"REPLAYABLE",result.reason);
  await pool.query("UPDATE session_stages SET order_index=4,status='COMPLETED',completed_at=clock_timestamp() WHERE id=$1::uuid",[stageId]);
  for (const [order,type] of ["LESSON","PRIOR_MAP","KB_MAP","PRE_ASSESSMENT","INTEGRATION_MAP","POST_ASSESSMENT"].entries()) {
    if(type==="INTEGRATION_MAP") continue;
    await pool.query(`INSERT INTO session_stages(session_id,stage_type,order_index,status,started_at,completed_at)
      VALUES($1::uuid,$2,$3,'COMPLETED',clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute')`,[sessionId,type,order]);
  }
  await pool.query("UPDATE sessions SET status='COMPLETED',completed_at=clock_timestamp() WHERE id=$1::uuid",[sessionId]);
  const exported=await fetch(`${process.env.API_BASE_URL}/api/research/sessions/${sessionId}/export`,{headers:{Authorization:`Bearer ${process.env.RESEARCHER_API_TOKEN}`}});
  assert.equal(exported.status,200);
  const raw=await exported.json() as {maps:Array<{id:string;operationLogs:Array<{eventType:string;actorType:string;serverTimestamp:string;historySource:string}>}>};
  const auto=raw.maps.find(map=>map.id===mapId)?.operationLogs.find(item=>item.eventType==="MAP_AUTO_SUBMIT");
  assert.equal(auto?.historySource,"EVENT"); assert.equal(auto.actorType,"SYSTEM"); assert.ok(auto.serverTimestamp);
  console.log("Automatic submission event and replay checks succeeded");
} finally { await pool.end(); }
