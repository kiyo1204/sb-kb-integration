import type { Express, Response } from "express";
import type { Pool, PoolClient } from "pg";
import { assertStageIsCurrent, lockSessionStageProgress } from "./sessions.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const categories = ["DESCRIPTION", "RETENTION", "TRANSFER"];
type QuestionInput = { id?: string; category: string; prompt: string };
type AnswerInput = { questionId: string; answer: string };

async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
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
  return { questions: questions.rows, stages: stages.rows, answers: answers.rows };
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
    typeof item.answer === "string" && item.answer.trim().length > 0 && item.answer.length <= 100000) &&
    new Set(value.map(item => item.questionId)).size === value.length;
}

async function storeAnswers(client: PoolClient, sessionId: string, stageId: string, answers: AnswerInput[], submit: boolean) {
  const questions = await client.query<{ id: string }>("SELECT id FROM assessment_questions WHERE session_id=$1::uuid", [sessionId]);
  const ids = new Set(questions.rows.map(q => q.id));
  if ((submit && answers.length !== ids.size) || answers.some(a => !ids.has(a.questionId))) return false;
  if (!submit) await client.query("DELETE FROM assessment_answers WHERE session_id=$1::uuid AND stage_id=$2::uuid AND NOT (question_id=ANY($3::uuid[]))", [sessionId, stageId, answers.map(a => a.questionId)]);
  for (const answer of answers) {
    await client.query(`INSERT INTO assessment_answers(session_id,stage_id,question_id,answer)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4) ON CONFLICT(stage_id,question_id)
      DO UPDATE SET answer=EXCLUDED.answer, updated_at=now()`, [sessionId, stageId, answer.questionId, answer.answer]);
  }
  return true;
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
    } catch (err) { await client.query("ROLLBACK"); console.error(err); return error(res, 500, "assessment_fetch_failed", "評価を取得できませんでした。"); }
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
    } catch (err) { console.error(err); return error(res, 500, "questions_save_failed", "問題を保存できませんでした。"); }
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
    } catch (err) { console.error(err); return error(res, 500, "assessment_fetch_failed", "評価を取得できませんでした。"); }
  });

  for (const action of ["save", "submit"] as const) app.post(`/api/session-stages/:stageId/assessment/${action}`, async (req, res) => {
    if (!uuid.test(req.params.stageId) || !validAnswers(req.body?.answers)) return error(res, 400, "invalid_answers", "空白のみの回答は保存・提出できません。回答を確認してください。");
    try {
      const result = await transaction(pool, async client => {
        const stage = await currentAssessment(client, req.params.stageId);
        if (!stage) return "not_current";
        if (!await storeAnswers(client, stage.sessionId, stage.id, req.body.answers, action === "submit")) return "invalid_questions";
        if (action === "submit") {
          await client.query("UPDATE session_stages SET status='COMPLETED', completed_at=now() WHERE id=$1::uuid", [stage.id]);
          if (stage.stageType === "POST_ASSESSMENT") {
            const completed = await client.query(`UPDATE sessions SET status='COMPLETED', completed_at=now()
              WHERE id=$1::uuid AND status='IN_PROGRESS' AND NOT EXISTS
              (SELECT 1 FROM session_stages WHERE session_id=$1::uuid AND status <> 'COMPLETED')`, [stage.sessionId]);
            if (completed.rowCount !== 1) throw new Error("Cannot complete session");
          }
        }
        return "ok";
      });
      if (result === "not_current") return error(res, 409, result, "現在の評価Stageではないか、提出済みです。");
      if (result === "invalid_questions") return error(res, 400, result, "問題と回答を確認してください。提出にはすべての設問への回答が必要です。");
      return res.json({ saved: true, submitted: action === "submit" });
    } catch (err) { console.error(err); return error(res, 500, "assessment_save_failed", "回答を保存できませんでした。"); }
  });

  app.get("/api/research/stage1/sessions/:sessionId/assessment-answers.csv", async (req, res) => {
    if (!uuid.test(req.params.sessionId)) return error(res, 400, "invalid_session_id", "Session IDが不正です。");
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const session = await client.query<{ participantCode: string; studyGroup: string }>("SELECT participant_code AS \"participantCode\", study_group AS \"studyGroup\" FROM sessions WHERE id=$1::uuid AND protocol_key='STAGE1_6'", [req.params.sessionId]);
      if (!session.rowCount) { await client.query("COMMIT"); return error(res, 404, "not_found", "Sessionが見つかりません。"); }
      const rows = await client.query(`SELECT s.id AS "sessionId", s.participant_code AS "participantCode", s.study_group AS "studyGroup",
        CASE WHEN st.stage_type='PRE_ASSESSMENT' THEN 'PRE' ELSE 'POST' END AS "timepoint",
        q.category, q.id AS "questionId", q.display_order AS "displayOrder", q.prompt, a.answer, st.completed_at AS "submittedAt"
        FROM sessions s JOIN session_stages st ON st.session_id=s.id AND st.stage_type IN ('PRE_ASSESSMENT','POST_ASSESSMENT')
        JOIN assessment_questions q ON q.session_id=s.id LEFT JOIN assessment_answers a ON a.stage_id=st.id AND a.question_id=q.id AND a.session_id=s.id
        WHERE s.id=$1::uuid ORDER BY st.order_index,q.display_order,q.id`, [req.params.sessionId]);
      await client.query("COMMIT");
      const cols = ["sessionId","participantCode","studyGroup","timepoint","category","questionId","displayOrder","prompt","answer","submittedAt"];
      const escape = (value: unknown) => '"' + (value == null ? "" : value instanceof Date ? value.toISOString() : String(value)).replaceAll('"','""') + '"';
      const csv = [cols.join(","), ...rows.rows.map(row => cols.map(col => escape(row[col])).join(","))].join("\r\n") + "\r\n";
      return res.set("Content-Type", "text/csv; charset=utf-8").set("Content-Disposition", `attachment; filename="stage1-${req.params.sessionId}-assessment-answers.csv"`).send("\uFEFF" + csv);
    } catch (err) { await client.query("ROLLBACK"); console.error(err); return error(res, 500, "assessment_csv_failed", "CSVを出力できませんでした。"); }
    finally { client.release(); }
  });
}
