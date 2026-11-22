// TEST ONLY: end-to-end acceptance against the disposable, guarded synthetic DB.
// No actual research sessions, credentials, files or database volumes are altered.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { parse } from "csv-parse/sync";
import { assertWorkbookApiConsistency, assertPracticeLabelsAbsentFromWorkbook } from "./research-workbook-api-checks.js";
import { verificationReportPath, verifyMockTestUrl } from "./mock-db.js";
import type { SessionRawExport } from "../research-export.js";

const base = process.env.API_BASE_URL ?? "";
const researcher = process.env.RESEARCHER_API_TOKEN ?? "";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/, "acceptance API must be local");
assert.ok(researcher, "synthetic researcher token required");
await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const root = "/research/experiment-runs";

async function request(
  path: string, method = "GET", body?: unknown,
  expected = 200, key = randomUUID(), token = researcher,
) {
  const response = await fetch(base + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, expected, method + " " + path);
  return response;
}
async function json(path: string, method = "GET", body?: unknown,
  status = 200, key = randomUUID(), token = researcher) {
  return (await request(path, method, body, status, key, token)).json();
}
async function output(runId: string) {
  const prefix = `${root}/${runId}/research.`;
  const data = await json(prefix + "json");
  const rows = parse(await (await request(prefix + "csv")).text(), {
    columns: true, bom: true, skip_empty_lines: true,
  }) as Array<Record<string, string>>;
  const workbook = Buffer.from(await (await request(prefix + "xlsx")).arrayBuffer());
  await assertWorkbookApiConsistency(workbook, runId, data.sessions as SessionRawExport[]);
  return { data, rows, workbook };
}

try {
  // Create one genuinely retained registration and one cancellable registration
  // through the same researcher APIs used by the participant detail screen.
  const goal = await json("/research/goal-maps/import", "POST", {
    format: "sb-kb-goal-map",
    schemaVersion: 1,
    goalMap: {
      title: "TEST ONLY integrated withdrawal " + randomUUID(),
      concepts: [{ id: "a", label: "TEST ONLY seed", position: { x: 0, y: 0 } }],
      links: [],
    },
  }, 201);
  const concept = (await pool.query(
    "SELECT id FROM kit_concept_items WHERE kit_definition_id=$1",
    [goal.kitDefinitionId],
  )).rows[0]?.id;
  assert.ok(concept);
  const draft = await json("/research/materials", "POST", {}, 201);
  const saved = await json(`/research/materials/${draft.id}`, "PUT", {
    expectedRevision: draft.editRevision,
    body: {
      title: "TEST ONLY acceptance material",
      researcherDescription: "",
      videoRef: "/test-only.mp4",
      sbInstructions: "TEST ONLY SB",
      kbInstructions: "TEST ONLY KB",
      integrationInstructions: "TEST ONLY integration",
      kitId: goal.kitDefinitionId,
      seedConceptItemIds: [concept],
      integrationSeconds: 601,
    },
  });
  const material = await json(`/research/materials/${draft.id}/publish`, "POST", {
    expectedRevision: saved.editRevision,
  });
  const run = await json(root, "POST", {
    name: "TEST ONLY integrated acceptance",
    catalogVersionId: material.id,
    plannedParticipants: 2,
  }, 201);
  const keep = await json(`${root}/${run.id}/participants`, "POST", {
    participantLabel: "TEST ONLY retained",
  }, 201);
  const cancel = await json(`${root}/${run.id}/participants`, "POST", {
    participantLabel: "TEST ONLY withdrawn",
  }, 201);
  assert.ok(typeof keep.issuedCode === "string" && keep.issuedCode.length === 43);
  assert.ok(typeof cancel.issuedCode === "string" && cancel.issuedCode.length === 43);
  const ids = [keep.sessionId, cancel.sessionId].sort();
  assert.equal((await json("/me", "GET", undefined, 200, randomUUID(), cancel.issuedCode)).sessionId, cancel.sessionId);

  const activeBefore = await json(`${root}/${run.id}/participants`);
  assert.deepEqual(activeBefore.participants.map((p: {id:string}) => p.id).sort(), ids);
  assert.deepEqual(activeBefore.withdrawals, []);
  assert.equal((await json(`${root}/${run.id}`)).registeredSessions, 2);
  const before = await output(run.id);
  assert.equal(before.data.run.registeredSessions, 2);
  assert.deepEqual(before.data.sessions.map((s: SessionRawExport) => s.session.id).sort(), ids);
  assert.deepEqual([...new Set(before.rows.map((r) => r.sessionId))].sort(), ids);

  // Confirmation, concurrency-friendly idempotency and irreversible history:
  // cancellation never deletes Session, stage, identity or access rows.
  const withdrawalPath = `${root}/${run.id}/participants/${cancel.sessionId}/withdraw`;
  const input = { confirmed: true, expectedCredentialGeneration: cancel.credentialGeneration };
  const denied = await json(withdrawalPath, "POST", { ...input, confirmed: false }, 400);
  assert.equal(denied.error, "invalid_confirmation");
  const transactionKey = randomUUID();
  const withdrawn = await json(withdrawalPath, "POST", input, 200, transactionKey);
  assert.equal(withdrawn.sessionId, cancel.sessionId);
  assert.equal(withdrawn.withdrawn, true);
  assert.ok(withdrawn.withdrawnAt);
  const retried = await json(withdrawalPath, "POST", input, 200, transactionKey);
  assert.equal(retried.withdrawnAt, withdrawn.withdrawnAt);
  assert.equal((await json(withdrawalPath, "POST", input, 409)).error, "already_withdrawn");

  const activeAfter = await json(`${root}/${run.id}/participants`);
  assert.deepEqual(activeAfter.participants.map((p: {id:string}) => p.id), [keep.sessionId]);
  assert.equal(activeAfter.withdrawals.length, 1);
  const record = activeAfter.withdrawals[0];
  assert.deepEqual(Object.keys(record).sort(), ["id", "label", "withdrawnAt"]);
  assert.equal(record.id, cancel.sessionId);
  assert.equal(record.label, "TEST ONLY withdrawn");
  assert.equal(new Date(record.withdrawnAt).toISOString(), withdrawn.withdrawnAt);
  assert.equal((await json(`${root}/${run.id}`)).registeredSessions, 1);
  const invalidated = await json("/me", "GET", undefined, 401, randomUUID(), cancel.issuedCode);
  assert.equal(invalidated.error, "experiment_code_invalidated");
  assert.equal((await json("/me", "GET", undefined, 200, randomUUID(), keep.issuedCode)).sessionId, keep.sessionId);
  assert.equal((await json(
    `${root}/${run.id}/participants/${cancel.sessionId}/code/reissue`,
    "POST", { expectedCredentialGeneration: cancel.credentialGeneration }, 404,
  )).error, "not_found");

  // All three researcher formats must exclude the canceled Session while
  // retaining the unaffected one. The XLSX helper checks all 11 sheets.
  const after = await output(run.id);
  assert.equal(after.data.run.registeredSessions, 1);
  assert.deepEqual(after.data.sessions.map((s: SessionRawExport) => s.session.id), [keep.sessionId]);
  assert.deepEqual([...new Set(after.rows.map((r) => r.sessionId))], [keep.sessionId]);
  await assertPracticeLabelsAbsentFromWorkbook(after.workbook, [
    cancel.sessionId, "TEST ONLY withdrawn", cancel.issuedCode,
  ]);
  for (const text of [JSON.stringify(after.data), JSON.stringify(after.rows), JSON.stringify(activeAfter)]) {
    assert.ok(!text.includes(cancel.issuedCode), "plaintext code never appears in researcher output");
  }
  assert.ok(!JSON.stringify(after.data).includes(cancel.sessionId));
  assert.ok(!JSON.stringify(after.rows).includes(cancel.sessionId));

  const preserved = (await pool.query(
    `SELECT (SELECT count(*)::int FROM sessions WHERE id = ANY($1::uuid[])) AS sessions,
            (SELECT count(*)::int FROM experiment_run_sessions WHERE session_id = ANY($1::uuid[])) AS memberships,
            (SELECT count(*)::int FROM experiment_participant_access WHERE session_id = ANY($1::uuid[])) AS credentials,
            (SELECT count(*)::int FROM session_stages WHERE session_id = ANY($1::uuid[])) AS stages,
            (SELECT count(*)::int FROM experiment_session_withdrawals WHERE session_id=$2) AS withdrawals,
            (SELECT count(*)::int FROM experiment_session_withdrawal_audit
             WHERE session_id=$2 AND outcome='SUCCESS') AS audit_success`,
    [ids, cancel.sessionId],
  )).rows[0];
  assert.equal(preserved.sessions, 2);
  assert.equal(preserved.memberships, 2);
  assert.equal(preserved.credentials, 2);
  assert.equal(preserved.stages, 8);
  assert.equal(preserved.withdrawals, 1);
  assert.equal(preserved.audit_success, 2);

  await writeFile(
    verificationReportPath("invariants").replace(/invariants\.json$/, "experiment-withdrawal-acceptance.json"),
    JSON.stringify({
      syntheticOnly: true,
      result: "PASS",
      checks: [
        "researcher registration, generated code and learner authentication",
        "confirmed withdrawal, idempotent retry and immutable audit history",
        "canceled code invalidation and unaffected credential continuity",
        "active participant list and researcher-readable tombstone separation",
        "JSON/CSV/11-sheet XLSX inclusion before and exclusion after withdrawal",
        "two Session records, memberships and access histories preserved",
      ],
    }, null, 2) + "\n",
  );
  console.log("Integrated withdrawal acceptance: PASS (registration, revocation, history, JSON, CSV and 11-sheet XLSX on disposable DB)");
} finally {
  await pool.end();
}
