import {verifyMockTestUrl} from "./mock-db.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Pool } from "pg";
import { createStage1Session } from "../sessions.js";
import { randomUUID } from "node:crypto";
await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const pool=new Pool({connectionString:process.env.DATABASE_URL});
let child:ChildProcess|undefined;
async function start(){child=spawn(process.execPath,["--import","tsx","src/index.ts"],{env:{...process.env,PORT:"0"},stdio:"ignore",windowsHide:true});}
async function stop(){if(child&&child.exitCode===null){const exited=once(child,"exit");child.kill();await exited;}child=undefined;}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
try {
 const c=await pool.connect();let mapId:string,stageId:string;
 try {
  await c.query("BEGIN");
  const s=await createStage1Session(c,{participantCode:"restart-"+randomUUID(),lessonVideoUrl:"/dummy.mp4",kitDefinitionId:"66666666-6666-4666-8666-666666666662",studyGroup:"EXPERIMENTAL",groupActivitySeconds:60});
  const st=s.stages.find(x=>x.stageType==="INTEGRATION_MAP")!;stageId=st.id;
  await c.query("UPDATE sessions SET status='IN_PROGRESS',started_at=now() WHERE id=$1",[s.id]);
  await c.query("UPDATE session_stages SET status='COMPLETED',started_at=now(),completed_at=now() WHERE session_id=$1 AND order_index<$2",[s.id,st.orderIndex]);
  await c.query("UPDATE session_stages SET status='IN_PROGRESS',started_at=now()-interval '5 minutes' WHERE id=$1",[stageId]);
  mapId=(await c.query("INSERT INTO maps(type,session_stage_id) VALUES('INTEGRATION',$1) RETURNING id",[stageId])).rows[0].id;
  const snapshot={snapshotVersion:1,mapId,mapType:"INTEGRATION",basedOnMapId:null,kitDefinitionId:null,concepts:[],links:[]};
  await c.query("INSERT INTO map_initial_snapshots(map_id,snapshot_version,snapshot) VALUES($1,1,$2::jsonb)",[mapId,JSON.stringify(snapshot)]);
  await c.query("COMMIT");
 }catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
 assert.equal((await pool.query("SELECT status FROM maps WHERE id=$1",[mapId])).rows[0].status,"DRAFT");
 await start();
 let submitted=false;
 for(let i=0;i<150;i++){
  if((await pool.query("SELECT status FROM maps WHERE id=$1",[mapId])).rows[0].status==="SUBMITTED"){submitted=true;break;}
  await pause(100);
 }
 assert.equal(submitted,true,"startup must recover an expired Map without a browser");
 await stop();await start();await pause(1800);await stop();
 const events=await pool.query("SELECT actor_type,outcome FROM research_events WHERE map_id=$1 AND event_type='MAP_AUTO_SUBMIT'",[mapId]);
 assert.equal(events.rowCount,1);assert.deepEqual(events.rows[0],{actor_type:"SYSTEM",outcome:"SUCCESS"});
 assert.equal((await pool.query("SELECT status FROM session_stages WHERE id=$1",[stageId])).rows[0].status,"IN_PROGRESS");
 console.log("Actual API restart recovery and duplicate prevention: OK");
}finally{await stop();await pool.end();}

