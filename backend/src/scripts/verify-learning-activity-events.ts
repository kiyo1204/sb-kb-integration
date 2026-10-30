import {verifyMockTestUrl} from "./mock-db.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createStage1Session } from "../sessions.js";
import { createLearnerToken, storeLearnerToken } from "../access-control.js";

await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const base = process.env.API_BASE_URL ?? "http://127.0.0.1:3015";
const researcher = process.env.RESEARCHER_API_TOKEN!;
const kit = "66666666-6666-4666-8666-666666666662";
type Event = { schemaVersion: number; eventType: string; outcome: string; activity: string; studyGroup: string; stageId: string; clientTimestamp: string | null; serverTimestamp: string; details: unknown };
async function call(path: string, token: string, status = 200, body?: unknown) {
  const r = await fetch(base + "/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  assert.equal(r.status, status, path + ": " + JSON.stringify(data));
  return data;
}
async function fixture(group: "CONTROL" | "EXPERIMENTAL") {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const s = await createStage1Session(c, { participantCode: "activity-" + randomUUID(), lessonVideoUrl: "/dummy.mp4", kitDefinitionId: kit, studyGroup: group, groupActivitySeconds: 60 });
    const credential = createLearnerToken();
    await storeLearnerToken(c, s.id, credential.hash);
    await c.query("INSERT INTO assessment_questions(session_id,category,prompt,display_order) VALUES($1,'DESCRIPTION','Dummy question 1',0),($1,'DESCRIPTION','Dummy question 2',1)", [s.id]);
    await c.query("COMMIT");
    return { ...s, token: credential.token };
  } catch (error) { await c.query("ROLLBACK"); throw error; }
  finally { c.release(); }
}
try {
  const control = await fixture("CONTROL"), experimental = await fixture("EXPERIMENTAL");
  for (const s of [control, experimental]) {
    assert.equal((await call("/sessions/" + s.id + "/start", s.token, 200, {})).logSaved, true);
    const lesson = s.stages.find(st => st.stageType === "LESSON")!;
    await call("/session-stages/" + lesson.id + "/start", s.token, 200, {});
    const observed = { schemaVersion: 1, stageId: lesson.id, outcome: "SUCCESS", clientTimeQuality: "OBSERVED", clientTimestamp: "2026-01-01T00:00:00Z" };
    for (const eventType of ["SCREEN_ENTER", "VIDEO_PLAY", "VIDEO_PAUSE", "VIDEO_PLAY", "VIDEO_SEEK", "VIDEO_COMPLETE", "SCREEN_LEAVE"]) {
      await call("/sessions/" + s.id + "/events", s.token, 201, {
        ...observed, eventType, targetType: eventType.startsWith("VIDEO_") ? "VIDEO" : "SCREEN",
        ...(eventType === "VIDEO_SEEK" ? { details: { fromSeconds: 12, toSeconds: 35 } } : {}),
      });
    }
    for (const eventType of ["STAGE_PAUSE", "STAGE_RESUME"]) {
      await call("/sessions/" + s.id + "/events", s.token, 201, { ...observed, eventType, targetType: "STAGE", outcome: "UNKNOWN", reasonCode: "UNKNOWN" });
    }
    await call("/sessions/" + s.id + "/events", s.token, 403, { ...observed, eventType: "STAGE_COMPLETE", targetType: "STAGE" });
    await call("/sessions/" + (s.id === control.id ? experimental.id : control.id) + "/events", s.token, 404, { ...observed, eventType: "SCREEN_ENTER", targetType: "SCREEN" });
    await call("/sessions/" + s.id + "/events", s.token, 400, { ...observed, eventType: "VIDEO_PLAY", targetType: "VIDEO", details: { url: "https://private.invalid" } });
    await call("/research/sessions/" + s.id + "/events", s.token, 403);
    assert.equal((await pool.query("SELECT status FROM session_stages WHERE id=$1", [lesson.id])).rows[0].status, "IN_PROGRESS");
    await call("/session-stages/" + lesson.id + "/complete", s.token, 200, {});
    // Fixture setup skips Map editing, owned by Issue #4.
    await pool.query("UPDATE session_stages SET status='COMPLETED',started_at=now(),completed_at=now() WHERE session_id=$1 AND stage_type='PRIOR_MAP'", [s.id]);
    const kb = s.stages.find(st => st.stageType === "KB_MAP")!;
    await call("/session-stages/" + kb.id + "/start", s.token, 200, {});
    const map = await call("/kits/" + kit + "/kb-map", s.token, 201, { sessionStageId: kb.id });
    const feedback = await call("/maps/" + map.id + "/kit-feedback", s.token);
    assert.equal(feedback.logSaved, true);
    assert.equal(feedback.matched, false);
    const rejectedSubmit = await call("/maps/" + map.id + "/submit", s.token, 409, {});
    assert.equal(rejectedSubmit.logSaved, true);
    assert.equal((await pool.query("SELECT status FROM maps WHERE id=$1", [map.id])).rows[0].status, "DRAFT");
    await call("/maps/" + map.id + "/kit-feedback/display", s.token, 200, {});
    await call("/maps/" + map.id + "/kit-feedback/display", s.token, 400, { label: "private" });
    await pool.query("UPDATE session_stages SET status='COMPLETED',started_at=COALESCE(started_at,now()),completed_at=now() WHERE session_id=$1 AND stage_type IN ('KB_MAP','PRE_ASSESSMENT')", [s.id]);
    const groupStage = s.stages.find(st => ["INTEGRATION_MAP", "SELF_STUDY"].includes(st.stageType))!;
    await call("/session-stages/" + groupStage.id + "/start", s.token, 200, {});
    await pool.query("UPDATE session_stages SET started_at=now()-interval '2 minutes' WHERE id=$1", [groupStage.id]);
    if (s.studyGroup === "EXPERIMENTAL") await pool.query("INSERT INTO maps(type,status,session_stage_id,submitted_at) VALUES('INTEGRATION','SUBMITTED',$1,now())", [groupStage.id]);
    await call("/session-stages/" + groupStage.id + "/complete", s.token, 200, {});
    const events = (await call("/research/sessions/" + s.id + "/events", researcher)).events as Event[];
    assert.ok(events.some(e => e.eventType === "STAGE_START" && e.activity === groupStage.stageType && e.studyGroup === s.studyGroup));
    assert.ok(events.some(e => e.eventType === "STAGE_COMPLETE" && e.activity === groupStage.stageType));
    assert.ok(events.some(e => e.eventType === "FEEDBACK_CHECK" && e.outcome === "SUCCESS"));
    assert.ok(events.some(e => e.eventType === "FEEDBACK_DISPLAY"));
    assert.ok(events.filter(e => e.eventType.startsWith("VIDEO_")).every(e => e.activity === "LESSON" && Date.parse(e.clientTimestamp!) === Date.parse(observed.clientTimestamp) && Date.parse(e.serverTimestamp) > Date.parse(observed.clientTimestamp)));
    assert.ok(events.filter(e => e.eventType === "STAGE_PAUSE").every(e => e.outcome === "UNKNOWN"));
    assert.ok(!JSON.stringify(events).includes("private.invalid"));
    assert.ok(events.every(e => !("goalMap" in e)));
    const post = s.stages.find(st => st.stageType === "POST_ASSESSMENT")!;
    // A log-store failure must not undo the successful Stage transition.
    await pool.query("CREATE OR REPLACE FUNCTION issue5_fail_log() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''private exception''; END'");
    await pool.query("CREATE TRIGGER issue5_fail_log BEFORE INSERT ON research_events FOR EACH ROW EXECUTE FUNCTION issue5_fail_log()");
    try {
      const result = await call("/session-stages/" + post.id + "/start", s.token, 200, {});
      assert.equal(result.logSaved, false);
      assert.ok(!JSON.stringify(result).includes("private exception"));
      assert.equal((await pool.query("SELECT status FROM session_stages WHERE id=$1", [post.id])).rows[0].status, "IN_PROGRESS");
    } finally { await pool.query("DROP TRIGGER issue5_fail_log ON research_events"); }
    const assessment = await call("/session-stages/" + post.id + "/assessment", s.token);
    const submitted = await call("/session-stages/" + post.id + "/assessment/submit", s.token, 200, {
      answers: assessment.questions.map((q: { id: string }) => ({ questionId: q.id, answer: "Dummy answer" })),
    });
    assert.equal(submitted.activityLogSaved, true);
    const completedEvents = (await call("/research/sessions/" + s.id + "/events", researcher)).events as Event[];
    assert.equal(completedEvents.filter(e => e.eventType === "STAGE_COMPLETE" && e.stageId === lesson.id).length, 1);
    assert.ok(completedEvents.some(e => e.eventType === "STAGE_COMPLETE" && e.activity === "POST_ASSESSMENT"));
    assert.ok(completedEvents.some(e => e.eventType === "SESSION_COMPLETE"));
    assert.ok(!JSON.stringify(completedEvents.filter(e=>e.schemaVersion!==3)).includes("Dummy answer"));
  }
  console.log("Learning activity API events, group context, observations, feedback and nonfatal log failures: OK");
} finally { await pool.end(); }

