import {verifyMockTestUrl} from "./mock-db.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const researcher=process.env.RESEARCHER_API_TOKEN!,base=process.env.API_BASE_URL!;
const kit="66666666-6666-4666-8666-666666666662";
async function api(path:string,status=200,method="GET",body?:unknown,token=researcher){
 const r=await fetch(base+"/api"+path,{method,headers:{Authorization:"Bearer "+token,...(body===undefined?{}:{"Content-Type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body)});
 const text=await r.text();assert.equal(r.status,status,path+": "+text);return JSON.parse(text);
}
try{
 await api("/research/stage1/settings",200,"PUT",{minutes:1});
 const s=await api("/research/stage1/sessions",201,"POST",{participantCode:"integrated-"+randomUUID(),videoUrl:"/dummy.mp4",kitDefinitionId:kit,studyGroup:"EXPERIMENTAL"});
 const learner=s.learnerAccessToken as string;
 const call=(path:string,status=200,method="GET",body?:unknown)=>api(path,status,method,body,learner);
 const stage=(type:string)=>s.stages.find((st:{stageType:string})=>st.stageType===type);
 await api("/research/stage1/sessions/"+s.id+"/assessment/questions",200,"PUT",{questions:[{category:"DESCRIPTION",prompt:"Dummy 1"},{category:"DESCRIPTION",prompt:"Dummy 2"}]});
 await call("/sessions/"+s.id+"/start",200,"POST",{});
 await call("/session-stages/"+stage("LESSON").id+"/start",200,"POST",{});
 await call("/session-stages/"+stage("LESSON").id+"/complete",200,"POST",{});
 const priorStage=stage("PRIOR_MAP");
 await call("/session-stages/"+priorStage.id+"/start",200,"POST",{});
 const prior=await call("/session-stages/"+priorStage.id+"/prior-map",201,"POST",{});
 const concept=await call("/maps/"+prior.id+"/concepts",201,"POST",{label:"Integration check",positionX:100,positionY:150});
 await api("/concepts/"+concept.id,200,"DELETE");
 const deletion=(await pool.query("SELECT schema_version,actor_type FROM research_events WHERE event_type='DELETE_CONCEPT' AND target_id=$1 AND outcome='SUCCESS'",[concept.id])).rows;
 assert.deepEqual(deletion,[{schema_version:5,actor_type:"RESEARCHER"}]);
 await call("/maps/"+prior.id+"/submit",200,"POST",{});
 const kbStage=stage("KB_MAP");
 await call("/session-stages/"+kbStage.id+"/start",200,"POST",{});
 const kb=await call("/kits/"+kit+"/kb-map",201,"POST",{sessionStageId:kbStage.id});
 await call("/maps/"+kb.id+"/kit-feedback");
 await call("/maps/"+kb.id+"/submit",409,"POST",{});
 const rejections=await pool.query("SELECT schema_version,outcome FROM research_events WHERE map_id=$1 AND event_type='MAP_SUBMIT'",[kb.id]);
 assert.deepEqual(rejections.rows,[{schema_version:5,outcome:"REJECTED"}]);
 const parts=await pool.query("SELECT id,source_concept_id FROM kit_concept_items WHERE kit_definition_id=$1 ORDER BY id",[kit]);
 const imported=new Map<string,string>();
 for(const [i,item] of parts.rows.entries()){
  const concept=await call("/maps/"+kb.id+"/kit-concepts/"+item.id+"/import",201,"POST",{positionX:100+i*180,positionY:100});
  imported.set(item.source_concept_id,concept.id);
 }
 const links=await pool.query("SELECT k.id,l.source_concept_id,l.target_concept_id FROM kit_link_items k JOIN links l ON l.id=k.source_link_id WHERE k.kit_definition_id=$1 ORDER BY k.id",[kit]);
 for(const item of links.rows)await call("/maps/"+kb.id+"/kit-links/"+item.id,201,"POST",{sourceConceptId:imported.get(item.source_concept_id),targetConceptId:imported.get(item.target_concept_id)});
 assert.equal((await call("/maps/"+kb.id+"/kit-feedback")).matched,true);
 await call("/maps/"+kb.id+"/kit-feedback/display",200,"POST",{});
 await call("/maps/"+kb.id+"/submit",200,"POST",{});
 for(const type of ["PRE_ASSESSMENT","POST_ASSESSMENT"]){
  if(type==="POST_ASSESSMENT"){
   const group=stage("INTEGRATION_MAP");await call("/session-stages/"+group.id+"/start",200,"POST",{});
   const integration=await call("/session-stages/"+group.id+"/integration-map",201,"POST",{});
   const map=await call("/maps/"+integration.id);
   if(!map.kitDefinitionId)await call("/maps/"+integration.id+"/kit-definition",200,"PATCH",{kitDefinitionId:kit});
   await pool.query("UPDATE session_stages SET started_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",[group.id]);
   let submitted=false;
   for(let i=0;i<60;i++){if((await pool.query("SELECT status FROM maps WHERE id=$1",[integration.id])).rows[0].status==="SUBMITTED"){submitted=true;break;}await new Promise(r=>setTimeout(r,200));}
   assert.ok(submitted);
   const auto=(await pool.query("SELECT schema_version,actor_type FROM research_events WHERE map_id=$1 AND event_type='MAP_AUTO_SUBMIT' AND outcome='SUCCESS'",[integration.id])).rows;
   assert.deepEqual(auto,[{schema_version:5,actor_type:"SYSTEM"}]);
   await call("/session-stages/"+group.id+"/complete",200,"POST",{});
  }
  const st=stage(type);await call("/session-stages/"+st.id+"/start",200,"POST",{});
  const questions=(await call("/session-stages/"+st.id+"/assessment")).questions;
  await call("/session-stages/"+st.id+"/assessment/submit",200,"POST",{answers:questions.map((q:{id:string})=>({questionId:q.id,answer:"Only assessment history contains this text"}))});
 }
 for(const map of (await pool.query("SELECT m.id FROM maps m JOIN session_stages st ON st.id=m.session_stage_id WHERE st.session_id=$1",[s.id])).rows){
  const replay=await api("/research/sessions/"+s.id+"/maps/"+map.id+"/mixed-history");
  assert.equal(replay.status,"REPLAYABLE",replay.reason);
 }
 const exported=await api("/research/sessions/"+s.id+"/export");
 assert.ok(exported.assessment.events.some((e:{schemaVersion:number})=>e.schemaVersion===3));
 const events=(await api("/research/sessions/"+s.id+"/events")).events;
 assert.deepEqual([...new Set(events.map((e:{schemaVersion:number})=>e.schemaVersion))].sort(),[1,3,4,5,6]);
 assert.ok(!JSON.stringify(events.filter((e:{schemaVersion:number})=>e.schemaVersion!==3)).includes("Only assessment history contains this text"));
 for(const id of [prior.id,kb.id])assert.equal((await pool.query("SELECT count(*)::int AS n FROM research_events WHERE map_id=$1 AND event_type='MAP_SUBMIT' AND outcome='SUCCESS'",[id])).rows[0].n,1);
 await call("/research/sessions/"+s.id+"/events",403);
 console.log("Integrated current six-stage flow (new Map v5 / feedback v6), unique Map operations, assessment Export and DB replay: OK");
}finally{await pool.end();}

