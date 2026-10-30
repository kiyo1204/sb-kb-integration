import {verifyMockTestUrl} from "./mock-db.js";
import {Pool} from "pg";
import {writeFileSync} from "node:fs";
await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try{
 const migrations=(await pool.query("SELECT name FROM pgmigrations WHERE name>='179089' ORDER BY name")).rows;
 const versions=(await pool.query("SELECT schema_version AS version,actor_type AS actor,outcome,count(*)::int AS count FROM research_events GROUP BY schema_version,actor_type,outcome ORDER BY schema_version,actor_type,outcome")).rows;
 const duplicateSubmissions=(await pool.query("SELECT map_id,event_type,count(*)::int FROM research_events WHERE event_type IN('MAP_SUBMIT','MAP_AUTO_SUBMIT') AND outcome='SUCCESS' GROUP BY map_id,event_type HAVING count(*)>1")).rows;
 const unsafeAudit=(await pool.query("SELECT count(*)::int AS count FROM research_events WHERE schema_version=4 AND (before_state IS NOT NULL OR after_state IS NOT NULL OR details<>'{}'::jsonb)")).rows[0].count;
 const wrongQuestions=(await pool.query("SELECT count(*)::int AS count FROM research_events e LEFT JOIN assessment_questions q ON q.id=e.target_id WHERE e.schema_version=3 AND e.event_type='ASSESSMENT_EDIT' AND e.outcome='SUCCESS' AND (q.id IS NULL OR q.session_id<>e.session_id)")).rows[0].count;
 if(duplicateSubmissions.length||unsafeAudit||wrongQuestions)throw new Error("integration_invariant_failed");
 writeFileSync(process.env.RESEARCH_VERIFICATION_OUTPUT??"../docs/integration-results.json",JSON.stringify({migrations,versions,duplicateSubmissions,unsafeAudit,wrongQuestions},null,2)+"\n");
 console.log(JSON.stringify({migrations:migrations.map(r=>r.name),duplicateSubmissions:duplicateSubmissions.length,unsafeAudit,wrongQuestions}));
}finally{await pool.end();}

