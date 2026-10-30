import {verifyMockTestUrl} from "./mock-db.js";
import assert from "node:assert/strict";
import express from "express";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createStage1Session } from "../sessions.js";
import { accessControl, createLearnerToken, storeLearnerToken } from "../access-control.js";
import { registerAssessmentRoutes } from "../assessments.js";
import { registerResearchEventRoutes, validateEvent } from "../research-events.js";
await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const researcher = process.env.RESEARCHER_API_TOKEN!;
const app = express(); app.use(express.json()); app.use("/api", accessControl(pool));
registerAssessmentRoutes(app, pool); registerResearchEventRoutes(app, pool);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address(); assert.ok(address && typeof address !== "string");
const base = "http://127.0.0.1:" + address.port + "/api";
async function api(path: string, token: string, status: number, body?: unknown) {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : {"Content-Type":"application/json"}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); assert.equal(response.status,status,path + ": " + text);
  return response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
}
async function fixture(group: "CONTROL" | "EXPERIMENTAL") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const s = await createStage1Session(client,{participantCode:"assessment-"+randomUUID(),lessonVideoUrl:"/dummy.mp4",kitDefinitionId:"66666666-6666-4666-8666-666666666662",studyGroup:group,groupActivitySeconds:60});
    const token = createLearnerToken(); await storeLearnerToken(client,s.id,token.hash);
    const q = await client.query("INSERT INTO assessment_questions(session_id,category,prompt,display_order) VALUES($1,'DESCRIPTION','Dummy',0) RETURNING id",[s.id]);
    await client.query("UPDATE sessions SET status='IN_PROGRESS',started_at=now() WHERE id=$1",[s.id]);
    await client.query("COMMIT"); return {...s,token:token.token,questionId:q.rows[0].id as string};
  } catch(error) {await client.query("ROLLBACK");throw error;} finally {client.release();}
}
try {
  const other = await fixture("CONTROL");
  for(const group of ["CONTROL","EXPERIMENTAL"] as const) {
    const s = await fixture(group);
    for(const timepoint of ["PRE_ASSESSMENT","POST_ASSESSMENT"]) {
      const stage = s.stages.find(st=>st.stageType===timepoint)!;
      await pool.query("UPDATE session_stages SET status='COMPLETED',started_at=now(),completed_at=now() WHERE session_id=$1 AND order_index<$2",[s.id,stage.orderIndex]);
      await pool.query("UPDATE session_stages SET status='IN_PROGRESS',started_at=now() WHERE id=$1",[stage.id]);
      const path="/session-stages/"+stage.id+"/assessment";
      const answers=(answer:string,questionId=s.questionId)=>({answers:[{questionId,answer}]});
      await api(path+"/save",s.token,200,answers("First answer"));
      await api(path+"/save",s.token,200,answers("Revised answer"));
      await api(path+"/save",s.token,200,answers("Revised answer"));
      const history=async()=> (await api("/research/stage1/sessions/"+s.id+"/assessment",researcher,200)).events.filter((e:{stageId:string})=>e.stageId===stage.id);
      let events=await history();
      assert.equal(events.length,2);assert.equal(events[0].before.answer,null);
      assert.equal(events[1].before.answer,"First answer");assert.equal(events[1].after.answer,"Revised answer");
      assert.equal(events[1].activity,timepoint);assert.equal(events[1].studyGroup,group);
      await api(path+"/save",s.token,400,answers("   "));
      await api(path+"/save",s.token,400,answers("x".repeat(100001)));
      await api(path+"/save",s.token,400,answers("Authorization: Bearer private-token-value"));
      await api(path+"/save",s.token,400,answers("Foreign",other.questionId));
      await api(path,other.token,404);
      await api("/research/stage1/sessions/"+s.id+"/assessment",s.token,403);
      await api("/research/stage1/sessions/"+s.id+"/assessment-answers.csv",s.token,403);
      const v3={schemaVersion:3,eventType:"ASSESSMENT_EDIT",targetType:"ASSESSMENT",stageId:stage.id,targetId:s.questionId,outcome:"SUCCESS",clientTimeQuality:"NOT_APPLICABLE",before:{questionId:s.questionId,answer:null},after:{questionId:s.questionId,answer:"valid"}};
      assert.equal(validateEvent(v3),true);
      for(const after of [{...v3.after,unknown:1},{...v3.after,answer:"password=secret"},{...v3.after,answer:"x".repeat(100001)}]) assert.equal(validateEvent({...v3,after}),false);
      await api("/sessions/"+s.id+"/events",s.token,403,v3);
      await api("/sessions/"+s.id+"/events",researcher,403,v3);
      await pool.query("CREATE OR REPLACE FUNCTION issue6_fail_event() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''private-exception''; END'");
      await pool.query("CREATE TRIGGER issue6_fail_event BEFORE INSERT ON research_events FOR EACH ROW WHEN (NEW.outcome='SUCCESS') EXECUTE FUNCTION issue6_fail_event()");
      try {
        const failed=await api(path+"/submit",s.token,500,answers("Must rollback"));
        assert.equal(failed.operationOutcome,"FAILURE");assert.equal(failed.logSaved,true);
        assert.ok(!JSON.stringify(failed).includes("private-exception"));
        assert.equal((await pool.query("SELECT answer FROM assessment_answers WHERE stage_id=$1",[stage.id])).rows[0].answer,"Revised answer");
        assert.equal((await pool.query("SELECT status FROM session_stages WHERE id=$1",[stage.id])).rows[0].status,"IN_PROGRESS");
      } finally {await pool.query("DROP TRIGGER issue6_fail_event ON research_events");}
      await pool.query("CREATE TRIGGER issue6_fail_event BEFORE INSERT ON research_events FOR EACH ROW EXECUTE FUNCTION issue6_fail_event()");
      try {
        const failed = await api(path+"/save",s.token,500,answers("No partial update"));
        assert.equal(failed.logSaved,false);
        assert.equal((await pool.query("SELECT answer FROM assessment_answers WHERE stage_id=$1",[stage.id])).rows[0].answer,"Revised answer");
      } finally {await pool.query("DROP TRIGGER issue6_fail_event ON research_events");}
      await api(path+"/save",s.token,200,{answers:[]});
      events=await history();assert.equal(events.filter((e:{outcome:string})=>e.outcome==="SUCCESS").at(-1).after.answer,null);
      await api(path+"/submit",s.token,400,{answers:[]});
      await api(path+"/submit",s.token,200,answers("Final answer"));
      await api(path,s.token,409);
      events=await history();assert.ok(events.some((e:{eventType:string;outcome:string})=>e.eventType==="ASSESSMENT_SUBMIT"&&e.outcome==="SUCCESS"));
      assert.ok(!JSON.stringify(events).includes("private-token-value"));
      const csv=await api("/research/stage1/sessions/"+s.id+"/assessment-answers.csv",researcher,200);
      assert.ok(csv.includes("recordType"));assert.ok(csv.includes("ASSESSMENT_EDIT"));assert.ok(csv.includes("Final answer"));assert.ok(csv.includes(timepoint==="PRE_ASSESSMENT" ? '"PRE"' : '"POST"'));
    }
  }
  console.log("Assessment v3 API edits, submit, rollback, access control, validation and Export: OK");
} finally { await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end(); }

