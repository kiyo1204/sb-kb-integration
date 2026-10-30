import type { Express } from "express";
import type { Pool, PoolClient } from "pg";
import { parseInstant } from "./event-export-contract.js";
import { randomUUID } from "node:crypto";
import { principalOf, tokenHash } from "./access-control.js";
import { isUuid } from "./delivery-reliability.js";
import type { EventExportService } from "./event-export-service.js";
const plans = new Map<
  string,
  { ids: string[]; signature: string; pseudonym?: string; expires: number }
>();
const mapIds =
  "SELECT id FROM maps WHERE session_stage_id IN(SELECT id FROM session_stages WHERE session_id=ANY($1::uuid[]))";
const scopes: Record<string, string> = Object.fromEntries(
  [
    "research_events",
    "assessment_answers",
    "assessment_questions",
    "research_proposition_evaluations",
    "research_reflection_notes",
    "client_event_receipts",
    "client_delivery_reports",
    "session_stages",
    "research_event_counters",
  ].map((t) => [t, "session_id=ANY($1::uuid[])"]),
);
Object.assign(scopes, {
  sessions: "id=ANY($1::uuid[])",
  maps: `id IN(${mapIds})`,
  concepts: `map_id IN(${mapIds})`,
  links: `map_id IN(${mapIds})`,
  map_operation_logs: `map_id IN(${mapIds})`,
  map_initial_snapshots: `map_id IN(${mapIds})`,
  map_history_boundaries: `map_id IN(${mapIds})`,
  concept_provenance: `target_concept_id IN(SELECT id FROM concepts WHERE map_id IN(${mapIds}))`,
  link_provenance: `target_link_id IN(SELECT id FROM links WHERE map_id IN(${mapIds}))`,
  explanation_responses:
    "session_stage_id IN(SELECT id FROM session_stages WHERE session_id=ANY($1::uuid[]))",
});
async function summary(c: PoolClient, ids: string[]) {
  const counts: Record<string, number> = {},
    fingerprints: string[] = [];
  fingerprints.push(
    JSON.stringify(
      (
        await c.query(
          "SELECT session_id,pseudonym,study_id FROM research_session_ids WHERE session_id=ANY($1::uuid[]) ORDER BY session_id",
          [ids],
        )
      ).rows,
    ),
  );
  for (const [t, w] of Object.entries(scopes)) {
    const x = (
      await c.query(
        `SELECT count(*)::int n,md5(coalesce(string_agg(md5(to_jsonb(x)::text),',' ORDER BY md5(to_jsonb(x)::text)),'')) f FROM ${t} x WHERE ${w}`,
        [ids],
      )
    ).rows[0];
    counts[t] = x.n;
    fingerprints.push(x.f);
  }
  return { counts, signature: fingerprints.join(":") };
}
const validPublic = (x: unknown): x is string =>
  typeof x === "string" && /^P-[a-f0-9-]{36}$/.test(x);
export function registerDataManagement(
  app: Express,
  pool: Pool,
  exports: EventExportService,
) {
  app.use("/api/research/data-management", (_q, r, n) =>
    principalOf(r).role === "researcher"
      ? n()
      : r.status(403).json({ error: "forbidden" }),
  );
  app.get("/api/research/data-management", async (_q, r) => {
    try {
      const [s, m, d] = await Promise.all([
        pool.query(
          "SELECT id,retain_until,CASE WHEN retain_until IS NULL THEN 'UNSET' WHEN retain_until<clock_timestamp() THEN 'EXPIRED' WHEN retain_until<clock_timestamp()+interval '30 days' THEN 'DUE_SOON' ELSE 'SET' END retention_state FROM research_studies ORDER BY id",
        ),
        pool.query(
          "SELECT session_id,pseudonym,study_id FROM research_session_ids ORDER BY session_id",
        ),
        pool.query(
          "SELECT r.*,(SELECT count(*)::int FROM research_identity.device_deletions d JOIN research_identity.revocations v USING(token_hash) WHERE v.receipt_id=r.id AND NOT d.acknowledged) pending_devices FROM research_deletion_receipts r ORDER BY deleted_at DESC LIMIT 100",
        ),
      ]);
      return r.json({ studies: s.rows, sessions: m.rows, deletions: d.rows });
    } catch {
      return r.status(503).json({ error: "management_unavailable" });
    }
  });
  app.post("/api/research/data-management/studies", async (q, r) => {
    if (Object.keys(q.body ?? {}).length)
      return r.status(400).json({ error: "invalid_input" });
    try {
      return r.json(
        (
          await pool.query(
            "INSERT INTO research_studies DEFAULT VALUES RETURNING id",
          )
        ).rows[0],
      );
    } catch {
      return r.status(503).json({ error: "management_unavailable" });
    }
  });
  app.patch("/api/research/data-management/studies/:id", async (q, r) => {
    const v = q.body?.retainUntil;
    if (
      !isUuid(q.params.id) ||
      Object.keys(q.body ?? {}).length !== 1 ||
      (v !== null && !parseInstant(v))
    )
      return r.status(400).json({ error: "invalid_retention" });
    try {
      const x = await pool.query(
        "UPDATE research_studies SET retain_until=$2 WHERE id=$1 RETURNING id",
        [q.params.id, v],
      );
      return r.status(x.rowCount ? 200 : 404).json({ saved: !!x.rowCount });
    } catch {
      return r.status(503).json({ error: "management_unavailable" });
    }
  });
  app.post("/api/research/data-management/assign", async (q, r) => {
    const { sessionId, pseudonym, studyId, reissue } = q.body ?? {};
    if (
      !isUuid(sessionId) ||
      Object.keys(q.body ?? {}).some(
        (k) => !["sessionId", "pseudonym", "studyId", "reissue"].includes(k),
      ) ||
      (pseudonym !== undefined && !validPublic(pseudonym)) ||
      (studyId !== undefined && !isUuid(studyId)) ||
      (reissue !== undefined && typeof reissue !== "boolean")
    )
      return r.status(400).json({ error: "invalid_assignment" });
    const c = await pool.connect().catch(() => null);
    if (!c) return r.status(503).json({ error: "management_unavailable" });
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(111011)");
      const m = await c.query(
        "SELECT participant_id FROM research_identity.membership WHERE session_id=$1 FOR UPDATE",
        [sessionId],
      );
      if (!m.rowCount) throw new Error();
      if (pseudonym) {
        const p = await c.query(
          "SELECT id FROM research_identity.participants WHERE pseudonym=$1",
          [pseudonym],
        );
        if (!p.rowCount) throw new Error();
        await c.query(
          "UPDATE research_identity.membership SET participant_id=$2 WHERE session_id=$1",
          [sessionId, p.rows[0].id],
        );
      } else {
        if (studyId)
          await c.query(
            "UPDATE research_identity.participants SET study_id=$2 WHERE id=$1",
            [m.rows[0].participant_id, studyId],
          );
        if (reissue)
          await c.query(
            "UPDATE research_identity.participants SET pseudonym=$2 WHERE id=$1",
            [m.rows[0].participant_id, "P-" + randomUUID()],
          );
      }
      await exports.invalidateSessions(
        (
          await c.query(
            "SELECT session_id FROM research_identity.membership WHERE participant_id=$1 OR session_id=$2",
            [m.rows[0].participant_id, sessionId],
          )
        ).rows.map((x) => x.session_id),
      );
      await c.query("COMMIT");
      return r.json({ saved: true });
    } catch {
      await c.query("ROLLBACK");
      return r.status(409).json({ error: "assignment_conflict" });
    } finally {
      c.release();
    }
  });
  app.post("/api/research/data-management/preview", async (q, r) => {
    const { sessionId, pseudonym } = q.body ?? {};
    if (
      Object.keys(q.body ?? {}).length !== 1 ||
      (!isUuid(sessionId) && !validPublic(pseudonym))
    )
      return r.status(400).json({ error: "invalid_target" });
    const c = await pool.connect().catch(() => null);
    if (!c) return r.status(503).json({ error: "management_unavailable" });
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const ids = (
        await c.query(
          "SELECT session_id FROM research_session_ids WHERE session_id=$1 OR pseudonym=$2 ORDER BY session_id",
          [sessionId ?? null, pseudonym ?? null],
        )
      ).rows.map((x) => x.session_id as string);
      if (!ids.length) return r.status(404).json({ error: "not_found" });
      const s = await summary(c, ids);
      for (const [id, p] of plans) if (p.expires < Date.now()) plans.delete(id);
      if (plans.size >= 100)
        return r.status(429).json({ error: "preview_capacity" });
      const planId = randomUUID();
      plans.set(planId, {
        ids,
        signature: s.signature,
        ...(pseudonym ? { pseudonym } : {}),
        expires: Date.now() + 300000,
      });
      return r.json({
        planId,
        counts: s.counts,
        sessionIds: ids,
        warning:
          "対象の一時出力も無効化します。ダウンロード済み・バックアップ・未接続端末の消去は別途確認が必要です。",
      });
    } catch {
      return r.status(503).json({ error: "preview_failed" });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
  app.post("/api/research/data-management/delete", async (q, r) => {
    if (
      Object.keys(q.body ?? {}).length !== 2 ||
      q.body?.confirm !== "DELETE" ||
      !isUuid(q.body?.planId)
    )
      return r.status(400).json({ error: "confirmation_required" });
    const plan = plans.get(q.body.planId);
    if (!plan || plan.expires < Date.now())
      return r.status(409).json({ error: "preview_expired" });
    const c = await pool.connect().catch(() => null);
    if (!c) return r.status(503).json({ error: "management_unavailable" });
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout='5s'");
      await c.query("SELECT pg_advisory_xact_lock(111011)");
      await c.query(
        "LOCK TABLE " +
          Object.keys(scopes).join(",") +
          ",operation_receipts IN EXCLUSIVE MODE",
      );
      const ids = plan.ids;
      if (plan.pseudonym) {
        const now = (
          await c.query(
            "SELECT session_id FROM research_session_ids WHERE pseudonym=$1 ORDER BY session_id",
            [plan.pseudonym],
          )
        ).rows.map((x) => x.session_id);
        if (JSON.stringify(now) !== JSON.stringify(ids)) throw new Error();
      }
      if ((await summary(c, ids)).signature !== plan.signature)
        throw new Error();
      const receipt = (
        await c.query(
          "INSERT INTO research_deletion_receipts(session_count) VALUES($1) RETURNING id",
          [ids.length],
        )
      ).rows[0].id;
      for (const id of ids) {
        const hash = (
          await c.query(
            "SELECT learner_access_token_hash FROM sessions WHERE id=$1",
            [id],
          )
        ).rows[0]?.learner_access_token_hash;
        if (hash) {
          await c.query(
            "INSERT INTO research_identity.revocations VALUES($1,$2,$3)",
            [hash, tokenHash(id), receipt],
          );
          const devices = (
            await c.query(
              "SELECT client_id FROM client_delivery_reports WHERE session_id=$1 UNION SELECT client_id FROM client_event_receipts WHERE session_id=$1",
              [id],
            )
          ).rows;
          for (const d of devices)
            await c.query(
              "INSERT INTO research_identity.device_deletions(token_hash,client_hash) VALUES($1,$2)",
              [hash, tokenHash(d.client_id)],
            );
          if (!devices.length)
            await c.query(
              "INSERT INTO research_identity.device_deletions VALUES($1,'UNKNOWN',false)",
              [hash],
            );
        }
      }
      // Only receipts in the selected learner scope or containing selected resource UUIDs.
      const refs = [
        ...ids,
        ...(
          await c.query(
            `SELECT id FROM maps WHERE id IN(${mapIds}) UNION SELECT id FROM session_stages WHERE session_id=ANY($1::uuid[]) UNION SELECT id FROM concepts WHERE map_id IN(${mapIds}) UNION SELECT id FROM links WHERE map_id IN(${mapIds})`,
            [ids],
          )
        ).rows.map((x) => x.id),
      ];
      await c.query(
        "DELETE FROM operation_receipts o WHERE EXISTS(SELECT 1 FROM unnest($1::text[]) scope WHERE o.principal_scope=scope OR left(o.principal_scope,length(scope)+1)=scope||':') OR EXISTS(SELECT 1 FROM unnest($2::text[]) id WHERE strpos(o.result::text,id)>0)",
        [ids.map((x) => "LEARNER:" + x), refs],
      );
      await c.query(
        `INSERT INTO research_identity.deletion_authorizations SELECT txid_current(),id FROM maps WHERE id IN(${mapIds})`,
        [ids],
      );
      for (const t of [
        "research_proposition_evaluations",
        "research_reflection_notes",
        "client_event_receipts",
        "client_delivery_reports",
        "assessment_answers",
        "assessment_questions",
        "research_events",
        "research_event_counters",
        "map_history_boundaries",
        "map_operation_logs",
        "concept_provenance",
        "link_provenance",
        "maps",
        "explanation_responses",
        "session_stages",
      ])
        await c.query(`DELETE FROM ${t} WHERE ${scopes[t]}`, [ids]);
      const participants = (
        await c.query(
          "DELETE FROM research_identity.membership WHERE session_id=ANY($1::uuid[]) RETURNING participant_id",
          [ids],
        )
      ).rows.map((x) => x.participant_id);
      await c.query("DELETE FROM sessions WHERE id=ANY($1::uuid[])", [ids]);
      await c.query(
        "DELETE FROM research_identity.participants p WHERE id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM research_identity.membership m WHERE m.participant_id=p.id)",
        [participants],
      );
      await c.query(
        "DELETE FROM research_identity.deletion_authorizations WHERE transaction_id=txid_current()",
      );
      await exports.invalidateSessions(ids);
      await c.query("COMMIT");
      for(const [id,p]of plans)if(p.ids.some(x=>ids.includes(x)))plans.delete(id);
      return r.json({
        deleted: true,
        receiptId: receipt,
        deviceDeletion: "PENDING_OR_UNKNOWN",
      });
    } catch {
      await c.query("ROLLBACK");
      return r
        .status(409)
        .json({
          error: "deletion_not_committed",
          message: "削除は確定していません。再確認してください。",
        });
    } finally {
      c.release();
    }
  });
}
