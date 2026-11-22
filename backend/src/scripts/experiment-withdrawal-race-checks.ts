// TEST ONLY: deterministic API races in a freshly guarded, disposable synthetic DB.
// A held run-row lock queues both requests; pg_stat_activity verifies their order
// before release. No production data, mock resets or source migrations are touched.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { writeFile } from "node:fs/promises";
import { verifyMockTestUrl, verificationReportPath } from "./mock-db.js";

type Reply = { status: number; data: Record<string, unknown> };
type Fixture = { runId: string; sessionId: string; code: string; generation: number };
type Operation = { queryPrefix: string; send: () => Promise<Reply> };

const runLock = "SELECT r.state FROM experiment_runs r JOIN experiment_run_catalog";
const startLock = "SELECT r.* FROM experiment_runs r JOIN experiment_run_catalog";
const accessLock = "SELECT 1 FROM experiment_runs r JOIN experiment_run_catalog";
const clientLock = "SELECT a.*,p.run_id,r.state FROM experiment_participant_access";
const root = "/research/experiment-runs";

export async function checkExperimentWithdrawalRaces(input: {
  pool: Pool; base: string; token: string; materialVersionId: string;
}) {
  const { pool, base, token, materialVersionId } = input;
  await verifyMockTestUrl(process.env.DATABASE_URL!);
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/, "race API must be local");

  async function request(
    path: string, method = "GET", body?: unknown,
    credential = token, headers: Record<string, string> = {},
  ): Promise<Reply> {
    const response = await fetch(base + "/api" + path, {
      method,
      headers: {
        Authorization: "Bearer " + credential,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    const data = (await response.json()) as Record<string, unknown>;
    return { status: response.status, data };
  }
  function expect(response: Reply, status: number, error?: string) {
    assert.equal(response.status, status, `race HTTP: ${String(response.data.error ?? "")}`);
    if (error) assert.equal(response.data.error, error);
  }
  async function fixture(label: string): Promise<Fixture> {
    const run = await request(root, "POST", {
      name: "TEST ONLY withdrawal race " + label + " " + randomUUID().slice(0, 8),
      catalogVersionId: materialVersionId,
      plannedParticipants: 1,
    });
    expect(run, 201);
    const runId = run.data.id as string;
    assert.ok(runId);
    const registration = await request(`${root}/${runId}/participants`, "POST", {
      participantLabel: "TEST ONLY " + label,
    });
    expect(registration, 201);
    assert.equal(typeof registration.data.issuedCode, "string");
    return {
      runId,
      sessionId: registration.data.sessionId as string,
      code: registration.data.issuedCode as string,
      generation: registration.data.credentialGeneration as number,
    };
  }
  const withdraw = (f: Fixture): Operation => ({
    queryPrefix: runLock,
    send: () => request(
      `${root}/${f.runId}/participants/${f.sessionId}/withdraw`,
      "POST",
      { confirmed: true, expectedCredentialGeneration: f.generation },
    ),
  });
  const reissue = (f: Fixture): Operation => ({
    queryPrefix: accessLock,
    send: () => request(
      `${root}/${f.runId}/participants/${f.sessionId}/code/reissue`,
      "POST",
      { expectedCredentialGeneration: f.generation },
    ),
  });
  const start = (f: Fixture): Operation => ({
    queryPrefix: startLock,
    send: () => request(`${root}/${f.runId}/start`, "POST", {}),
  });
  const claim = (f: Fixture): Operation => ({
    queryPrefix: clientLock,
    send: () => request("/experiment-client/claim", "POST", {}, f.code, {
      "X-Experiment-Client": randomBytes(32).toString("base64url"),
    }),
  });

  async function waitUntilBlocked(prefix: string) {
    for (let attempt = 0; attempt < 320; attempt++) {
      const waiting = await pool.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname=current_database() AND state='active'
           AND wait_event_type='Lock' AND query LIKE $1 LIMIT 1`,
        [prefix + "%"],
      );
      if (waiting.rowCount) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("API request did not block on expected run row: " + prefix);
  }

  async function ordered(f: Fixture, first: Operation, second: Operation): Promise<[Reply, Reply]> {
    const lock = await pool.connect();
    let open = false;
    try {
      await lock.query("BEGIN");
      open = true;
      await lock.query("SELECT 1 FROM experiment_runs WHERE id=$1 FOR UPDATE", [f.runId]);
      const a = first.send();
      void a.catch(() => undefined);
      await waitUntilBlocked(first.queryPrefix);
      const b = second.send();
      void b.catch(() => undefined);
      await waitUntilBlocked(second.queryPrefix);
      await lock.query("COMMIT");
      open = false;
      return await Promise.all([a, b]);
    } finally {
      if (open) await lock.query("ROLLBACK").catch(() => undefined);
      lock.release();
    }
  }

  async function inspect(f: Fixture) {
    const result = await pool.query(
      `SELECT r.state,
         (SELECT count(*)::int FROM sessions WHERE id=$2) AS sessions,
         (SELECT count(*)::int FROM experiment_run_sessions WHERE session_id=$2) AS members,
         (SELECT count(*)::int FROM session_stages WHERE session_id=$2) AS stages,
         (SELECT count(*)::int FROM experiment_session_withdrawals WHERE session_id=$2) AS canceled,
         (SELECT count(*)::int FROM experiment_client_candidates WHERE session_id=$2) AS clients,
         (SELECT credential_generation FROM experiment_participant_access WHERE session_id=$2) AS generation
       FROM experiment_runs r WHERE r.id=$1`,
      [f.runId, f.sessionId],
    );
    const row = result.rows[0];
    assert.equal(row.sessions, 1, "Session survives all races");
    assert.equal(row.members, 1, "membership survives all races");
    assert.equal(row.stages, 4, "stage history survives all races");
    return row as {
      state: string; sessions: number; members: number; stages: number;
      canceled: number; clients: number; generation: number;
    };
  }
  async function audit(f: Fixture, success: number, rejected: number) {
    const result = await pool.query(
      `SELECT outcome,count(*)::int AS n
       FROM experiment_session_withdrawal_audit WHERE session_id=$1
       GROUP BY outcome`,
      [f.sessionId],
    );
    const byOutcome = Object.fromEntries(result.rows.map((r) => [r.outcome, r.n]));
    assert.equal(byOutcome.SUCCESS ?? 0, success, "durable withdrawal success audit");
    assert.equal(byOutcome.REJECTED ?? 0, rejected, "durable withdrawal rejection audit");
  }
  const tests: string[] = [];

  {
    // Withdrawal queues first: reissue cannot rotate the invalidated code.
    const f = await fixture("withdraw before reissue");
    const [w, r] = await ordered(f, withdraw(f), reissue(f));
    expect(w, 200);
    expect(r, 404, "not_found");
    const row = await inspect(f);
    assert.equal(row.canceled, 1);
    assert.equal(row.generation, f.generation);
    expect(await request("/me", "GET", undefined, f.code), 401, "experiment_code_invalidated");
    await audit(f, 1, 0);
    tests.push("withdrawal wins before reissue: reissue refused, generation unchanged");
  }
  {
    // Reissue queues first: obsolete expected generation cannot cancel current code.
    const f = await fixture("reissue before withdraw");
    const [r, w] = await ordered(f, reissue(f), withdraw(f));
    expect(r, 200);
    expect(w, 409, "not_eligible");
    assert.equal(typeof r.data.issuedCode, "string");
    const row = await inspect(f);
    assert.equal(row.canceled, 0);
    assert.equal(row.generation, f.generation + 1);
    expect(await request("/me", "GET", undefined, f.code), 401);
    expect(await request("/me", "GET", undefined, r.data.issuedCode as string), 200);
    await audit(f, 0, 1);
    tests.push("reissue wins before withdrawal: stale expected generation refused");
  }
  {
    // Withdrawal queues first: even an authenticated but blocked client cannot claim.
    const f = await fixture("withdraw before client claim");
    const [w, c] = await ordered(f, withdraw(f), claim(f));
    expect(w, 200);
    expect(c, 401, "experiment_code_invalidated");
    const row = await inspect(f);
    assert.equal(row.canceled, 1);
    assert.equal(row.clients, 0);
    await audit(f, 1, 0);
    tests.push("withdrawal wins before client claim: no candidate or active client created");
  }
  {
    // Claim queues first: any recorded client blocks withdrawal permanently.
    const f = await fixture("claim before withdraw");
    const [c, w] = await ordered(f, claim(f), withdraw(f));
    expect(c, 200);
    assert.equal(c.data.ownership, "OWNED");
    expect(w, 409, "not_eligible");
    const row = await inspect(f);
    assert.equal(row.canceled, 0);
    assert.equal(row.clients, 1);
    expect(await request("/me", "GET", undefined, f.code), 200);
    await audit(f, 0, 1);
    tests.push("client claim wins before withdrawal: immutable client history blocks cancellation");
  }
  {
    // Withdrawal queues first: start must see no active participant and stay PREPARING.
    const f = await fixture("withdraw before start");
    const [w, s] = await ordered(f, withdraw(f), start(f));
    expect(w, 200);
    expect(s, 409, "participants_required");
    const row = await inspect(f);
    assert.equal(row.state, "PREPARING");
    assert.equal(row.canceled, 1);
    await audit(f, 1, 0);
    tests.push("withdrawal wins before start: no active participant prevents run start");
  }
  {
    // Start queues first: the run becomes RUNNING, so withdrawal is forbidden.
    const f = await fixture("start before withdraw");
    const [s, w] = await ordered(f, start(f), withdraw(f));
    expect(s, 200);
    assert.equal(s.data.state, "RUNNING");
    expect(w, 409, "not_eligible");
    const row = await inspect(f);
    assert.equal(row.state, "RUNNING");
    assert.equal(row.canceled, 0);
    expect(await request("/me", "GET", undefined, f.code), 200);
    await audit(f, 0, 1);
    tests.push("start wins before withdrawal: running registration stays active");
  }

  await writeFile(
    verificationReportPath("invariants").replace(/invariants\.json$/, "withdrawal-races.json"),
    JSON.stringify({ syntheticOnly: true, result: "PASS", scenarios: tests }, null, 2) + "\n",
  );
  console.log("Experiment withdrawal races: PASS (six ordered API races; preserved Session, stage, membership, authorization and audit)");
}
