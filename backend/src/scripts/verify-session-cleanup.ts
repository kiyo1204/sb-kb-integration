import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { verifyMockTestUrl } from "./mock-db.js";
import { createFiveActivitySession, createStage1Session } from "../sessions.js";
import { createLearnerToken, storeLearnerToken } from "../access-control.js";
const url=process.env.DATABASE_URL!;
await verifyMockTestUrl(url);
const pool=new Pool({connectionString:url});
const base=process.env.API_BASE_URL!;
const researcher=process.env.RESEARCHER_API_TOKEN!;
async function call(path:string,body:unknown,token=researcher) {
  const r=await fetch(base+path,{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json","Idempotency-Key":randomUUID()},body:JSON.stringify(body)});
  return {status:r.status,body:await r.json()};
}
const cleanup=(id:string,token=researcher)=>call("/api/research/data-management/cleanup",{sessionId:id,confirm:"DELETE_UNSTARTED"},token);
async function fixture(old=false) {
  const c=await pool.connect();
  try { await c.query("BEGIN");
    const input={participantCode:"MOCK-CLEANUP",lessonVideoUrl:"/mock.mp4",kitDefinitionId:"66666666-6666-4666-8666-666666666662",groupActivitySeconds:60};
    const s=old?await createStage1Session(c,{...input,studyGroup:"CONTROL"}):await createFiveActivitySession(c,input);
    const token=createLearnerToken();await storeLearnerToken(c,s.id,token.hash);
    await c.query("COMMIT");return {...s,token:token.token};
  } finally {c.release();}
}
const exists=async(id:string)=>(await pool.query("SELECT * FROM sessions WHERE id=$1",[id])).rows[0];
async function reject(id:string) {const result=await cleanup(id);assert.equal(result.status,409);assert.equal(result.body.error,"confirmed_deletion_required");assert.equal(result.body.managementUrl,"/research/data-management");assert.ok(await exists(id));}
try {
  const keep=await fixture();const shared=await pool.query("SELECT id,title FROM maps WHERE type='GOAL' ORDER BY id");
  for(const old of [false,true]) {
    const s=await fixture(old);const stage=s.stages.find(x=>x.stageType==='PRIOR_MAP')!;
    const map=(await pool.query("INSERT INTO maps(type,session_stage_id) VALUES('PRIOR',$1) RETURNING id",[stage.id])).rows[0].id;
    const concept=(await pool.query("INSERT INTO concepts(map_id,label,position_x,position_y) VALUES($1,'initial',0,0) RETURNING id",[map])).rows[0].id;
    await pool.query("INSERT INTO map_initial_snapshots(map_id,snapshot_version,snapshot) VALUES($1,1,$2)",[map,JSON.stringify({concepts:[{id:concept,label:'initial',positionX:0,positionY:0}],links:[]})]);
    await pool.query("INSERT INTO research_events(schema_version,session_id,participant_code,activity,actor_type,event_type,target_type,outcome,sequence_number,client_time_quality,before_quality,after_quality) VALUES(1,$1,'MOCK','SESSION','RESEARCHER','SESSION_CREATE','SESSION','SUCCESS',1,'NOT_APPLICABLE','NOT_APPLICABLE','NOT_APPLICABLE')",[s.id]);
    const seed=(await pool.query("SELECT id FROM kit_concept_items WHERE kit_definition_id='66666666-6666-4666-8666-666666666662' LIMIT 1")).rows[0].id;
    await pool.query("INSERT INTO session_seed_concepts(session_id,kit_concept_item_id) VALUES($1,$2)",[s.id,seed]);
    await pool.query("INSERT INTO survey_questions(session_id,kind,prompt,required,display_order,config) VALUES($1,'TEXT','unused setting',true,0,'{}')",[s.id]);
    const r=await cleanup(s.id);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(await exists(s.id),undefined);
    for(const [table,where] of [['maps','id'],['concepts','map_id'],['map_initial_snapshots','map_id']]) assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE ${where}=$1`,[map])).rowCount,0);
    for(const table of ['survey_questions','session_seed_concepts','session_stages']) assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE session_id=$1`,[s.id])).rowCount,0);
    assert.equal((await pool.query("SELECT 1 FROM research_deletion_receipts WHERE id=$1",[r.body.receiptId])).rowCount,1);
    assert.equal((await fetch(base+"/api/research/stage1/sessions",{headers:{Authorization:"Bearer "+researcher}}).then(r=>r.json())).sessions.some((x:{id:string})=>x.id===s.id),false);
  }
  const started=await fixture();assert.equal((await call(`/api/sessions/${started.id}/start`,{},started.token)).status,200);await reject(started.id);
  const events=await fixture();await pool.query("INSERT INTO research_events(schema_version,session_id,participant_code,activity,actor_type,event_type,target_type,outcome,sequence_number,client_time_quality,before_quality,after_quality) VALUES(1,$1,'MOCK','LESSON','LEARNER','SCREEN_ENTER','SCREEN','SUCCESS',1,'MISSING','MISSING','MISSING')",[events.id]);await reject(events.id);
  const delivery=await fixture();await pool.query("INSERT INTO client_delivery_reports(session_id,client_id,report_sequence,pending,retrying,acknowledged,attempts,last_response,capacity_lost,expired_lost,rejected_lost,storage_lost) VALUES($1,$2,1,0,0,0,0,'NONE',0,0,0,0)",[delivery.id,randomUUID()]);await reject(delivery.id);
  const answers=await fixture();const stage=answers.stages.find(x=>x.stageType==='SURVEY')!;
  const q=(await pool.query("INSERT INTO survey_questions(session_id,kind,prompt,required,display_order,config) VALUES($1,'TEXT','MOCK',true,0,'{}') RETURNING id",[answers.id])).rows[0].id;
  await pool.query("INSERT INTO survey_answers(session_id,stage_id,question_id,answer) VALUES($1,$2,$3,'\"MOCK\"')",[answers.id,stage.id,q]);await reject(answers.id);
  const emptyChanged=await fixture();const changedMap=(await pool.query("INSERT INTO maps(type,session_stage_id) VALUES('PRIOR',$1) RETURNING id",[emptyChanged.stages.find(x=>x.stageType==='PRIOR_MAP')!.id])).rows[0].id;
  await pool.query("INSERT INTO map_initial_snapshots(map_id,snapshot_version,snapshot) VALUES($1,1,$2)",[changedMap,JSON.stringify({concepts:[{id:randomUUID(),label:'previous data',positionX:0,positionY:0}],links:[]})]);await reject(emptyChanged.id);
  const history=await fixture();const map=(await pool.query("INSERT INTO maps(type,session_stage_id) VALUES('PRIOR',$1) RETURNING id",[history.stages.find(x=>x.stageType==='PRIOR_MAP')!.id])).rows[0].id;
  await pool.query("INSERT INTO map_operation_logs(map_id,operation_type,target_type,target_id,sequence_number) VALUES($1,'MAP_SAVE','MAP',$1,1)",[map]);await reject(history.id);
  const submitted=await fixture();await pool.query("INSERT INTO maps(type,session_stage_id,status,submitted_at) VALUES('PRIOR',$1,'SUBMITTED',now())",[submitted.stages.find(x=>x.stageType==='PRIOR_MAP')!.id]);await reject(submitted.id);
  assert.equal((await cleanup(keep.id,"")).status,401);assert.equal((await cleanup(keep.id,keep.token)).status,403);assert.equal((await cleanup(keep.id,events.token)).status,403);
  const failed=await fixture();const receipts=(await pool.query("SELECT count(*)::int n FROM research_deletion_receipts")).rows[0].n;
  await pool.query(`CREATE FUNCTION public.mock_cleanup_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='${failed.id}'::uuid THEN RAISE EXCEPTION 'mock failure'; END IF; RETURN OLD; END $$; CREATE TRIGGER mock_cleanup_fail BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION public.mock_cleanup_fail()`);
  try {const r=await cleanup(failed.id);assert.equal(r.status,409);assert.ok(await exists(failed.id));assert.equal((await pool.query("SELECT count(*)::int n FROM research_deletion_receipts")).rows[0].n,receipts);assert.equal((await pool.query("SELECT count(*)::int n FROM session_stages WHERE session_id=$1",[failed.id])).rows[0].n,5);assert.ok(!JSON.stringify(r).includes('mock failure'));}
  finally {await pool.query("DROP TRIGGER mock_cleanup_fail ON sessions; DROP FUNCTION public.mock_cleanup_fail()");}
  // Force cleanup to wait behind an uncommitted start, then recheck the committed state.
  const locked=await fixture();const lock=await pool.connect();
  await lock.query("BEGIN");await lock.query("UPDATE sessions SET status='IN_PROGRESS',started_at=clock_timestamp() WHERE id=$1",[locked.id]);
  const waiting=cleanup(locked.id);
  try {
    const deadline=Date.now()+5000;let observed=false;
    while(Date.now()<deadline) {
      if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'LOCK TABLE %' LIMIT 1")).rowCount){observed=true;break;}
      await new Promise(r=>setTimeout(r,20));
    }
    assert.ok(observed,'cleanup must wait for concurrent start transaction');await lock.query("COMMIT");
    assert.equal((await waiting).body.error,'confirmed_deletion_required');assert.equal((await exists(locked.id)).status,'IN_PROGRESS');
  } finally {await lock.query("ROLLBACK");lock.release();}
  // Real API races: either cleanup wins before start, or the started Session survives.
  for(let i=0;i<6;i++) {const s=await fixture();const [d,start]=await Promise.all([cleanup(s.id),call(`/api/sessions/${s.id}/start`,{},s.token)]);const saved=await exists(s.id);if(start.status===200){assert.ok(saved);assert.equal(saved.status,'IN_PROGRESS');assert.notEqual(d.status,200);}if(d.status===200){assert.equal(saved,undefined);assert.notEqual(start.status,200);}}
  for(let i=0;i<4;i++) {
    const s=await fixture();const st=s.stages.find(x=>x.stageType==='LESSON')!;
    const [d]=await Promise.all([cleanup(s.id),call(`/api/session-stages/${st.id}/start`,{},s.token)]);
    if(d.status===200) assert.equal((await pool.query("SELECT 1 FROM operation_receipts WHERE principal_scope=$1",['LEARNER:'+s.id])).rowCount,0);
  }
  assert.deepEqual((await pool.query("SELECT id,title FROM maps WHERE type='GOAL' ORDER BY id")).rows,shared.rows);assert.ok(await exists(keep.id));
  assert.equal((await pool.query("SELECT 1 FROM session_stages st LEFT JOIN sessions s ON s.id=st.session_id WHERE s.id IS NULL")).rowCount,0);
  console.log("Session cleanup: old/new pristine resources, audit receipt, list removal, started/events/answers/history/submission/delivery rejection, auth, rollback, start races and shared resources: PASS");
} finally {await pool.end();}
