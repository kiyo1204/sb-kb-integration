// Synthetic-only request, audit and performance checks, run by verify-research-note-safety.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Pool } from "pg";
import type { Request, Response } from "express";
import { tokenHash } from "../access-control.js";
import { verificationReportPath } from "./mock-db.js";
import { loadResearchTextSafety, researchSafetyBudget, ResearchSafetyError, MAX_SAFETY_HASHES } from "../research-output-safety.js";

type Fixture = { id: string; map: string; link: string; token: string };
export async function checkSafetyBudget(pool: Pool, base: string, researcher: string,
  a: Fixture, six: Fixture, five: Fixture, noSecrets: (text: string) => void, otherCodes: string[]) {
  const timings: Record<string, number[]> = {};
  const measure = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try { return await fn(); }
    finally { (timings[name] ??= []).push(Number((performance.now() - start).toFixed(2))); }
  };
  const prefix = `/research/stage1/sessions/${a.id}`;
  const note = (noteText: string) => ({ reportedByCode: "R-test", noteText });
  const evaluation = (rationale: string) => ({ mapId: a.map, linkId: a.link,
    evaluatorCode: "R-test", snapshotSide: "CURRENT", category: "P", rationale });
  async function api(path: string, status: number, body?: unknown, auditSession?: string) {
    const before = auditSession ? (await pool.query("SELECT count(*)::int AS n FROM research_events WHERE session_id=$1", [auditSession])).rows[0].n : null;
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${researcher}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    noSecrets(text);
    assert.equal(response.status, status, `budget route ${path}: expected ${status}, got ${response.status}`);
    if (status === 422 || status === 503) {
      const result = JSON.parse(text);
      assert.deepEqual(Object.keys(result).sort(), ["error", "message"]);
      assert.equal(result.error, status === 422 ? "safety_budget_exceeded" : "safety_lookup_unavailable");
      assert.ok(result.message.includes("管理者"));
      assert.match(response.headers.get("content-type")!, /^application\/json/);
      assert.equal(response.headers.get("content-disposition"), null);
      if (auditSession) {
        assert.equal(response.headers.get("x-research-event-saved"), "true");
        const events = await pool.query("SELECT outcome,reason_code FROM research_events WHERE session_id=$1 ORDER BY sequence_number DESC", [auditSession]);
        assert.equal(events.rowCount, before + 1, "one failure audit only");
        assert.deepEqual(events.rows[0], { outcome: status === 422 ? "REJECTED" : "FAILURE", reason_code: status === 422 ? "VALIDATION" : "SERVER" });
      }
    }
    return text;
  }
  const ascii = (n: number, salt = "A") => salt + "x".repeat(n - salt.length);
  const fake = { query: async () => ({ rows: [{ hash: tokenHash("test-only-absent-code") }] }) } as never;
  function inRequest<T>(fn: () => Promise<T>, response = new EventEmitter()) {
    return new Promise<T>((resolve, reject) => researchSafetyBudget({} as Request, response as Response, () => {
      void fn().then(resolve, reject);
    }));
  }
  await inRequest(async () => {
    const checker = await loadResearchTextSafety(fake);
    for (let i = 0; i < MAX_SAFETY_HASHES - 1; i++)
      assert.equal(checker.containsSecret(`予算境界${i}`), false);
    assert.equal(checker.containsSecret("予算最後"), false, "20,000th actual hash is allowed");
    assert.equal(checker.containsSecret("予算最後"), false, "cached complete check costs no new hash");
    await assert.rejects(async () => (await loadResearchTextSafety(fake)).containsSecret("予算超過"),
      (e: unknown) => e instanceof ResearchSafetyError && e.code === "safety_budget_exceeded");
  });
  // Each check fits alone; two separately loaded checkers in one async request do not.
  for (const text of [ascii(190), ascii(190, "B")])
    await inRequest(async () => assert.equal((await loadResearchTextSafety(fake)).containsSecret(text), false));
  await assert.rejects(inRequest(async () => {
    (await loadResearchTextSafety(fake)).containsSecret(ascii(190));
    await Promise.resolve();
    (await loadResearchTextSafety(fake)).containsSecret(ascii(190, "B"));
  }), (e: unknown) => e instanceof ResearchSafetyError && e.code === "safety_budget_exceeded");
  await Promise.all(Array.from({ length: 8 }, (_, i) => inRequest(async () => {
    await Promise.resolve();
    assert.equal((await loadResearchTextSafety(fake)).containsSecret(ascii(190, String(i))), false);
  })));
  const finished = new EventEmitter();
  await inRequest(async () => {
    const checker = await loadResearchTextSafety(fake);
    finished.emit("finish");
    assert.throws(() => checker.containsSecret("日本語"), ResearchSafetyError);
    await assert.rejects(loadResearchTextSafety(fake), ResearchSafetyError);
  }, finished);
  assert.equal((await loadResearchTextSafety(fake)).containsSecret(ascii(190)), false, "outside request is independent");
  await inRequest(async () => {
    const code = "v".repeat(32);
    assert.equal((await loadResearchTextSafety(fake)).containsKnownSecret(code), false);
    const changedLookup = { query: async () => ({ rows: [{ hash: tokenHash(code) }] }) } as never;
    assert.equal((await loadResearchTextSafety(changedLookup)).containsKnownSecret(code), true,
      "cached digest must be compared against the latest lookup, not a cached safety decision");
  });
  for (let length = 32; length <= 128; length++) {
    const code = "q".repeat(length);
    const lookup = { query: async () => ({ rows: [{ hash: tokenHash(code) }] }) } as never;
    assert.equal((await loadResearchTextSafety(lookup)).containsKnownSecret(`prefix${code}suffix`), true,
      `embedded legacy code length ${length}`);
  }
  for (const [name, texts] of Object.entries({ japanese_1000x10: Array.from({ length: 10 }, (_, i) => "日".repeat(999) + i),
    ascii_1000: [ascii(1000)], ascii_10000: [ascii(10000)], ascii_1000x10: Array.from({ length: 10 }, (_, i) => ascii(1000, String(i))) })) {
    for (let n = 0; n < 5; n++) await measure("function_" + name, async () => {
      const check = await loadResearchTextSafety(fake);
      try { for (const text of texts) check.containsSecret(text); assert.ok(name.startsWith("japanese")); }
      catch (e) { assert.ok(e instanceof ResearchSafetyError && e.code === "safety_budget_exceeded"); }
    });
  }
  // Historical algorithm, only for this synthetic timing comparison. Same hash,
  // windows and local cache, but without the newly added request allowance.
  for (const [name, texts] of Object.entries({ ascii_1000: [ascii(1000)], ascii_10000: [ascii(10000)],
    ascii_1000x10: Array.from({ length: 10 }, (_, i) => ascii(1000, String(i))),
    japanese_1000x10: Array.from({ length: 10 }, (_, i) => "日".repeat(999) + i) })) {
    for (let n = 0; n < 3; n++) await measure("historical_function_" + name, async () => {
      const seen = new Set<string>();
      for (const text of texts) {
        if (seen.has(text)) continue;
        seen.add(text);
        tokenHash(text);
        text.split(/\s+/).forEach(tokenHash);
        for (const run of text.match(/[A-Za-z0-9_-]{32,}/g) ?? []) {
          tokenHash(run);
          for (let i = 0; i + 43 <= run.length; i++) tokenHash(run.slice(i, i + 43));
          for (let size = 32; size <= Math.min(128, run.length); size++) {
            if (size === 43) continue;
            for (let i = 0; i + size <= run.length; i++) tokenHash(run.slice(i, i + size));
          }
        }
      }
    });
  }
  const annotations = () => pool.query("SELECT (SELECT count(*) FROM research_reflection_notes WHERE session_id=$1) AS notes,(SELECT count(*) FROM research_proposition_evaluations WHERE session_id=$1) AS evals,(SELECT count(*) FROM operation_receipts) AS receipts", [a.id]);
  const original = (await annotations()).rows;
  for (let i = 0; i < 5; i++) {
    await measure("api_note_ascii_10000", () => api(prefix + "/reflections", 422, note(ascii(10000)), a.id));
    await measure("api_evaluation_ascii_5000", () => api(prefix + "/evaluations", 422, evaluation(ascii(5000)), a.id));
  }
  assert.deepEqual((await annotations()).rows, original, "refused writes/receipts unchanged");
  for (let i = 0; i < 5; i++) await measure("api_japanese_1000", () => api(prefix + "/reflections", 201, note("日".repeat(1000))));
  await measure("api_parallel_8_independent", () => Promise.all(Array.from({ length: 8 }, (_, i) => api(prefix + "/reflections", 201, note(ascii(190, String(i)))))));
  await measure("api_parallel_4_exceeded", () => Promise.all(Array.from({ length: 4 }, () => api(prefix + "/reflections", 422, note(ascii(10000))))));
  await pool.query("DELETE FROM research_reflection_notes WHERE session_id=$1", [a.id]);
  // Real analysis does two independent loads: raw Map then researcher annotations.
  const concept = (await pool.query("SELECT id,label FROM concepts WHERE map_id=$1 ORDER BY id LIMIT 1", [a.map])).rows[0];
  await pool.query("UPDATE concepts SET label=$2 WHERE id=$1", [concept.id, ascii(190)]);
  await api(prefix + "/analysis", 200);
  await pool.query("UPDATE concepts SET label=$2 WHERE id=$1", [concept.id, concept.label]);
  await api(prefix + "/reflections", 201, note(ascii(190, "B")));
  await api(prefix + "/analysis", 200);
  await pool.query("UPDATE concepts SET label=$2 WHERE id=$1", [concept.id, ascii(190)]);
  await api(prefix + "/analysis", 422, undefined, a.id);
  await api(prefix + "/reflections.csv", 422, undefined, a.id);
  await pool.query("DELETE FROM research_reflection_notes WHERE session_id=$1", [a.id]);
  await pool.query("UPDATE concepts SET label=$2 WHERE id=$1", [concept.id, ascii(1000)]);
  for (const suffix of ["analysis", "evaluations.csv", "reflections.csv", "operations.csv", "features.csv"])
    await api(prefix + "/" + suffix, 422, undefined, a.id);
  await api(`/research/sessions/${a.id}/export`, 422, undefined, a.id);
  await pool.query("UPDATE concepts SET label=$2 WHERE id=$1", [concept.id, concept.label]);
  // Multiple stored rows, each below the allowance, still share one output budget.
  for (let i = 0; i < 10; i++) await api(prefix + "/reflections", 201, note(ascii(190, String(i))));
  for (let i = 0; i < 5; i++) await measure("api_multiple_rows", () => api(prefix + "/reflections.csv", 422, undefined, a.id));
  await pool.query("DELETE FROM research_reflection_notes WHERE session_id=$1", [a.id]);
  const survey = (await pool.query("INSERT INTO survey_questions(session_id,kind,prompt,display_order,required,config) VALUES($1,'TEXT','テスト専用',0,false,'{}') RETURNING id", [five.id])).rows[0].id;
  const assessment = (await pool.query("SELECT id,prompt FROM assessment_questions WHERE session_id=$1 LIMIT 1", [six.id])).rows[0];
  const goal = (await pool.query("INSERT INTO maps(type,status,title) VALUES('GOAL','DRAFT','テスト専用予算') RETURNING id")).rows[0].id;
  const goalConcept = (await pool.query("INSERT INTO concepts(map_id,label,position_x,position_y) VALUES($1,'テスト専用',0,0) RETURNING id", [goal])).rows[0].id;
  const goalPath = `/research/goal-maps/${goal}/export`;
  const imports = { format: "sb-kb-goal-map", schemaVersion: 1, goalMap: { title: "テスト専用" + randomUUID(),
    concepts: [0, 1].map(i => ({ id: `c${i}`, label: ascii(190, String(i)), position: { x: 0, y: 0 } })), links: [] } };
  const surveyPaths = [`/research/stage1/sessions/${five.id}/survey`, `/research/stage1/sessions/${five.id}/survey-answers.csv`];
  const assessmentPaths = [`/research/stage1/sessions/${six.id}/assessment`, `/research/stage1/sessions/${six.id}/assessment-answers.csv`];
  try {
    // Real JSON attachment at exactly N-1, N and N+1 hashes. All values are
    // distinct short Japanese words; a multiword label costs its whole + words.
    const boundaryMap = (await pool.query("INSERT INTO maps(type,status,title) VALUES('GOAL','DRAFT','テスト専用境界') RETURNING id")).rows[0].id;
    try {
      for (const [extraWords, status] of [[1998, 200], [1999, 200], [2000, 422]]) {
        await pool.query("DELETE FROM links WHERE map_id=$1", [boundaryMap]);
        await pool.query("DELETE FROM concepts WHERE map_id=$1", [boundaryMap]);
        const labels = Array.from({ length: 3000 }, (_, i) => Array.from({ length: i < extraWords! ? 6 : 5 }, (_, j) => `境界${i}語${j}`).join(" "));
        const nodes = (await pool.query("INSERT INTO concepts(map_id,label,position_x,position_y) SELECT $1,label,0,0 FROM unnest($2::text[]) label RETURNING id", [boundaryMap, labels.slice(0, 1000)])).rows;
        await pool.query("INSERT INTO links(map_id,label,source_concept_id,target_concept_id) SELECT $1,label,$3,$4 FROM unnest($2::text[]) label", [boundaryMap, labels.slice(1000), nodes[0].id, nodes[1].id]);
        const text = await api(`/research/goal-maps/${boundaryMap}/export`, status!);
        if (status === 200) {
          const document = JSON.parse(text);
          assert.equal(document.goalMap.concepts.length, 1000);
          assert.equal(document.goalMap.links.length, 2000);
        }
      }
    } finally { await pool.query("DELETE FROM maps WHERE id=$1", [boundaryMap]); }
    for (const path of [...surveyPaths, ...assessmentPaths, goalPath]) await api(path, 200);
    for (const text of [researcher, a.token, ...otherCodes.flatMap(code => [code, "prefix" + code + "suffix"]), "Bearer synthetic-credential"]) {
      await pool.query("UPDATE survey_questions SET prompt=$2 WHERE id=$1", [survey, text]);
      await pool.query("UPDATE assessment_questions SET prompt=$2 WHERE id=$1", [assessment.id, text]);
      for (const path of [...surveyPaths, ...assessmentPaths]) assert.ok((await api(path, 200)).includes("[REDACTED]"));
    }
    await pool.query("UPDATE survey_questions SET prompt=$2 WHERE id=$1", [survey, ascii(1000)]);
    await pool.query("UPDATE assessment_questions SET prompt=$2 WHERE id=$1", [assessment.id, ascii(1000)]);
    await pool.query("UPDATE concepts SET label=$2 WHERE id=$1", [goalConcept, ascii(1000)]);
    for (const path of surveyPaths) await api(path, 422, undefined, path.endsWith(".csv") ? five.id : undefined);
    // The learner survey read also calls surveySnapshot; exercise that outer catch.
    const stage = (await pool.query("SELECT id FROM session_stages WHERE session_id=$1 AND stage_type='SURVEY'", [five.id])).rows[0].id;
    await pool.query("UPDATE sessions SET status='IN_PROGRESS',completed_at=NULL WHERE id=$1", [five.id]);
    await pool.query("UPDATE session_stages SET status='IN_PROGRESS',completed_at=NULL WHERE id=$1", [stage]);
    await api(`/session-stages/${stage}/survey`, 422);
    for (const path of assessmentPaths) await api(path, 422, undefined, path.endsWith(".csv") ? six.id : undefined);
    await api(goalPath, 422);
    const counts = async () => (await pool.query("SELECT (SELECT count(*) FROM maps) AS maps,(SELECT count(*) FROM kit_definitions) AS kits,(SELECT count(*) FROM concepts) AS concepts")).rows;
    const before = await counts();
    await api("/research/goal-maps/import", 422, imports);
    assert.deepEqual(await counts(), before);
    // Selective lookup failure leaves the audit database available; no exception text leaks.
    await pool.query("ALTER TABLE research_identity.revocations RENAME TO stage1_mock_budget_hidden");
    try {
      for (const path of surveyPaths) await api(path, 503, undefined, path.endsWith(".csv") ? five.id : undefined);
      await api(`/session-stages/${stage}/survey`, 503);
      for (const path of assessmentPaths) await api(path, 503, undefined, path.endsWith(".csv") ? six.id : undefined);
      for (const suffix of ["analysis", "evaluations.csv", "reflections.csv", "operations.csv", "features.csv"])
        await api(prefix + "/" + suffix, 503, undefined, a.id);
      await api(`/research/sessions/${a.id}/export`, 503, undefined, a.id);
      await api(goalPath, 503);
      await api("/research/goal-maps/import", 503, imports);
      const beforeWrites = (await annotations()).rows;
      await api(prefix + "/evaluations", 503, evaluation("テスト専用"), a.id);
      await api(prefix + "/reflections", 503, note("テスト専用"), a.id);
      assert.deepEqual((await annotations()).rows, beforeWrites);
      assert.deepEqual(await counts(), before);
    } finally { await pool.query("ALTER TABLE research_identity.stage1_mock_budget_hidden RENAME TO revocations"); }
  } finally {
    await pool.query("UPDATE sessions SET status='COMPLETED',completed_at=now() WHERE id=$1", [five.id]);
    await pool.query("UPDATE session_stages SET status='COMPLETED',completed_at=now() WHERE session_id=$1 AND stage_type='SURVEY'", [five.id]);
    await pool.query("DELETE FROM survey_questions WHERE id=$1", [survey]);
    await pool.query("UPDATE assessment_questions SET prompt=$2 WHERE id=$1", [assessment.id, assessment.prompt]);
    await pool.query("DELETE FROM maps WHERE id=$1", [goal]);
  }
  const report = { check: "request-safety-budget", node: process.version, platform: process.platform, cpu: cpus()[0]?.model,
    method: "performance.now wall ms; 5 current/3 historical sequential samples; parallel batches 8 accepted / 4 refused; API includes audit and disposable PostgreSQL; function fake lookup", timings };
  await writeFile(verificationReportPath("suite-results").replace("suite-results", "performance"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
