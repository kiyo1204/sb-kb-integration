import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { platform, cpus } from "node:os";
import type { Pool } from "pg";
import { parse } from "csv-parse/sync";
import { verificationReportPath } from "./mock-db.js";

export async function checkNormalOutput(pool: Pool, base: string, token: string,
  fixture: (protocol?: string) => Promise<{ id: string; map: string; link: string }>) {
  const results: { path: string; status: number; ms: number }[] = [];
  for (let n = 0; n < 20; n++) {
    const protocol = ["STAGE1_4", "STAGE1_5", "STAGE1_6"][n % 3]!;
    const f = await fixture(protocol);
    await pool.query("INSERT INTO maps(type,status,session_stage_id,submitted_at) SELECT (CASE stage_type WHEN 'KB_MAP' THEN 'KB' ELSE 'INTEGRATION' END)::map_type,'SUBMITTED',id,now() FROM session_stages WHERE session_id=$1 AND stage_type IN ('KB_MAP','INTEGRATION_MAP')", [f.id]);
    const maps = (await pool.query("SELECT m.id FROM maps m JOIN session_stages st ON st.id=m.session_stage_id WHERE st.session_id=$1", [f.id])).rows;
    for (const m of maps) {
      await pool.query("INSERT INTO concepts(map_id,label,position_x,position_y) SELECT $1,'テスト専用概念'||n,n*10,0 FROM generate_series(1,165)n", [m.id]);
      await pool.query("INSERT INTO links(map_id,source_concept_id,target_concept_id,label) SELECT $1,id,next,'テスト専用の関係' FROM (SELECT id,lead(id) OVER(ORDER BY id) next FROM concepts WHERE map_id=$1) x WHERE next IS NOT NULL", [m.id]);
    }
    await pool.query("INSERT INTO map_operation_logs(map_id,operation_type,target_type,target_id,before,after,sequence_number) SELECT $1,'MOVE_CONCEPT','CONCEPT',c.id,jsonb_build_object('id',c.id,'label','テスト専用履歴','positionX',n-1,'positionY',0),jsonb_build_object('id',c.id,'label','テスト専用履歴','positionX',n,'positionY',0),n FROM generate_series(1,200)n CROSS JOIN LATERAL(SELECT id FROM concepts WHERE map_id=$1 LIMIT 1)c", [f.map]);
    await pool.query("INSERT INTO research_reflection_notes(session_id,map_id,reported_by_code,note_text) VALUES($1,$2,'R-test','テスト専用の通常文章')", [f.id,f.map]);
    await pool.query("INSERT INTO research_proposition_evaluations(session_id,map_id,link_id,snapshot_side,subject_snapshot,evaluator_code,category,rationale) VALUES($1,$2,$3,'CURRENT','{}','R-test','P','テスト専用の理由')", [f.id,f.map,f.link]);
    const prefix = `/research/stage1/sessions/${f.id}`;
    const paths = [prefix + "/analysis", prefix + "/operations.csv", `/research/sessions/${f.id}/export`];
    if (protocol === "STAGE1_4") paths.push(prefix + "/evaluations.csv", prefix + "/reflections.csv");
    if (protocol === "STAGE1_5") {
      await pool.query("INSERT INTO survey_questions(session_id,kind,prompt,required,display_order,config) VALUES($1,'TEXT','テスト専用の設問',false,0,'{}')", [f.id]);
      await pool.query("INSERT INTO survey_answers(session_id,stage_id,question_id,answer) SELECT $1,st.id,q.id,'\"テスト専用の回答\"'::jsonb FROM session_stages st JOIN survey_questions q ON q.session_id=st.session_id WHERE st.session_id=$1 AND st.stage_type='SURVEY'", [f.id]);
      paths.push(prefix + "/survey",prefix + "/survey-answers.csv");
    }
    if (protocol === "STAGE1_6") {
      await pool.query("INSERT INTO assessment_questions(session_id,category,prompt,display_order) VALUES($1,'DESCRIPTION','テスト専用の設問',0)", [f.id]);
      await pool.query("INSERT INTO assessment_answers(session_id,stage_id,question_id,answer) SELECT $1,st.id,q.id,'テスト専用の回答' FROM session_stages st JOIN assessment_questions q ON q.session_id=st.session_id WHERE st.session_id=$1 AND st.stage_type='PRE_ASSESSMENT'", [f.id]);
      paths.push(prefix + "/assessment",prefix + "/assessment-answers.csv");
    }
    for (const path of paths) {
      const start = performance.now();
      const r = await fetch(base+path, { headers: { Authorization: `Bearer ${token}` } });
      const body = await r.text();
      assert.ok(!body.includes(token));
      if (r.status === 200 && (path.endsWith("/analysis") || path.endsWith("/export"))) {
        const output = JSON.parse(body);
        assert.equal(output.maps.length, maps.length);
        assert.equal(output.maps.reduce((sum: number, m: { concepts: unknown[] }) => sum + m.concepts.length, 0), maps.length * 165 + 2);
      }
      if (r.status === 200 && path.endsWith(".csv")) {
        const rows = parse(body, { columns: true, bom: true });
        assert.ok(rows.length > 0);
        if (path.endsWith("/operations.csv")) assert.equal(rows.length, 200);
      }
      results.push({path:path.replace(f.id, `synthetic-${n}-${protocol}`), status:r.status, ms: Number((performance.now()-start).toFixed(2))});
    }
  }
  await writeFile(verificationReportPath("suite-results").replace("suite-results", "normal-output"), JSON.stringify({node:process.version,os:platform(),cpu:cpus()[0]?.model,sessions:20,legacyMapEvents:4000,conceptsPerMap:165,results},null,2)+"\n");
  if (!process.env.SAFETY_NORMAL_BASELINE) assert.ok(results.every(r=>r.status===200), JSON.stringify(results.filter(r=>r.status!==200)));
  console.log("Normal output scale", JSON.stringify({requests:results.length,rejected:results.filter(r=>r.status!==200).length}));
}
