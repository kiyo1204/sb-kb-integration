// TEST ONLY: short leases exercise the actual helper with real PostgreSQL,
// product authentication and end route. Real 30s product GET is opt-in once.
import assert from "node:assert/strict";
import express from "express";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { accessControl } from "../access-control.js";
import { registerExperimentEndRoutes } from "../experiment-end.js";
import { withExperimentMapRead } from "../experiment-map-read.js";
import { verifyMockTestUrl } from "./mock-db.js";
type Fixture = {
  run: string;
  session: string;
  map: string;
  call: (
    path: string,
    body?: unknown,
    method?: string,
    signal?: AbortSignal,
  ) => Promise<Response>;
};
export async function checkMapReadDeadlines(
  pool: Pool,
  base: string,
  make: () => Promise<Fixture>,
) {
  await verifyMockTestUrl(process.env.DATABASE_URL!);
  const data = new Pool({
    ...pool.options,
    application_name: "sbkb-read-deadline-" + randomUUID(),
    max: 1,
    connectionTimeoutMillis: 0,
  });
  const app = express();
  app.use(express.json());
  app.use("/api", accessControl(pool));
  let mode = "sum",
    pid = 0,
    started = 0,
    completed = 0;
  app.get("/api/maps/:mapId", async (req, res) => {
    try {
      await withExperimentMapRead(
        data,
        req,
        res,
        async (db) => {
          pid = Number(
            (await db.query("SELECT pg_backend_pid() pid")).rows[0].pid,
          );
          for (let i = 0; i < (mode === "pool" ? 0 : 4); i++) {
            started++;
            await db.query(
              mode === "failure"
                ? "SELECT test_only_read_failure"
                : "SELECT pg_sleep($1)",
              [...(mode === "failure" ? [] : [0.6])],
            );
            completed++;
          }
          const map = (
            await db.query("SELECT id FROM maps WHERE id=$1", [
              req.params.mapId,
            ])
          ).rows[0];
          res.json(map);
        },
        { timeoutMs: 1500, statementMs: 1000 },
      );
    } catch {
      if (!res.destroyed && !res.headersSent)
        res.status(500).json({ error: "map_fetch_failed" });
    }
  });
  registerExperimentEndRoutes(app, pool);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const short = "http://127.0.0.1:" + address.port;
  const wait = async (test: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await test()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail("short deadline condition");
  };
  try {
    for (const kind of ["sum", "disconnect", "failure", "pool"]) {
      const p = await make();
      mode = kind;
      pid = started = completed = 0;
      const held = kind === "pool" ? await data.connect() : undefined;
      // A different legitimate transaction must not be mistaken for a leaked
      // reader. Reproduces the old database-wide assertion's false positive.
      const unrelated = kind === "pool" ? await pool.connect() : undefined;
      if (unrelated) await unrelated.query("BEGIN; SELECT 1");
      const t = performance.now();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((input, init) =>
        originalFetch(
          String(input).startsWith(base + "/api/maps/")
            ? String(input).replace(base, short)
            : input,
          init,
        )) as typeof fetch;
      const c = new AbortController();
      let result: Promise<number>;
      let heldReleased = false;
      try {
        result = p.call(`/maps/${p.map}`, undefined, "GET", c.signal).then(
          async (r) => {
            const b = await r.json();
            assert.equal(b.id, undefined);
            return r.status;
          },
          () => 0,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
      try {
        if (kind === "disconnect") {
          await wait(
            async () =>
              pid > 0 &&
              Number(
                (
                  await pool.query(
                    "SELECT count(*) n FROM pg_stat_activity WHERE pid=$1 AND state='active' AND query LIKE 'SELECT pg_sleep%'",
                    [pid],
                  )
                ).rows[0].n,
              ) > 0,
          );
          c.abort();
        }
        const status = await result;
        assert.ok(status === 0 || status === 500);
        const elapsed = Math.round(performance.now() - t);
        assert.ok(elapsed < 3500, kind + " bounded completion");
        if (kind === "sum") {
          assert.equal(started, 3);
          assert.equal(completed, 2);
        }
        if (kind === "disconnect") {
          assert.equal(started, 1);
          assert.equal(completed, 0);
        }
        if (kind === "pool") {
          held!.release();
          heldReleased = true;
          await wait(
            async () => data.waitingCount === 0 && data.idleCount === 1,
          );
        }
        const end = await originalFetch(
          base + `/api/research/experiment-runs/${p.run}/end`,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + process.env.RESEARCHER_API_TOKEN!,
              "Content-Type": "application/json",
              "Idempotency-Key": randomUUID(),
            },
            body: '{"confirmed":true}',
            signal: AbortSignal.timeout(4000),
          },
        );
        assert.equal(end.status, 200);
        assert.equal(
          (await data.query("SELECT 1 AS healthy")).rows[0].healthy,
          1,
        );
        if (kind === "disconnect")
          assert.equal(
            Number(
              (
                await pool.query(
                  "SELECT count(*) n FROM pg_stat_activity WHERE pid=$1",
                  [pid],
                )
              ).rows[0].n,
            ),
            0,
          );
        assert.equal(
          Number(
            (
              await pool.query(
                "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND state='idle in transaction'",
                [data.options.application_name],
              )
            ).rows[0].n,
          ),
          0,
        );
        if (unrelated)
          assert.ok(
            Number(
              (
                await pool.query(
                  "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND application_name<>$1",
                  [data.options.application_name],
                )
              ).rows[0].n,
            ) >= 1,
            "unrelated transaction is independently visible",
          );
        assert.equal(
          (await p.call(`/maps/${p.map}`, undefined, "GET")).status,
          409,
        );
        console.log(
          JSON.stringify({
            check: "short-map-read-lease",
            kind,
            elapsedMs: elapsed,
            started,
            completed,
            status,
          }),
        );
      } finally {
        if (held && !heldReleased) held.release();
        if (unrelated) {
          await unrelated.query("ROLLBACK");
          unrelated.release();
        }
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await data.end();
  }
}
