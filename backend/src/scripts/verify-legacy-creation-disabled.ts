// Regression gate: the historical creation API is never exposed in normal operation.
// All subprocesses use a verified disposable synthetic PostgreSQL database.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { verifyMockTestUrl } from "./mock-db.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
await verifyMockTestUrl(databaseUrl);

async function verifyDisabled(label: string, nodeEnv: string, mockFlag: string) {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));

  const child = spawn(process.execPath, ["dist/index.js"], {
    env: {
      ...process.env,
      NODE_ENV: nodeEnv,
      STAGE1_MOCK_DATA: mockFlag,
      PORT: String(port),
    },
    stdio: "ignore",
    windowsHide: true,
  });
  const base = "http://127.0.0.1:" + port;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) break;
      try {
        if ((await fetch(base + "/api/health")).ok) {
          ready = true;
          break;
        }
      } catch {
        // The disposable test server has not started yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, label + ": synthetic API did not start");

    const auth = { Authorization: "Bearer " + process.env.RESEARCHER_API_TOKEN! };
    const me = await fetch(base + "/api/me", { headers: auth });
    assert.equal(me.status, 200, label + ": researcher authentication");
    assert.equal((await me.json()).role, "researcher", label);

    for (const [path, method, body] of [
      ["/api/research/stage1/settings", "GET", null],
      ["/api/research/stage1/settings", "PUT", { minutes: 1 }],
      ["/api/research/stage1/sessions", "POST", {}],
    ] as const) {
      const response = await fetch(base + path, {
        method,
        headers: { ...auth, "Content-Type": "application/json" },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, 404, label + ": retired " + method + " " + path);
    }
  } finally {
    if (child.exitCode === null) {
      const stopped = once(child, "exit");
      child.kill();
      await stopped;
    }
  }
}

await verifyDisabled("normal development", "development", "");
await verifyDisabled("production with stale mock flag", "production", "ONLY_SYNTHETIC");
console.log("Legacy Session creation routes: absent outside verified synthetic development mode: PASS");
