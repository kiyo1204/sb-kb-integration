// Isolated synthetic HTTP/DOM faults. This does not test product persistence.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { verifySbPositionSave } from "./sb-position-diagnostic.js";

const server = createServer((req, res) => {
  if (req.method === "PATCH") {
    res.writeHead(200).end();
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<button data-concept-id="target">SENTINEL_PRIVATE_LABEL</button><button id="other">other</button>',
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.addInitScript("globalThis.__name = (fn) => fn;");
  await page.goto(`http://127.0.0.1:${port}`);
  const node = page.locator("[data-concept-id]");
  const records: Record<string, unknown>[] = [];
  const send = () =>
    page.evaluate(() =>
      fetch("/api/concepts/target/position", {
        method: "PATCH",
        headers: { Authorization: "Bearer SENTINEL_TOKEN" },
        body: "SENTINEL_BODY",
      })
        .then(() => undefined)
        .catch(() => undefined),
    );
  const options = {
    timeout: 200,
    emit: (record: Record<string, unknown>) => {
      records.push(record);
    },
  };
  await verifySbPositionSave(
    page,
    node,
    async () => {
      await node.click();
      await send();
    },
    options,
  );
  assert.equal(records.length, 0, "normal success is silent");
  await assert.rejects(
    verifySbPositionSave(
      page,
      node,
      async () => {
        await page.locator("#other").click();
        await page.evaluate(() =>
          fetch("/api/concepts/unrelated/position", { method: "PATCH" }).then(
            () => undefined,
          ),
        );
      },
      options,
    ),
    /Timeout/,
  );
  assert.equal(records.at(-1)!.pointerReached, false);
  assert.equal(records.at(-1)!.requests, 0, "unrelated requests excluded");
  await page.route("**/api/concepts/target/position", (route) => route.abort());
  await assert.rejects(
    verifySbPositionSave(
      page,
      node,
      async () => {
        await node.click();
        await send();
      },
      options,
    ),
    /Timeout/,
  );
  assert.equal(records.at(-1)!.pointerReached, true);
  assert.equal(records.at(-1)!.requests, 1);
  assert.equal(records.at(-1)!.requestFailures, 1);
  assert.equal(records.at(-1)!.responses, 0);
  await page.unrouteAll();
  await page.route("**/api/concepts/target/position", (route) =>
    route.fulfill({ status: 503, body: "SENTINEL_RESPONSE" }),
  );
  await assert.rejects(
    verifySbPositionSave(
      page,
      node,
      async () => {
        await node.click();
        await send();
      },
      options,
    ),
    { code: "ERR_ASSERTION" },
  );
  assert.deepEqual(records.at(-1)!.statuses, [503]);
  const original = new Error("original action failure");
  let observed: unknown;
  try {
    await verifySbPositionSave(
      page,
      node,
      async () => {
        throw original;
      },
      {
        timeout: 200,
        readPointer: async () => {
          throw new Error("diagnostic read failed");
        },
        emit: () => {
          throw new Error("diagnostic output failed");
        },
      },
    );
  } catch (error) {
    observed = error;
  }
  assert.equal(
    observed,
    original,
    "diagnostic errors preserve original exception identity",
  );
  const serialized = JSON.stringify(records);
  for (const forbidden of [
    "SENTINEL",
    "Authorization",
    "Bearer",
    "/api/",
    "target",
    "127.0.0.1",
  ])
    assert.ok(!serialized.includes(forbidden));
  assert.equal(await page.evaluate(() => "sbPositionDiagnostic" in window), false);
  console.log(
    "PASS SB diagnostics: silent success, missed pointer/no target request, failed request, HTTP 503, original exception retained, minimal output, pointer observer removed",
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
