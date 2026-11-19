// TEST ONLY: use the mock runner's browser fixture in a fresh browser context.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const input = process.env.OBSERVATION_RECEIPT_FIXTURE;
assert(input, "requires the guarded mock test");
const fixture = JSON.parse(input);
const target = new URL(process.env.API_BASE_URL!);
assert(target.protocol === "http:" && target.hostname === "127.0.0.1");
const harness = String.raw`
import { requestDigest } from "/src/client-identity.ts";
import { changeState, allowedObservation } from "/src/observation-outbox.ts";
import { openObservationStreamV3 } from "/src/observation-stream-v3.ts";

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}

function hash(event, stream, order) {
  if (!allowedObservation(event)) return null;
  return requestDigest(canonical({event: JSON.parse(JSON.stringify(event)), stream, order}));
}

async function snapshot() {
  const database = await new Promise((resolve, reject) => {
    const open = indexedDB.open("stage1-observation-outbox");
    open.onupgradeneeded = () => { open.transaction.abort(); reject(Error("unexpected_create")); };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    const stores = [...database.objectStoreNames];
    const transaction = database.transaction(stores, "readonly");
    return await Promise.all(stores.map(store => new Promise((resolve, reject) => {
      const read = transaction.objectStore(store).getAll();
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    })));
  } finally { database.close(); }
}

export async function exercise({current, first, second, changed, vectors}) {
  const { sessionId, code, secret, generation } = current;
  const order = Number(first.item.clientSequence);
  // The old receipt was saved with a lost response. Preserve the sender's queue
  // representation, including the old origin and its hold mark.
  await changeState(sessionId, row => {
    row.clientId = first.item.clientStreamId;
    row.next = order + 1;
    row.heldHeadId = first.item.eventKey;
    row.items = [{
      id: first.item.eventKey, order, event: first.event, attempts: 1,
      created: Date.now(), last: "UNKNOWN",
      experimentOrigin: { clientId: first.headers["X-Experiment-Origin-Client"],
        generation: Number(first.headers["X-Experiment-Origin-Generation"]) },
    }];
  });
  const before = await snapshot();
  const [row] = before[0];
  const [oldItem] = row.items;
  const oldHash = hash(oldItem.event, row.clientId, String(oldItem.order));
  const secondHash = hash(second.event, second.item.clientStreamId, second.item.clientSequence);
  const changedHash = hash({...first.event,details:{...first.event.details,toSeconds:2}},
    row.clientId, String(oldItem.order));
  const request = async () => {
    const response = await fetch("/api/sessions/" + sessionId + "/observation-receipts/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + code,
        "X-Experiment-Client": secret, "X-Experiment-Generation": String(generation) },
      body: JSON.stringify({contractVersion:1,items:[
        {...first.item,requestHash:oldHash},
        {...second.item,requestHash:secondHash},
      ]}),
    });
    return { status: response.status, body: await response.json() };
  };
  const v2 = await request(), after = await snapshot();
  const v3 = await openObservationStreamV3("capture");
  try {
    await v3.append({sessionId, requiresOrigin:true, origin:{clientId:current.clientId,generation}}, second.event);
    const beforeV3 = await snapshot();
    const v3Response = await request();
    const afterV3 = await snapshot();
    return { v2, v3Response, unchangedV2:JSON.stringify(before) === JSON.stringify(after),
      unchangedV3:JSON.stringify(beforeV3) === JSON.stringify(afterV3),
      v3Stores:beforeV3.length, hashCount:vectors.length + 3,
      compatibleVectors:vectors.every(v => hash(v.event,v.stream,v.order) === v.expected),
      unsupported:hash({text:"日本語"},row.clientId,"1") === null,
      hashesMatch:oldHash === first.item.requestHash && secondHash === second.item.requestHash
        && changedHash === changed.requestHash && changedHash !== oldHash,
    };
  } finally { v3.close(); }
}
`;
const web = process.env.MOCK_RECEIPT_WEB_BASE;
if (web) assert(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(web));
const pageHtml = "<!doctype html><title>Synthetic receipt lookup</title>";
const server = web
  ? null
  : await createServer({
      configFile: false,
      cacheDir: "../.local/observation-receipt-vite",
      server: {
        host: "127.0.0.1",
        port: 0,
        proxy: { "/api": { target: target.origin, changeOrigin: true } },
      },
      plugins: [
        {
          name: "synthetic-observation-receipt-lookup",
          resolveId(id) {
            if (id === "/__receipt_harness.js") return "\0receipt-harness";
          },
          load(id) {
            if (id === "\0receipt-harness") return harness;
          },
          configureServer(vite) {
            vite.middlewares.use("/__receipt_fixture", (_req, res) => {
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(pageHtml);
            });
          },
        },
      ],
    });
try {
  await server?.listen();
  const browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL ?? "msedge",
  });
  try {
    const page = await browser.newPage();
    const requests: string[] = [];
    page.on("request", (req) => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith("/api/")) requests.push(path);
    });
    if (web) {
      await page.route(web + "/__receipt_fixture", (route) =>
        route.fulfill({ contentType: "text/html", body: pageHtml }),
      );
      await page.route(web + "/__receipt_harness.js", (route) =>
        route.fulfill({ contentType: "text/javascript", body: harness }),
      );
    }
    await page.goto(
      (web ? web + "/" : server!.resolvedUrls!.local[0]) + "__receipt_fixture",
    );
    const result = await page.evaluate(async (data) => {
      const { exercise } = await import("/__receipt_harness.js");
      return exercise(data);
    }, fixture);
    assert.deepEqual(result.v2, {
      status: 200,
      body: {
        contractVersion: 1,
        results: [{ status: "MATCHED" }, { status: "MATCHED" }],
      },
    });
    assert.deepEqual(result.v3Response, result.v2);
    assert.equal(result.v3Stores, 2);
    assert.ok(
      result.unchangedV2 && result.unchangedV3,
      "the complete browser rows remain unchanged",
    );
    assert.ok(
      result.hashesMatch && result.compatibleVectors && result.unsupported,
      "browser and Node observation hashes",
    );
    assert.deepEqual(
      requests,
      Array(2).fill(
        "/api/sessions/" +
          fixture.current.sessionId +
          "/observation-receipts/query",
      ),
    );
    console.log(
      "PASS isolated browser: " +
        result.hashCount +
        " observation hashes matched; v2/v3 queues and ACK unchanged; two read-only requests",
    );
    process.send?.({ verified: true });
  } finally {
    await browser.close();
  }
} finally {
  await server?.close();
}
