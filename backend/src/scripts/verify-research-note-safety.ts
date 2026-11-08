// Synthetic fixtures only: no experimental materials or production database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { parse } from "csv-parse/sync";
import { createLearnerToken, tokenHash } from "../access-control.js";
import { verifyMockTestUrl } from "./mock-db.js";
import { loadResearchTextSafety } from "../research-output-safety.js";

await verifyMockTestUrl(process.env.DATABASE_URL!);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const researcher = process.env.RESEARCHER_API_TOKEN!;
const root = await mkdtemp(join(tmpdir(), "research-note-safety-"));
const listener = createServer();
await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
const address = listener.address();
assert.ok(address && typeof address !== "string");
const port = address.port;
await new Promise<void>((r) => listener.close(() => r()));
// Own the real API process so rejection / DB exception logs are checked too.
const server = spawn(process.execPath, [resolve("dist/index.js")], {
  env: {
    ...process.env,
    PORT: String(port),
    API_BIND_ADDRESS: "127.0.0.1",
    STAGE1_EXPORT_CACHE_ROOT: root,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let logs = "";
server.stdout.on("data", (b) => {
  logs += String(b);
});
server.stderr.on("data", (b) => {
  logs += String(b);
});
const base = `http://127.0.0.1:${port}/api`;
const ids: string[] = [];
const revoked = createLearnerToken();
let receipt: string | undefined;
const markers: string[] = [];
const secrets = [researcher, revoked.token];
function noSecrets(text: string) {
  assert.ok(
    secrets.every((secret) => !text.includes(secret)),
    "secret leaked",
  );
}
async function request(
  path: string,
  status: number,
  body?: unknown,
  token = researcher,
) {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  noSecrets(text);
  noSecrets(JSON.stringify([...res.headers]));
  assert.ok(
    res.status === status,
    `unexpected status ${res.status} for ${path}`,
  );
  return text;
}
async function fixture(protocol = "STAGE1_4") {
  const token = createLearnerToken();
  secrets.push(token.token);
  const id = randomUUID();
  ids.push(id);
  await pool.query(
    `INSERT INTO sessions(id,protocol_key,participant_code,status,started_at,completed_at,learner_access_token_hash,lesson_video_url,research_kit_definition_id,study_group,group_activity_seconds)
    VALUES($1,$4,$2,'COMPLETED',now(),now(),$3,'/synthetic-only.mp4','66666666-6666-4666-8666-666666666662',$5,60)`,
    [
      id,
      `synthetic-note-${randomUUID()}`,
      token.hash,
      protocol,
      protocol === "STAGE1_6" ? "CONTROL" : null,
    ],
  );
  for (const [order, type] of (protocol === "STAGE1_6"
    ? [
        "LESSON",
        "PRIOR_MAP",
        "KB_MAP",
        "PRE_ASSESSMENT",
        "SELF_STUDY",
        "POST_ASSESSMENT",
      ]
    : ["LESSON", "PRIOR_MAP", "KB_MAP", "INTEGRATION_MAP"]
  ).entries()) {
    await pool.query(
      `INSERT INTO session_stages(session_id,stage_type,order_index,status,started_at,completed_at)
      VALUES($1,$2,$3,'COMPLETED',now(),now())`,
      [id, type, order],
    );
  }
  const map = (
    await pool.query(
      `INSERT INTO maps(type,status,session_stage_id,submitted_at)
    SELECT 'PRIOR','SUBMITTED',id,now() FROM session_stages WHERE session_id=$1 AND stage_type='PRIOR_MAP' RETURNING id`,
      [id],
    )
  ).rows[0].id;
  const concepts = (
    await pool.query(
      `INSERT INTO concepts(map_id,label,position_x,position_y)
    VALUES($1,'テスト専用A',0,0),($1,'テスト専用B',100,100) RETURNING id`,
      [map],
    )
  ).rows;
  const link = (
    await pool.query(
      `INSERT INTO links(map_id,source_concept_id,target_concept_id,label)
    VALUES($1,$2,$3,'テスト専用関係') RETURNING id`,
      [map, concepts[0].id, concepts[1].id],
    )
  ).rows[0].id;
  return { id, map, link, token: token.token };
}
async function rows(id: string) {
  return (
    await pool.query(
      `SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]') FROM research_proposition_evaluations e WHERE session_id=$1) AS evaluations,
    (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY id),'[]') FROM research_reflection_notes n WHERE session_id=$1) AS notes`,
      [id],
    )
  ).rows[0];
}
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base + "/health")).ok) {
        ready = true;
        break;
      }
    } catch {
      /* startup */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, "test API did not start");
  const a = await fixture(),
    other = await fixture(),
    answerSession = await fixture("STAGE1_6");
  const legacyCode = "z".repeat(32);
  secrets.push(legacyCode);
  await pool.query(
    "UPDATE sessions SET learner_access_token_hash=$2 WHERE id=$1",
    [answerSession.id, tokenHash(legacyCode)],
  );
  const question = (
    await pool.query(
      "INSERT INTO assessment_questions(session_id,category,prompt,display_order) VALUES($1,'DESCRIPTION','テスト専用の設問',0) RETURNING id",
      [answerSession.id],
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO assessment_answers(session_id,stage_id,question_id,answer) SELECT $1,id,$2,'テスト専用：別Sessionの回答' FROM session_stages WHERE session_id=$1 AND stage_type='PRE_ASSESSMENT'",
    [answerSession.id, question],
  );
  receipt = (
    await pool.query(
      "INSERT INTO research_deletion_receipts(session_count) VALUES(1) RETURNING id",
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO research_identity.revocations(token_hash,queue_key,receipt_id) VALUES($1,$2,$3)",
    [revoked.hash, `deleted:${randomUUID()}`, receipt],
  );
  const prefix = `/research/stage1/sessions/${a.id}`;
  const good = {
    rationale: "テスト専用：根拠を再確認。\nhttps://example.invalid/synthetic",
    noteText: '=テスト専用のメモ、"引用"\nパスワードの仕組み',
  };
  const evaluation = (rationale: string) => ({
    mapId: a.map,
    linkId: a.link,
    evaluatorCode: "R-test",
    snapshotSide: "CURRENT",
    category: "P",
    rationale,
  });
  const note = (noteText: string) => ({
    mapId: a.map,
    reportedByCode: "R-test",
    noteText,
  });
  await request(`/research/stage1/sessions/${other.id}/reflections`, 201, {
    reportedByCode: "R-other",
    noteText: "テスト専用：別Sessionのメモ",
  });
  // Existing learner answers in any Session must remain byte-for-byte unchanged.
  const answers = await pool.query(
    "SELECT to_jsonb(a) AS value FROM assessment_answers a ORDER BY stage_id,question_id",
  );
  const otherBefore = await rows(other.id);
  const baseline = JSON.parse(
    await request(prefix + "/analysis", 200),
  ).features;
  const unsafe = [
    researcher,
    a.token,
    other.token,
    revoked.token,
    legacyCode,
    `prefix${legacyCode}suffix`,
    `prefix${a.token}suffix`,
    "password=synthetic-credential",
    "Bearer synthetic-credential",
    "アクセスコード：synthetic-credential",
    "-----BEGIN PRIVATE KEY-----",
  ];
  for (const [field, suffix, body] of [
    ["rationale", "evaluations", evaluation],
    ["noteText", "reflections", note],
  ] as const) {
    for (const [i, value] of unsafe.entries()) {
      const marker = `synthetic-rejected-${field}-${i}`;
      markers.push(marker);
      const before = await rows(a.id);
      const text = await request(
        prefix + "/" + suffix,
        400,
        body(`${marker} ${value}`),
      );
      assert.ok(!text.includes(marker), "rejected text reflected");
      assert.equal(JSON.parse(text).error, "sensitive_text_rejected");
      assert.deepEqual(await rows(a.id), before, "rejected text stored");
    }
  }
  await request(prefix + "/evaluations", 400, {
    ...evaluation("テスト専用"),
    evaluatorCode: a.token,
  });
  await request(prefix + "/reflections", 400, {
    ...note("テスト専用"),
    reportedByCode: other.token,
  });
  await request(prefix + "/evaluations", 201, evaluation(good.rationale));
  await request(prefix + "/reflections", 201, note(good.noteText));
  const saved = await rows(a.id);
  assert.ok(saved.evaluations[0].rationale === good.rationale);
  assert.ok(saved.notes[0].note_text === good.noteText);
  // Legacy rows deliberately bypass input validation. Do not migrate / rewrite them.
  for (const value of unsafe) {
    await pool.query(
      `INSERT INTO research_proposition_evaluations(session_id,map_id,link_id,snapshot_side,subject_snapshot,evaluator_code,category,rationale)
      VALUES($1,$2,$3,'CURRENT',$4,'R-test','P',$5)`,
      [
        a.id,
        a.map,
        a.link,
        JSON.stringify({ label: value }),
        `テスト専用の旧理由 ${value}`,
      ],
    );
    await pool.query(
      `INSERT INTO research_reflection_notes(session_id,map_id,reported_by_code,note_text)
      VALUES($1,$2,'R-test',$3)`,
      [a.id, a.map, `テスト専用の旧メモ ${value}`],
    );
  }
  const legacyBefore = await rows(a.id);
  const analysis = JSON.parse(await request(prefix + "/analysis", 200));
  assert.deepEqual(analysis.features, baseline);
  assert.equal(
    analysis.propositionEvaluations.filter(
      (x: { rationale: string }) => x.rationale === "[REDACTED]",
    ).length,
    unsafe.length,
  );
  assert.equal(
    analysis.reflectionNotes.filter(
      (x: { noteText: string }) => x.noteText === "[REDACTED]",
    ).length,
    unsafe.length,
  );
  assert.ok(
    analysis.propositionEvaluations
      .filter((x: { rationale: string }) => x.rationale === "[REDACTED]")
      .every(
        (x: { subjectSnapshot: { label: string } }) =>
          x.subjectSnapshot.label === "[REDACTED]",
      ),
  );
  assert.ok(
    analysis.propositionEvaluations.some(
      (x: { rationale: string }) => x.rationale === good.rationale,
    ),
  );
  assert.ok(
    analysis.reflectionNotes.some(
      (x: { noteText: string }) => x.noteText === good.noteText,
    ),
  );
  for (const [suffix, key, benign] of [
    ["evaluations.csv", "rationale", good.rationale],
    ["reflections.csv", "noteText", good.noteText],
  ] as const) {
    const text = await request(prefix + "/" + suffix, 200);
    const parsed = parse(text, { columns: true, bom: true }) as Record<
      string,
      string
    >[];
    assert.equal(
      parsed.filter((x) => x[key] === "[REDACTED]").length,
      unsafe.length,
    );
    assert.ok(
      parsed.some(
        (x) => x[key] === (benign.startsWith("=") ? "'" : "") + benign,
      ),
    );
  }
  for (const suffix of ["operations.csv", "features.csv"])
    await request(prefix + "/" + suffix, 200);
  const raw = JSON.parse(
    await request(`/research/sessions/${a.id}/export`, 200),
  );
  assert.equal(raw.exportVersion, 1);
  // These annotations have never been part of the raw/event contracts. Do not add them.
  assert.ok(!("propositionEvaluations" in raw) && !("reflectionNotes" in raw));
  const exportJob = JSON.parse(
    await request("/research/event-exports", 201, {
      filters: { sessionIds: [a.id] },
    }),
  );
  for (const file of exportJob.files as { name: string }[]) {
    if (/\.(json|csv)$/.test(file.name))
      await request(
        `/research/event-exports/${exportJob.exportId}/${file.name}`,
        200,
      );
  }
  for (const token of ["", a.token, other.token]) {
    for (const suffix of [
      "analysis",
      "evaluations.csv",
      "reflections.csv",
      "operations.csv",
      "features.csv",
    ])
      await request(prefix + "/" + suffix, token ? 403 : 401, undefined, token);
    await request(
      prefix + "/evaluations",
      token ? 403 : 401,
      evaluation("テスト専用：認可拒否"),
      token,
    );
    await request(
      prefix + "/reflections",
      token ? 403 : 401,
      note("テスト専用：認可拒否"),
      token,
    );
    await request(
      `/research/sessions/${a.id}/export`,
      token ? 403 : 401,
      undefined,
      token,
    );
  }
  // Database errors may include parameter / exception text: the API must emit constants only.
  for (const [table, column, suffix, body] of [
    [
      "research_proposition_evaluations",
      "rationale",
      "evaluations",
      evaluation,
    ],
    ["research_reflection_notes", "note_text", "reflections", note],
  ] as const) {
    await pool.query(
      `CREATE FUNCTION stage1_mock_note_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sensitive database detail %',NEW.${column}; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER stage1_mock_note_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION stage1_mock_note_fail()`,
    );
    try {
      const marker = `synthetic-db-failure-${suffix}`;
      markers.push(marker);
      const before = await rows(a.id);
      const text = await request(prefix + "/" + suffix, 500, body(marker));
      assert.ok(!text.includes(marker));
      assert.deepEqual(await rows(a.id), before);
    } finally {
      await pool.query(`DROP TRIGGER stage1_mock_note_fail ON ${table}`);
      await pool.query("DROP FUNCTION stage1_mock_note_fail()");
    }
  }
  // Only this disposable DB: temporarily hide the lookup relation to exercise
  // real API failure paths, restoring it before cleanup / subsequent tests.
  await pool.query(
    "ALTER TABLE research_identity.revocations RENAME TO stage1_mock_hidden_revocations",
  );
  try {
    for (const suffix of [
      "analysis",
      "evaluations.csv",
      "reflections.csv",
      "operations.csv",
      "features.csv",
    ])
      await request(prefix + "/" + suffix, 500);
    await request(`/research/sessions/${a.id}/export`, 500);
    await request(
      prefix + "/evaluations",
      500,
      evaluation("synthetic-lookup-failure"),
    );
    await request(
      prefix + "/reflections",
      500,
      note("synthetic-lookup-failure"),
    );
  } finally {
    await pool.query(
      "ALTER TABLE research_identity.stage1_mock_hidden_revocations RENAME TO revocations",
    );
  }
  await assert.rejects(
    loadResearchTextSafety({
      query: async () => {
        throw new Error("synthetic lookup unavailable");
      },
    } as never),
  );
  assert.deepEqual(
    await rows(a.id),
    legacyBefore,
    "legacy rows rewritten on output",
  );
  assert.deepEqual(await rows(other.id), otherBefore);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT to_jsonb(a) AS value FROM assessment_answers a ORDER BY stage_id,question_id",
      )
    ).rows,
    answers.rows,
  );
  const audits = (
    await pool.query(
      "SELECT to_jsonb(e) AS value FROM research_events e WHERE session_id=$1",
      [a.id],
    )
  ).rows;
  const auditText = JSON.stringify(audits);
  noSecrets(auditText);
  assert.ok(
    markers.every((m) => !auditText.includes(m) && !logs.includes(m)),
    "input appeared in audit or server log",
  );
  assert.ok(
    audits.some(
      (x) =>
        x.value.outcome === "REJECTED" &&
        x.value.event_type === "RESEARCH_ASSESSMENT_CHANGE",
    ),
  );
  assert.ok(
    audits.some(
      (x) =>
        x.value.outcome === "FAILURE" &&
        x.value.event_type === "RESEARCH_ASSESSMENT_CHANGE",
    ),
  );
  noSecrets(logs);
  console.log(
    "Research annotation safety: PASS (rationale / noteText; save, legacy reads, CSV, raw JSON, event exports, auth, rollback, audit/logs)",
  );
} finally {
  if (server.exitCode === null) {
    const done = once(server, "exit");
    server.kill();
    await done;
  }
  await rm(root, { recursive: true, force: true });
  // This test owns only these synthetic fixtures / revocation receipt.
  if (receipt) {
    await pool.query(
      "DELETE FROM research_identity.revocations WHERE receipt_id=$1",
      [receipt],
    );
    await pool.query("DELETE FROM research_deletion_receipts WHERE id=$1", [
      receipt,
    ]);
  }
  for (const table of [
    "assessment_answers",
    "assessment_questions",
    "research_proposition_evaluations",
    "research_reflection_notes",
    "research_events",
    "research_event_counters",
  ])
    await pool.query(`DELETE FROM ${table} WHERE session_id=ANY($1::uuid[])`, [
      ids,
    ]);
  await pool.query(
    "DELETE FROM maps WHERE session_stage_id IN(SELECT id FROM session_stages WHERE session_id=ANY($1::uuid[]))",
    [ids],
  );
  await pool.query(
    "DELETE FROM session_stages WHERE session_id=ANY($1::uuid[])",
    [ids],
  );
  const members = (
    await pool.query(
      "DELETE FROM research_identity.membership WHERE session_id=ANY($1::uuid[]) RETURNING participant_id",
      [ids],
    )
  ).rows;
  await pool.query("DELETE FROM sessions WHERE id=ANY($1::uuid[])", [ids]);
  await pool.query(
    "DELETE FROM research_identity.participants WHERE id=ANY($1::uuid[])",
    [members.map((x) => x.participant_id)],
  );
  await pool.end();
  noSecrets(logs);
}
