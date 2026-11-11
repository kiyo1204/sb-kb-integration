import { checkMapReadDeadlines } from "./experiment-map-deadline-checks.js";
// TEST ONLY: actual product routes/auth, real disposable PostgreSQL; transport
// pause is injected by the separate preload, never by a public product switch.
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import { verifyMockTestUrl } from "./mock-db.js";

export async function checkMapReadEndOrdering(
  pool: Pool,
  base: string,
  version: string,
  dir: string,
) {
  await verifyMockTestUrl(process.env.DATABASE_URL!);
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wait = async (condition: () => Promise<boolean>, label: string) => {
    for (let i = 0; i < 200; i++) {
      if (await condition()) return;
      await pause(20);
    }
    assert.fail(label);
  };
  const exists = (file: string) =>
    access(join(dir, file)).then(
      () => true,
      () => false,
    );
  const research = async (path: string, body?: unknown, method = "POST") => {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: {
        Authorization: "Bearer " + process.env.RESEARCHER_API_TOKEN!,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    assert.ok(r.ok, "research fixture HTTP " + r.status);
    return r.json();
  };
  const make = async () => {
    const run = await research("/research/experiment-runs", {
      name: "TEST ONLY read/end",
      catalogVersionId: version,
      plannedParticipants: 0,
    });
    const p = await research(
      `/research/experiment-runs/${run.id}/participants`,
      { participantLabel: "TEST ONLY read participant" },
    );
    await research(`/research/experiment-runs/${run.id}/start`, {});
    const secret = randomBytes(32).toString("base64url");
    const headers: Record<string, string> = {
      Authorization: "Bearer " + p.issuedCode,
      "Content-Type": "application/json",
      "X-Experiment-Client": secret,
    };
    const c = await fetch(base + "/api/experiment-client/claim", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(c.status, 200);
    const claimed = await c.json();
    headers["X-Experiment-Generation"] = String(claimed.deviceGeneration);
    headers["X-Experiment-Origin-Client"] = claimed.clientId;
    headers["X-Experiment-Origin-Generation"] = String(
      claimed.deviceGeneration,
    );
    headers["X-Client-Stream-Id"] = randomUUID();
    let sequence = 0;
    const call = async (
      path: string,
      body?: unknown,
      method = "POST",
      signal = AbortSignal.timeout(15000),
    ) =>
      fetch(base + "/api" + path, {
        method,
        headers: {
          ...headers,
          "Idempotency-Key": randomUUID(),
          "X-Client-Sequence": String(++sequence),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    const ok = async (path: string, body?: unknown, method = "POST") => {
      const r = await call(path, body, method);
      assert.ok(r.ok, path + " " + r.status);
      return r.json();
    };
    await ok(`/sessions/${p.sessionId}/start`, {});
    const f = await ok(`/sessions/${p.sessionId}/flow`, undefined, "GET");
    const lesson = f.stages.find(
      (s: { stageType: string }) => s.stageType === "LESSON",
    ).id;
    const sb = f.stages.find(
      (s: { stageType: string }) => s.stageType === "PRIOR_MAP",
    ).id;
    await ok(`/session-stages/${lesson}/start`, {});
    await ok(`/sessions/${p.sessionId}/events`, {
      schemaVersion: 1,
      eventType: "VIDEO_COMPLETE",
      targetType: "VIDEO",
      stageId: lesson,
      outcome: "SUCCESS",
      clientTimeQuality: "NOT_APPLICABLE",
    });
    await ok(`/session-stages/${lesson}/complete`, {});
    await ok(`/session-stages/${sb}/start`, {});
    const map = await ok(`/session-stages/${sb}/prior-map`, {});
    return { run: run.id, session: p.sessionId, map: map.id, call };
  };
  const reset = async (map: string) => {
    for (const file of ["entered", "finished", "release"])
      await rm(join(dir, file), { force: true });
    await writeFile(
      join(dir, "gate.json"),
      JSON.stringify({ path: `/api/maps/${map}` }),
    );
  };
  const state = async (run: string) =>
    (await pool.query("SELECT state FROM experiment_runs WHERE id=$1", [run]))
      .rows[0].state;
  const end = (run: string) =>
    research(`/research/experiment-runs/${run}/end`, { confirmed: true });
  await checkMapReadDeadlines(pool, base, make);
  if (process.env.EXPERIMENT_READ_REAL_DEADLINE_CHECK === "1") {
    const p = await make();
    let r = await p.call(`/maps/${p.map}/submit`, {}, "POST");
    assert.ok(r.ok);
    const f = await (
      await p.call(`/sessions/${p.session}/flow`, undefined, "GET")
    ).json();
    const st = f.stages.find(
      (x: { stageType: string }) => x.stageType === "KB_MAP",
    ).id;
    assert.ok((await p.call(`/session-stages/${st}/start`, {}, "POST")).ok);
    const kit = (
      await pool.query(
        "SELECT research_kit_definition_id id FROM sessions WHERE id=$1",
        [p.session],
      )
    ).rows[0].id;
    const kb = await (
      await p.call(`/kits/${kit}/kb-map`, { sessionStageId: st }, "POST")
    ).json();
    await reset(kb.id);
    await writeFile(
      join(dir, "gate.json"),
      JSON.stringify({
        path: `/api/maps/${kb.id}`,
        map: kb.id,
        mode: "slow_sql",
      }),
    );
    const t = performance.now();
    const reading = p
      .call(`/maps/${kb.id}`, undefined, "GET", AbortSignal.timeout(40000))
      .then(
        async (x) => ({ status: x.status, body: await x.json() }),
        () => ({ status: 0, body: null }),
      );
    await wait(
      async () => await exists("sql-started"),
      "actual Map SQL delay entered",
    );
    const ending = fetch(base + `/api/research/experiment-runs/${p.run}/end`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.RESEARCHER_API_TOKEN!,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({ confirmed: true }),
      signal: AbortSignal.timeout(40000),
    });
    r = await ending;
    assert.equal(r.status, 200);
    const result = await reading;
    assert.ok([0, 500].includes(result.status));
    assert.ok(performance.now() - t < 33500);
    const trace = JSON.parse(
      await (
        await import("node:fs/promises")
      ).readFile(join(dir, "sql-trace"), "utf8"),
    );
    assert.equal(trace.started, 4);
    assert.equal(trace.completed, 3);
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='idle in transaction'",
          )
        ).rows[0].n,
      ),
      0,
    );
    console.log(
      JSON.stringify({
        check: "actual-product-read-30s",
        elapsedMs: Math.round(performance.now() - t),
        status: result.status,
        ...trace,
      }),
    );
    await rm(join(dir, "gate.json"), { force: true });
  }

  // Read-first: real Map body has been assembled, HTTP end deliberately held.
  for (const abort of [false, true]) {
    const p = await make();
    await reset(p.map);
    const controller = new AbortController();
    const reading = p
      .call(`/maps/${p.map}`, undefined, "GET", controller.signal)
      .then(async (r) => ({ status: r.status, body: await r.json() }))
      .catch(() => null);
    await wait(() => exists("entered"), "product GET reached held transport");
    let done = false;
    const ending = end(p.run).then((r) => {
      done = true;
      return r;
    });
    await wait(
      async () =>
        Number(
          (
            await pool.query(
              "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT r.* FROM experiment_runs%' ",
            )
          ).rows[0].n,
        ) > 0,
      "end waits behind Map response",
    );
    assert.equal(await state(p.run), "RUNNING");
    assert.equal(done, false);
    if (abort) controller.abort();
    else await writeFile(join(dir, "release"), "send");
    const r = await reading;
    await ending;
    if (abort) {
      assert.equal(r, null);
      assert.equal(await exists("finished"), false);
    } else {
      assert.equal(r?.status, 200);
      assert.equal(r?.body.id, p.map);
      assert.equal(await exists("finished"), true);
    }
    assert.equal(await state(p.run), "ENDED");
    const denied = await p.call(`/maps/${p.map}`, undefined, "GET");
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).error, "experiment_ended");
    const analysis = await research(
      `/research/stage1/sessions/${p.session}/analysis`,
      undefined,
      "GET",
    );
    assert.equal(analysis.integrationStates.submission.reason, "NOT_SUBMITTED");
  }
  // End-first: hold actual run, queue end ahead of GET's access check.
  const p = await make();
  await rm(join(dir, "gate.json"), { force: true });
  const held = await pool.connect();
  try {
    await held.query("BEGIN");
    await held.query("SELECT id FROM experiment_runs WHERE id=$1 FOR UPDATE", [
      p.run,
    ]);
    const ending = end(p.run);
    await wait(
      async () =>
        Number(
          (
            await pool.query(
              "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT r.* FROM experiment_runs%' ",
            )
          ).rows[0].n,
        ) > 0,
      "end queued first",
    );
    const reading = p.call(`/maps/${p.map}`, undefined, "GET");
    await wait(
      async () =>
        Number(
          (
            await pool.query(
              "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF a FOR SHARE OF r,s%' ",
            )
          ).rows[0].n,
        ) > 0,
      "GET access waits after end",
    );
    await held.query("COMMIT");
    await ending;
    const r = await reading;
    assert.equal(r.status, 409);
    const b = await r.json();
    assert.equal(b.error, "experiment_ended");
    assert.equal(b.concepts, undefined);
  } finally {
    await held.query("ROLLBACK").catch(() => undefined);
    held.release();
  }
  console.log(
    "Map read/end: actual API+PostgreSQL, held HTTP send, read-first/end-first/aborted-response, post-end refusal and researcher analysis PASS",
  );
}
