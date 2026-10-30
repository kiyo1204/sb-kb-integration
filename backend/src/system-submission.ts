import type { Pool } from "pg";
import { insertAudit, recordAudit } from "./server-audit.js";
export async function observeExpiredStages(pool:Pool) {
 // A deadline observation never marks the Stage complete.
 const expired=await pool.query<{sessionId:string;stageId:string}>(
  "SELECT s.id AS \"sessionId\",st.id AS \"stageId\" FROM sessions s JOIN session_stages st ON st.session_id=s.id WHERE s.protocol_key='STAGE1_6' AND s.status='IN_PROGRESS' AND st.status='IN_PROGRESS' AND ((s.study_group='CONTROL' AND st.stage_type='SELF_STUDY') OR(s.study_group='EXPERIMENTAL' AND st.stage_type='INTEGRATION_MAP')) AND st.id=(SELECT id FROM session_stages WHERE session_id=s.id AND status<>'COMPLETED' ORDER BY order_index LIMIT 1) AND clock_timestamp()>=st.started_at+s.group_activity_seconds*interval '1 second'");
 for(const item of expired.rows) {
  const client=await pool.connect();
  try {
   await client.query("BEGIN");
   await client.query("SELECT id FROM sessions WHERE id=$1 FOR UPDATE",[item.sessionId]);
   const current=await client.query("SELECT 1 FROM session_stages st JOIN sessions s ON s.id=st.session_id WHERE st.id=$1 AND s.id=$2 AND s.status='IN_PROGRESS' AND st.status='IN_PROGRESS' AND st.id=(SELECT id FROM session_stages WHERE session_id=s.id AND status<>'COMPLETED' ORDER BY order_index LIMIT 1) AND clock_timestamp()>=st.started_at+s.group_activity_seconds*interval '1 second'",[item.stageId,item.sessionId]);
   if(current.rowCount)await insertAudit(client,{eventType:"STAGE_DEADLINE",sessionId:item.sessionId,stageId:item.stageId},"SYSTEM","SUCCESS","DEADLINE","stage-deadline:"+item.stageId);
   await client.query("COMMIT");
  }catch {
   await client.query("ROLLBACK").catch(()=>undefined);
   let saved=false;try{saved=await recordAudit(pool,{eventType:"STAGE_DEADLINE",sessionId:item.sessionId,stageId:item.stageId},"SYSTEM","FAILURE","SERVER","stage-deadline-failure:"+item.stageId);}catch{/* Event store unavailable. */}
   console.error(saved?"stage_deadline_failed_event_saved":"stage_deadline_event_missing");
  }
  finally{client.release();}
 }

}
