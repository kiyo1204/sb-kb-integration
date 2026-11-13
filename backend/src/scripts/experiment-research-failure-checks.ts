// Route failure unit check. This pool never opens a database connection.
import assert from "node:assert/strict";
import express from "express";
import type { Pool } from "pg";
import { registerStage1AnalysisRoutes } from "../stage1-analysis.js";
import { registerExperimentResearchRoutes } from "../experiment-research.js";
export async function checkResearchConnectionFailure() {
  const app = express();
  app.use((_q, r, next) => {
    r.locals.principal = { role: "researcher" };
    next();
  });
  const marker = "TEST ONLY private connection failure";
  const fakePool = {
    connect: async () => {
      throw new Error(marker);
    },
  } as unknown as Pool;
  registerStage1AnalysisRoutes(app, fakePool);
  registerExperimentResearchRoutes(app, fakePool);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const original = console.error,
    logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  try {
    const id = "11111111-1111-4111-8111-111111111111";
    for (const [path, status, code] of [
      [
        `/api/research/stage1/sessions/${id}/maps/${id}/history?sequenceNumber=0`,
        500,
        "stage1_map_history_failed",
      ],
      [
        `/api/research/experiment-runs/${id}/research.csv`,
        503,
        "research_unavailable",
      ],
    ] as const) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}` + path);
      assert.equal(response.status, status);
      assert.ok(
        response.headers.get("content-type")?.includes("application/json"),
      );
      assert.equal(response.headers.get("content-disposition"), null);
      const body = await response.text();
      assert.ok(!body.includes(marker));
      assert.equal(JSON.parse(body).error, code);
    }
    assert.ok(!logs.join(" ").includes(marker));
  } finally {
    console.error = original;
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
}
