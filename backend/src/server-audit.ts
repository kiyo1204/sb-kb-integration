import { AsyncLocalStorage } from "node:async_hooks";
import type { Express, Response } from "express";
import type { Pool, PoolClient } from "pg";
import { principalOf, tokenHash } from "./access-control.js";
import { eventTargets, type EventType, type EventOutcome } from "./research-events.js";
type Audit = { eventType: EventType; sessionId?: string; stageId?: string; mapId?: string; targetId?: string; committed?: boolean; pending?: boolean };
export const auditContext = new AsyncLocalStorage<Audit>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowed = new Set<EventType>(["STAGE_DEADLINE","SESSION_CREATE","SESSION_SETTINGS_CHANGE","RESEARCH_ANALYSIS_VIEW","RESEARCH_EXPORT","RESEARCH_ASSESSMENT_CHANGE","DELETE_CONCEPT","DELETE_LINK","MAP_AUTO_SUBMIT"]);
export async function insertAudit(client: PoolClient, context: Audit, actor: "RESEARCHER" | "SYSTEM", outcome: EventOutcome = "SUCCESS", reasonCode?: "VALIDATION" | "CONFLICT" | "SERVER" | "DEADLINE" | "USER_CANCELLED", dedupKey?: string) {
 if (!allowed.has(context.eventType) || !["RESEARCHER","SYSTEM"].includes(actor)) throw new Error("invalid_audit");
 for (const id of [context.sessionId,context.stageId,context.mapId,context.targetId]) if(id && !uuid.test(id)) throw new Error("invalid_audit");
 if(context.eventType==="STAGE_DEADLINE" && (actor!=="SYSTEM" || !context.stageId || !context.sessionId)) throw new Error("invalid_audit");
 if(context.eventType==="MAP_AUTO_SUBMIT" && (actor!=="SYSTEM" || !context.mapId)) throw new Error("invalid_audit");
 let {sessionId,stageId} = context;
 if(context.mapId) {
  const map = await client.query<{sessionId:string|null;stageId:string|null}>('SELECT st.session_id AS "sessionId",st.id AS "stageId" FROM maps m LEFT JOIN session_stages st ON st.id=m.session_stage_id WHERE m.id=$1', [context.mapId]);
  const item=map.rows[0]; if(!item || (sessionId && sessionId!==item.sessionId) || (stageId && stageId!==item.stageId)) throw new Error("invalid_audit_target");
  sessionId=item.sessionId??undefined;stageId=item.stageId??undefined;
 }
 const session=sessionId ? await client.query<{participantCode:string;studyGroup:string|null}>('SELECT participant_code AS "participantCode",study_group AS "studyGroup" FROM sessions WHERE id=$1 AND protocol_key IN (\'STAGE1_4\',\'STAGE1_6\')',[sessionId]) : null;
 if(sessionId && !session?.rowCount) throw new Error("invalid_audit_target");
 const participant=session?.rows[0]?.participantCode ?? null;
 if(participant && (participant===process.env.RESEARCHER_API_TOKEN || (await client.query("SELECT 1 FROM sessions WHERE learner_access_token_hash=$1",[tokenHash(participant)])).rowCount)) throw new Error("unsafe_participant");
 const stage=stageId ? await client.query<{stageType:string}>('SELECT stage_type AS "stageType" FROM session_stages WHERE id=$1 AND session_id=$2',[stageId,sessionId]) : null;
 if(stageId && !stage?.rowCount) throw new Error("invalid_audit_target");
 if(dedupKey) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[dedupKey]);
  if((await client.query("SELECT 1 FROM research_events WHERE audit_dedup_key=$1",[dedupKey])).rowCount) return;
 }
 const seq=sessionId ? await client.query<{sequence:string}>("INSERT INTO research_event_counters(session_id,next_sequence) VALUES($1,2) ON CONFLICT(session_id) DO UPDATE SET next_sequence=research_event_counters.next_sequence+1 RETURNING next_sequence-1 AS sequence",[sessionId])
 : await client.query<{sequence:string}>("INSERT INTO research_global_event_counter(id,next_sequence) VALUES(true,2) ON CONFLICT(id) DO UPDATE SET next_sequence=research_global_event_counter.next_sequence+1 RETURNING next_sequence-1 AS sequence");
 await client.query("INSERT INTO research_events(schema_version,session_id,stage_id,map_id,participant_code,study_group,activity,actor_type,event_type,target_type,target_id,outcome,reason_code,sequence_number,client_time_quality,before_quality,after_quality,audit_dedup_key) VALUES(4,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'NOT_APPLICABLE','NOT_APPLICABLE','NOT_APPLICABLE',$14)",
 [sessionId??null,stageId??null,context.mapId??null,participant,session?.rows[0]?.studyGroup??null,stage?.rows[0]?.stageType??null,actor,context.eventType,eventTargets[context.eventType],context.targetId??(eventTargets[context.eventType]==="SESSION"?sessionId:eventTargets[context.eventType]==="MAP"?context.mapId:eventTargets[context.eventType]==="STAGE"?stageId:null)??null,outcome,reasonCode??null,seq.rows[0]!.sequence,dedupKey??null]);
}
export async function auditCurrent(client: PoolClient, extra: Partial<Audit> = {}) {
 const context=auditContext.getStore();if(!context) return;
 Object.assign(context,extra);if(context.eventType==="RESEARCH_ASSESSMENT_CHANGE"&&!context.targetId)context.targetId=context.sessionId;await insertAudit(client,context,"RESEARCHER");context.pending=true;
}
export function auditCommitted() { const c=auditContext.getStore();if(c?.pending)c.committed=true; }
export async function recordAudit(pool:Pool,context:Audit,actor:"RESEARCHER"|"SYSTEM",outcome:EventOutcome,reason?: "VALIDATION"|"CONFLICT"|"SERVER"|"DEADLINE"|"USER_CANCELLED",dedupKey?:string) {
 const client=await pool.connect();
 try {await client.query("BEGIN");await insertAudit(client,context,actor,outcome,reason,dedupKey);await client.query("COMMIT");return true;}
 catch {await client.query("ROLLBACK").catch(()=>undefined);return false;} finally {client.release();}
}
export function registerAudit(app:Express,pool:Pool) {
 app.get("/api/research/system/events",async(_req,res)=>{
  if(principalOf(res).role!=="researcher")return res.status(404).json({error:"not_found"});
  const after=typeof _req.query.after==="string"?_req.query.after:"0";
  if(!/^(0|[1-9][0-9]{0,17})$/.test(after))return res.status(400).json({error:"invalid_cursor"});
  try { const events=await pool.query('SELECT event_id AS "eventId",schema_version AS "schemaVersion",session_id AS "sessionId",stage_id AS "stageId",map_id AS "mapId",actor_type AS "actorType",event_type AS "eventType",target_type AS "targetType",target_id AS "targetId",outcome,reason_code AS "reasonCode",sequence_number AS "sequenceNumber",server_timestamp AS "serverTimestamp" FROM research_events WHERE session_id IS NULL AND sequence_number>$1::bigint ORDER BY sequence_number LIMIT 200',[after]);return res.json({events:events.rows});}
  catch{return res.status(500).json({error:"audit_fetch_failed"});}
 });
 app.use("/api",async(req,res,next)=>{
  if(req.path==="/health")return next();
  if(principalOf(res).role!=="researcher")return next();
  const unavailable=()=>res.status(503).set("X-Research-Event-Saved","false").json({error:"audit_target_unavailable",message:"対象と記録の状態を確認できません。時間をおいて再度お試しください。"});
  let context:Audit|undefined;
  const match=/^\/research\/(?:stage1\/)?sessions\/([0-9a-f-]{36})(?:\/|$)/i.exec(req.path);
  if(req.method==="POST"&&req.path==="/research/stage1/sessions")context={eventType:"SESSION_CREATE"};
  else if(req.method==="PUT"&&req.path==="/research/stage1/settings")context={eventType:"SESSION_SETTINGS_CHANGE"};
  else if(match) {
   if(!uuid.test(match[1]!))return next();
   let eventType:EventType|undefined;
   if(req.method==="GET"&&(/\/export$|\.csv$/.test(req.path)))eventType="RESEARCH_EXPORT";
   else if(req.method==="GET"&&/\/analysis$|\/history$/.test(req.path))eventType="RESEARCH_ANALYSIS_VIEW";
   else if(req.method==="POST"&&/\/learner-token$/.test(req.path))eventType="SESSION_SETTINGS_CHANGE";
   else if((req.method==="POST"&&/\/(evaluations|reflections)$/.test(req.path))||(req.method==="PUT"&&/\/assessment\/questions$/.test(req.path)))eventType="RESEARCH_ASSESSMENT_CHANGE";
   if(eventType) {
    try {if(!(await pool.query("SELECT 1 FROM sessions WHERE id=$1 AND protocol_key IN ('STAGE1_4','STAGE1_6')",[match[1]])).rowCount)return next();}
    catch {return unavailable();}
    context={eventType,sessionId:match[1]};
   }
  } else if(req.method==="DELETE") {
   const target=/^\/(concepts|links)\/([0-9a-f-]{36})$/i.exec(req.path);
   if(target) {
    if(!uuid.test(target[2]!))return next();
    const table=target[1]==="concepts"?"concepts":"links";
    try {const result=await pool.query<{mapId:string;protocol:string|null}>('SELECT item.map_id AS "mapId",s.protocol_key AS protocol FROM '+table+' item JOIN maps m ON m.id=item.map_id LEFT JOIN session_stages st ON st.id=m.session_stage_id LEFT JOIN sessions s ON s.id=st.session_id WHERE item.id=$1',[target[2]]);
     if(result.rows[0]&&["STAGE1_4","STAGE1_6"].includes(result.rows[0].protocol??""))return next();
     if(result.rows[0])context={eventType:table==="concepts"?"DELETE_CONCEPT":"DELETE_LINK",mapId:result.rows[0].mapId,targetId:target[2]};
    }catch{return unavailable();}
   }
  }
  if(!context)return next();
  const captured=context, original=res.send;
  let sent=false;
  res.send=function(body:unknown):Response {
   if(sent)return original.call(this,body);
   sent=true;
   const status=this.statusCode;
   const finish=async()=>{
    if(!captured.committed&&status!==404) {
     const outcome:EventOutcome=status>=500?"FAILURE":status>=400?"REJECTED":"SUCCESS";
     if(captured.eventType==="SESSION_CREATE"&&outcome!=="SUCCESS"){captured.sessionId=undefined;captured.targetId=undefined;}
     let saved=false;
     try {saved=await recordAudit(pool,captured,"RESEARCHER",outcome,status>=500?"SERVER":status===409?"CONFLICT":status>=400?"VALIDATION":undefined);}catch{/* Recording unavailable. */}
     if(this.destroyed)return;
     this.setHeader("X-Research-Event-Saved",String(saved));
    } else this.setHeader("X-Research-Event-Saved",String(captured.committed));
    original.call(this,body);
   };
   void finish();return this;
  };
  return auditContext.run(captured,next);
 });
}

