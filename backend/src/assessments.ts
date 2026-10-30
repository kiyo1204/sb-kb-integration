import {redactResearchOutput} from "./research-output-safety.js";
import {csvCell} from "./csv.js";
import { operationCommitted,reliableOperation } from "./delivery-reliability.js";
import { safeServerErrorCode } from "./safe-server-error.js";
import { auditCurrent, auditCommitted } from "./server-audit.js";
import type { Express, Response } from "express";
import type { Pool, PoolClient } from "pg";
import { assertStageIsCurrent, lockSessionStageProgress } from "./sessions.js";

import { principalOf } from "./access-control.js";
import { insertResearchEvent, type EventActor, type EventInput } from "./research-events.js";
import { validAnswerText } from "./research-event-assessment-v3.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const categories = ["DESCRIPTION", "RETENTION", "TRANSFER"];
type QuestionInput = { id?: string; category: string; prompt: string };
type AnswerInput = { questionId: string; answer: string };

async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>, phase="operation"): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await reliableOperation(client, () => fn(client),phase);
    if (value === "saved") await auditCurrent(client);
    await client.query("COMMIT");
    operationCommitted();
    auditCommitted();
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function assessmentHistory(client: PoolClient, sessionId: string) {
  return (await client.query(
    'SELECT event_id AS "eventId", schema_version AS "schemaVersion", session_id AS "sessionId", stage_id AS "stageId", activity, (SELECT pseudonym FROM research_session_ids i WHERE i.session_id=research_events.session_id) AS "participantCode", study_group AS "studyGroup", actor_type AS actor, event_type AS "eventType", target_id AS "targetId", outcome, reason_code AS "reasonCode", sequence_number AS "sequenceNumber", server_timestamp AS "serverTimestamp", client_timestamp AS "clientTimestamp", before_state AS before, after_state AS after, before_quality AS "beforeQuality", after_quality AS "afterQuality" FROM research_events WHERE session_id=$1::uuid AND schema_version=3 ORDER BY sequence_number',
    [sessionId])).rows;
}

export async function assessmentSnapshot(client: PoolClient, sessionId: string) {
  const questions = await client.query(
    `SELECT id, session_id AS "sessionId", category, prompt, display_order AS "displayOrder",
      created_at AS "createdAt", updated_at AS "updatedAt" FROM assessment_questions
     WHERE session_id=$1::uuid ORDER BY display_order, id`, [sessionId]);
  const stages = await client.query(
    `SELECT st.id AS "stageId", st.stage_type AS "stageType", st.status,
       st.started_at AS "startedAt", st.completed_at AS "submittedAt"
     FROM session_stages st WHERE st.session_id=$1::uuid AND st.stage_type IN ('PRE_ASSESSMENT','POST_ASSESSMENT')
     ORDER BY st.order_index`, [sessionId]);
  const answers = await client.query(
    `SELECT a.session_id AS "sessionId", a.stage_id AS "stageId", a.question_id AS "questionId",
       a.answer, a.created_at AS "createdAt", a.updated_at AS "updatedAt"
     FROM assessment_answers a WHERE a.session_id=$1::uuid ORDER BY a.stage_id, a.question_id`, [sessionId]);
  return redactResearchOutput({ questions: questions.rows, stages: stages.rows, answers: answers.rows, events: await assessmentHistory(client, sessionId) },client);
}

async function currentAssessment(client: PoolClient, stageId: string) {
  const stage = await lockSessionStageProgress(client, stageId);
  if (!stage || !["PRE_ASSESSMENT", "POST_ASSESSMENT"].includes(stage.stageType)) return null;
  const protocol = await client.query("SELECT 1 FROM sessions WHERE id=$1::uuid AND protocol_key='STAGE1_6'", [stage.sessionId]);
  if (!protocol.rowCount || stage.status !== "IN_PROGRESS" || (await assertStageIsCurrent(client, stage)).kind !== "ready") return null;
  return stage;
}

function validAnswers(value: unknown): value is AnswerInput[] {
  return Array.isArray(value) && value.length <= 1000 && value.every(item =>
    item && typeof item === "object" && typeof item.questionId === "string" && uuid.test(item.questionId) &&
    Object.keys(item).every(key => ["questionId", "answer"].includes(key)) && validAnswerText(item.answer)) &&
    new Set(value.map(item => item.questionId)).size === value.length;
}

async function storeAnswers(client: PoolClient, sessionId: string, stageId: string, answers: AnswerInput[], submit: boolean, actor: EventActor) {
  const questions = await client.query<{ id: string }>("SELECT id FROM assessment_questions WHERE session_id=$1::uuid", [sessionId]);
  const ids = new Set(questions.rows.map(q => q.id));
  if ((submit && answers.length !== ids.size) || answers.some(a => !ids.has(a.questionId))) return false;
  const previous = await client.query<{ questionId: string; answer: string }>('SELECT question_id AS "questionId", answer FROM assessment_answers WHERE session_id=$1::uuid AND stage_id=$2::uuid', [sessionId, stageId]);
  if (!submit) await client.query("DELETE FROM assessment_answers WHERE session_id=$1::uuid AND stage_id=$2::uuid AND NOT (question_id=ANY($3::uuid[]))", [sessionId, stageId, answers.map(a => a.questionId)]);
  for (const answer of answers) {
    await client.query(`INSERT INTO assessment_answers(session_id,stage_id,question_id,answer)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4) ON CONFLICT(stage_id,question_id)
      DO UPDATE SET answer=EXCLUDED.answer, updated_at=now()`, [sessionId, stageId, answer.questionId, answer.answer]);
  }
  const persisted = await client.query<{ questionId: string; answer: string }>('SELECT question_id AS "questionId", answer FROM assessment_answers WHERE session_id=$1::uuid AND stage_id=$2::uuid', [sessionId, stageId]);
  const before = new Map(previous.rows.map(a => [a.questionId, a.answer]));
  const after = new Map(persisted.rows.map(a => [a.questionId, a.answer]));
  for (const questionId of new Set([...before.keys(), ...after.keys()])) {
    const oldAnswer = before.get(questionId) ?? null, newAnswer = after.get(questionId) ?? null;
    if (oldAnswer === newAnswer) continue;
    await requiredEvent(client, sessionId, actor, {
      schemaVersion: 3, eventType: "ASSESSMENT_EDIT", targetType: "ASSESSMENT", stageId, targetId: questionId,
      outcome: "SUCCESS", clientTimeQuality: "NOT_APPLICABLE",
      before: { questionId, answer: oldAnswer }, after: { questionId, answer: newAnswer },
    });
  }
  return true;
}

async function requiredEvent(client: PoolClient, sessionId: string, actor: EventActor, event: EventInput) {
  if (!await insertResearchEvent(client, sessionId, actor, event)) throw new Error("assessment_event_save_failed");
}

function error(response: Response, status: number, code: string, message: string) {
  return response.status(status).json({ error: code, message });
}

export function registerAssessmentRoutes(app: Express, pool: Pool) {
  app.get("/api/research/stage1/sessions/:sessionId/assessment", async (req, res) => {
    if (!uuid.test(req.params.sessionId)) return error(res, 400, "invalid_session_id", "Session IDが不正です。");
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const session = await client.query("SELECT id, status, participant_code AS \"participantCode\", study_group AS \"studyGroup\" FROM sessions WHERE id=$1::uuid AND protocol_key='STAGE1_6'", [req.params.sessionId]);
      if (!session.rowCount) { await client.query("COMMIT"); return error(res, 404, "not_found", "Sessionが見つかりません。"); }
      const assessment = await assessmentSnapshot(client, req.params.sessionId);
      await client.query("COMMIT");
      return res.json({ session: session.rows[0], ...assessment });
    } catch (err) { await client.query("ROLLBACK"); console.error("assessment_processing_failed", safeServerErrorCode(err)); return error(res, 500, "assessment_fetch_failed", "評価を取得できませんでした。"); }
    finally { client.release(); }
  });

  app.put("/api/research/stage1/sessions/:sessionId/assessment/questions", async (req, res) => {
    const sessionId = req.params.sessionId;
    const questions: unknown = req.body?.questions;
    if (!uuid.test(sessionId) || !Array.isArray(questions) || questions.length > 1000 || !questions.every((q: QuestionInput) =>
      q && typeof q === "object" && (q.id === undefined || (typeof q.id === "string" && uuid.test(q.id))) &&
      categories.includes(q.category) && typeof q.prompt === "string" && q.prompt.trim().length > 0 && q.prompt.length <= 10000) ||
      new Set(questions.filter((q: QuestionInput) => q.id).map((q: QuestionInput) => q.id)).size !== questions.filter((q: QuestionInput) => q.id).length) {
      return error(res, 400, "invalid_questions", "問題文、分類、順序を確認してください。");
    }
    try {
      const result = await transaction(pool, async client => {
        const session = await client.query<{ status: string }>("SELECT status FROM sessions WHERE id=$1::uuid AND protocol_key='STAGE1_6' FOR UPDATE", [sessionId]);
        if (!session.rowCount) return "not_found";
        if (session.rows[0]!.status !== "NOT_STARTED") return "locked";
        const existing = await client.query<{ id: string }>("SELECT id FROM assessment_questions WHERE session_id=$1::uuid", [sessionId]);
        const ids = new Set(existing.rows.map(q => q.id));
        if (questions.some((q: QuestionInput) => q.id && !ids.has(q.id))) return "invalid";
        const retained = questions.flatMap((q: QuestionInput) => q.id ? [q.id] : []);
        await client.query("DELETE FROM assessment_questions WHERE session_id=$1::uuid AND NOT (id=ANY($2::uuid[]))", [sessionId, retained]);
        for (const [index, q] of (questions as QuestionInput[]).entries()) {
          if (q.id) await client.query("UPDATE assessment_questions SET category=$3,prompt=$4,display_order=$5,updated_at=now() WHERE session_id=$1::uuid AND id=$2::uuid", [sessionId, q.id, q.category, q.prompt, index]);
          else await client.query("INSERT INTO assessment_questions(session_id,category,prompt,display_order) VALUES($1::uuid,$2,$3,$4)", [sessionId, q.category, q.prompt, index]);
        }
        return "saved";
      });
      if (result === "not_found") return error(res, 404, result, "Sessionが見つかりません。");
      if (result === "locked") return error(res, 409, result, "Session開始後は問題を変更できません。");
      if (result === "invalid") return error(res, 400, result, "このSessionにない設問IDです。");
      return res.json({ saved: true });
    } catch (err) { console.error("assessment_processing_failed", safeServerErrorCode(err)); return error(res, 500, "questions_save_failed", "問題を保存できませんでした。"); }
  });

  app.get("/api/session-stages/:stageId/assessment", async (req, res) => {
    if (!uuid.test(req.params.stageId)) return error(res, 400, "invalid_stage_id", "Stage IDが不正です。");
    try {
      const result = await transaction(pool, async client => {
        const stage = await currentAssessment(client, req.params.stageId);
        if (!stage) return null;
        const questions = await client.query(`SELECT q.id, q.prompt, q.display_order AS "displayOrder", COALESCE(a.answer,'') AS answer
          FROM assessment_questions q LEFT JOIN assessment_answers a ON a.question_id=q.id AND a.stage_id=$2::uuid AND a.session_id=q.session_id
          WHERE q.session_id=$1::uuid ORDER BY q.display_order, q.id`, [stage.sessionId, stage.id]);
        return { stageId: stage.id, questions: questions.rows };
      });
      return result ? res.json(result) : error(res, 409, "assessment_not_current", "現在の評価Stageを開始してください。");
    } catch (err) { console.error("assessment_processing_failed", safeServerErrorCode(err)); return error(res, 500, "assessment_fetch_failed", "評価を取得できませんでした。"); }
  });

  for (const action of ["save", "submit"] as const) app.post("/api/session-stages/:stageId/assessment/" + action, async (req, res) => {
    const stageId = req.params.stageId;
    if (typeof stageId !== "string" || !uuid.test(stageId)) return error(res, 404, "not_found", "活動が見つかりません。");
    const actor: EventActor = principalOf(res).role === "learner" ? "LEARNER" : "RESEARCHER";
    const recordUnsuccessful = async (outcome: "FAILURE" | "REJECTED", reasonCode: "SERVER" | "VALIDATION" | "CONFLICT") => {
      try {
        return await transaction(pool, async client => {
          const stage = await lockSessionStageProgress(client, stageId);
          const principal = principalOf(res);
          if (!stage || !["PRE_ASSESSMENT", "POST_ASSESSMENT"].includes(stage.stageType) ||
              (principal.role === "learner" && principal.sessionId !== stage.sessionId)) return false;
          await requiredEvent(client, stage.sessionId, actor, {
            schemaVersion: 3, eventType: action === "submit" ? "ASSESSMENT_SUBMIT" : "ASSESSMENT_EDIT",
            targetType: "ASSESSMENT", stageId: stage.id, targetId: stage.id,
            outcome, reasonCode, clientTimeQuality: "NOT_APPLICABLE",
          });
          return true;
        },outcome);
      } catch { return false; }
    };
    try {
      const result = await transaction(pool, async client => {
        const stage = await currentAssessment(client, stageId);
        if (!stage) return "not_current";
        if (!req.body || Object.keys(req.body).some(key => key !== "answers") || !validAnswers(req.body?.answers)) return "invalid_answers";
        if (!await storeAnswers(client, stage.sessionId, stage.id, req.body.answers, action === "submit", actor)) return "invalid_questions";
        if (action === "submit") {
          await client.query("UPDATE session_stages SET status='COMPLETED', completed_at=now() WHERE id=$1::uuid", [stage.id]);
          await requiredEvent(client, stage.sessionId, actor, {eventType:"STAGE_COMPLETE",targetType:"STAGE",stageId:stage.id,outcome:"SUCCESS",clientTimeQuality:"NOT_APPLICABLE"});
          if (stage.stageType === "POST_ASSESSMENT") {
            const completed = await client.query("UPDATE sessions SET status='COMPLETED', completed_at=now() WHERE id=$1::uuid AND status='IN_PROGRESS' AND NOT EXISTS (SELECT 1 FROM session_stages WHERE session_id=$1::uuid AND status <> 'COMPLETED')", [stage.sessionId]);
            if (completed.rowCount !== 1) throw new Error("Cannot complete session");
            await requiredEvent(client, stage.sessionId, actor, {eventType:"SESSION_COMPLETE",targetType:"SESSION",outcome:"SUCCESS",clientTimeQuality:"NOT_APPLICABLE"});
          }
          await requiredEvent(client, stage.sessionId, actor, {
            schemaVersion: 3, eventType: "ASSESSMENT_SUBMIT", targetType: "ASSESSMENT", stageId: stage.id, targetId: stage.id,
            outcome: "SUCCESS", clientTimeQuality: "NOT_APPLICABLE",
          });
        }
        return "ok";
      });
      if (result !== "ok") {
        const logSaved = await recordUnsuccessful("REJECTED", result === "not_current" ? "CONFLICT" : "VALIDATION");
        return res.status(result === "not_current" ? 409 : 400).json({
          error: result, message: "回答と現在の活動を確認してください。空白・認証情報を含む回答は保存できません。",
          operationOutcome: "REJECTED", logSaved,
        });
      }
      return res.json({ saved: true, submitted: action === "submit", operationOutcome: "SUCCESS", logSaved: true, activityLogSaved: action === "submit" ? true : null });
    } catch {
      const logSaved = await recordUnsuccessful("FAILURE", "SERVER");
      return res.status(500).json({ error: "assessment_save_failed", message: "回答を保存できませんでした。入力内容を保持して再度お試しください。", operationOutcome: "FAILURE", logSaved });
    }
  });

  app.get("/api/research/stage1/sessions/:sessionId/assessment-answers.csv", async (req, res) => {
    if (!uuid.test(req.params.sessionId)) return error(res, 400, "invalid_session_id", "Session IDが不正です。");
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const session = await client.query<{ participantCode: string; studyGroup: string }>("SELECT participant_code AS \"participantCode\", study_group AS \"studyGroup\" FROM sessions WHERE id=$1::uuid AND protocol_key='STAGE1_6'", [req.params.sessionId]);
      if (!session.rowCount) { await client.query("COMMIT"); return error(res, 404, "not_found", "Sessionが見つかりません。"); }
      const rows = await client.query(`SELECT s.id AS "sessionId", (SELECT pseudonym FROM research_session_ids i WHERE i.session_id=s.id) AS "participantCode", s.study_group AS "studyGroup",
        CASE WHEN st.stage_type='PRE_ASSESSMENT' THEN 'PRE' ELSE 'POST' END AS "timepoint",
        q.category, q.id AS "questionId", q.display_order AS "displayOrder", q.prompt, a.answer, st.completed_at AS "submittedAt"
        FROM sessions s JOIN session_stages st ON st.session_id=s.id AND st.stage_type IN ('PRE_ASSESSMENT','POST_ASSESSMENT')
        JOIN assessment_questions q ON q.session_id=s.id LEFT JOIN assessment_answers a ON a.stage_id=st.id AND a.question_id=q.id AND a.session_id=s.id
        WHERE s.id=$1::uuid ORDER BY st.order_index,q.display_order,q.id`, [req.params.sessionId]);
      const history = await assessmentHistory(client, req.params.sessionId);
      await client.query("COMMIT");
      const cols = ["sessionId","participantCode","studyGroup","timepoint","category","questionId","displayOrder","prompt","answer","submittedAt",
        "recordType","eventId","schemaVersion","stageId","eventType","actor","outcome","reasonCode","sequenceNumber","serverTimestamp","beforeAnswer","afterAnswer","beforeQuality","afterQuality"];
      const output: Array<Record<string, unknown>> = rows.rows.map(row => ({ ...row, recordType: "ANSWER" }));
      for (const event of history) output.push({
        ...event, recordType: "EVENT", timepoint: event.activity === "PRE_ASSESSMENT" ? "PRE" : "POST",
        questionId: event.eventType === "ASSESSMENT_EDIT" && event.outcome === "SUCCESS" ? event.targetId : null,
        beforeAnswer: event.before?.answer, afterAnswer: event.after?.answer,
      });

      const csv = [cols.join(","), ...(await redactResearchOutput(output,client)).map(row => cols.map(col => csvCell(row[col])).join(","))].join("\r\n") + "\r\n";
      return res.set("Content-Type", "text/csv; charset=utf-8").set("Content-Disposition", `attachment; filename="stage1-${req.params.sessionId}-assessment-answers.csv"`).send("\uFEFF" + csv);
    } catch (err) { await client.query("ROLLBACK"); console.error("assessment_processing_failed", safeServerErrorCode(err)); return error(res, 500, "assessment_csv_failed", "CSVを出力できませんでした。"); }
    finally { client.release(); }
  });
}
