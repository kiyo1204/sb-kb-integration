import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { once } from "node:events";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { verifyMockTestUrl, verificationReportPath } from "./mock-db.js";
process.env.RESEARCH_VERIFICATION_OUTPUT = verificationReportPath("invariants");
const selected=(process.env.RESEARCH_SUITE_ONLY??"").split(",").filter(Boolean);
const url = process.env.DATABASE_URL!;
await verifyMockTestUrl(url);
const results: { test: string; exitCode: number | null; elapsedMs: number }[] =
  [];
let api: ChildProcess | undefined;
async function stop() {
  if (api && api.exitCode === null) {
    const done = once(api, "exit");
    api.kill();
    await done;
  }
  api = undefined;
}
async function start() {
  const listener = createServer();
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  const addr = listener.address();
  assert.ok(addr && typeof addr !== "string");
  const port = addr.port;
  await new Promise<void>((r) => listener.close(() => r()));
  process.env.API_BASE_URL = "http://127.0.0.1:" + port;
  api = spawn(process.execPath, ["dist/index.js"], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
    windowsHide: true,
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(process.env.API_BASE_URL + "/api/health")).ok) return;
    } catch {
      /*wait*/
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("isolated_api_not_ready");
}
async function run(test: string, frontend = false) {
  if(selected.length&&!selected.includes(test))return;
  const started = Date.now();
  const cli = process.env.npm_execpath;
  assert.ok(cli);
  const child = spawn(process.execPath, [cli, "run", test], {
    cwd: frontend ? resolve("../frontend") : process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  const [code] = await once(child, "exit");
  results.push({ test, exitCode: code, elapsedMs: Date.now() - started });
  await writeFile(
    verificationReportPath("suite-results"),
    JSON.stringify(results, null, 2) + "\n",
  );
  assert.equal(code, 0, test);
}
try {
  for (const test of [
    "test:test-target-guards",
    "test:event-catalog",
    "test:research-event-schema",
    "test:undo-redo:unit",
    "test:map-mixed-history",
    "test:research-events",
    "test:event-export-samples",
    "test:event-export",
    "test:data-management",
  ])
    await run(test);
  await start();
  for (const test of [
    "test:stage1:integration",
    "test:map-api-v2",
    "test:map-failure-retry",
    "test:parent-followup",
    "test:map-auto-submit-v2",
    "test:learning-activity-events",
    "test:assessment-events",
    "test:server-audit",
    "test:audit-routing",
    "test:integrated-streams",
    "test:integration-invariants",
    "test:safe-server-error",
  ])
    await run(test);
  // Recovery tests own and restart their server; no background API may auto-submit the fixture.
  await stop();
  await run("test:server-recovery");
  await run("test:delivery-reliability");
  await run("test:event-scale");
  if (process.env.RESEARCH_BROWSER_CHECKS === "1") {
    await start();
    await run("test:research-log-ui", true);
    await run("test:link-position-browser", true);
    await run("test:delivery-browser", true);
    await run("test:event-export-browser", true);
    await run("test:data-management-browser", true);
    await stop();
  }
  assert.ok(selected.every(name=>results.some(r=>r.test===name)),"unknown selected verification");
  console.log("Isolated research event suite: PASS");
} finally {
  await stop();
  await mkdir("../docs", { recursive: true });
  await writeFile(
    verificationReportPath("suite-results"),
    JSON.stringify(results, null, 2) + "\n",
  );
}
