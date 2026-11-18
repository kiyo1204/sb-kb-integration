import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { build, createServer } from "vite";

type Legacy = typeof import("../src/observation-outbox");
type Storage = typeof import("../src/observation-stream-v3");
type PreservationModule =
  typeof import("../src/observation-stream-v3-preservation");
declare global {
  interface Window {
    legacy: Legacy;
    storageV3: Storage;
  }
}

const sessionId = "11111111-1111-4111-8111-111111111111";
const stageId = "22222222-2222-4222-8222-222222222222";
const clientId = "33333333-3333-4333-8333-333333333333";
const newClientId = "44444444-4444-4444-8444-444444444444";
const event = {
  schemaVersion: 1,
  eventType: "VIDEO_PLAY",
  targetType: "VIDEO",
  stageId,
  outcome: "SUCCESS",
  clientTimeQuality: "OBSERVED",
  clientTimestamp: "2026-11-18T08:00:00.000Z",
};
const context = (generation: number, client = clientId) => ({
  sessionId,
  requiresOrigin: true,
  origin: { clientId: client, generation },
});
const tempPrefix = resolve(tmpdir(), "stage1-observation-v3-edge-");
const compiled = await build({
  configFile: false,
  logLevel: "error",
  build: {
    write: false,
    lib: {
      entry: resolve("src/observation-stream-v3-preservation.ts"),
      formats: ["es"],
    },
  },
});
const buildOutput = Array.isArray(compiled) ? compiled[0] : compiled;
assert("output" in buildOutput);
const bundle = buildOutput.output.find(
  (item) => item.type === "chunk" && item.isEntry,
);
assert(bundle && bundle.type === "chunk");
assert.deepEqual(bundle.exports, ["openObservationPreservation"]);
const server = await createServer({
  configFile: false,
  server: { host: "127.0.0.1", port: 0, strictPort: true },
  plugins: [
    {
      name: "isolated-observation-v3-browser",
      configureServer(vite) {
        vite.middlewares.use("/v3-preservation.js", (_req, res) => {
          res.setHeader("content-type", "text/javascript; charset=utf-8");
          res.end(bundle.code);
        });
        vite.middlewares.use("/v3-fixture", (_req, res) => {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(
            "<!doctype html><meta charset=utf-8><title>Observation v3 synthetic data only</title>",
          );
        });
      },
    },
  ],
});
const profile = await mkdtemp(tempPrefix);

let browser: BrowserContext | undefined;
const apiRequests: string[] = [];
async function openBrowser(origin: string) {
  browser = await chromium.launchPersistentContext(profile, {
    channel: process.env.BROWSER_CHANNEL ?? "msedge",
    headless: true,
  });
  await browser.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith("/api/")) {
      apiRequests.push(`${route.request().method()} ${url.pathname}`);
      await route.abort();
    } else await route.continue();
  });
}
async function pageAt(origin: string) {
  const page = await browser!.newPage();
  await page.goto(`${origin}/v3-fixture`);
  await page.evaluate(
    '(async()=>{window.legacy=await import("/src/observation-outbox.ts");window.storageV3=await import("/src/observation-stream-v3.ts")})()',
  );
  return page;
}
const legacySnapshot = (page: Page) =>
  page.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("stage1-observation-outbox");
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => request.transaction!.abort();
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("sessions", "readonly");
          const row = tx.objectStore("sessions").get(id);
          tx.oncomplete = () => {
            resolve({
              version: db.version,
              stores: [...db.objectStoreNames],
              row: row.result,
            });
            db.close();
          };
          tx.onabort = () => {
            reject(tx.error);
            db.close();
          };
        };
      }),
    sessionId,
  );
const preserved = (page: Page) =>
  page.evaluate(async (id) => {
    const reader = await window.storageV3.openObservationStreamV3("preserve");
    try {
      if ("append" in reader)
        throw new Error("preservation must not expose a writer");
      return await reader.readSession(id);
    } finally {
      reader.close();
    }
  }, sessionId);
const write = (
  page: Page,
  capture: ReturnType<typeof context>,
  lowerLimits?: { count?: number; bytes?: number },
) =>
  page.evaluate(
    async ({ capture, event, lowerLimits }) => {
      const writer = await window.storageV3.openObservationStreamV3(
        "capture",
        lowerLimits,
      );
      try {
        return await writer.append(capture, event);
      } finally {
        writer.close();
      }
    },
    { capture, event, lowerLimits },
  );

try {
  await server.listen();
  const origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
  await openBrowser(origin);
  const initial = await pageAt(origin);
  console.log(await initial.evaluate(() => navigator.userAgent));
  await initial.evaluate(
    async ({ sessionId, contextOld, contextCurrent, event }) => {
      await window.legacy.enqueue(sessionId, event, contextOld.origin);
      await window.legacy.enqueue(
        sessionId,
        { ...event, eventType: "VIDEO_PAUSE" },
        contextCurrent.origin,
      );
      await window.legacy.changeState(sessionId, (row) => {
        row.heldHeadId = row.items[0].id;
      });
    },
    { sessionId, contextOld: context(2), contextCurrent: context(8), event },
  );
  const before = await legacySnapshot(initial);
  assert.equal((before as { version: number }).version, 2);
  await initial.close(); // All v2 tabs are closed before any upgrade is attempted.
  const upgradePage = await pageAt(origin);
  await assert.rejects(preserved(upgradePage), /observation_v3_unavailable/);
  assert.deepEqual(await legacySnapshot(upgradePage), before);
  const interrupted = await upgradePage.evaluate(async () => {
    const createIndex = IDBObjectStore.prototype.createIndex;
    let started = false;
    IDBObjectStore.prototype.createIndex = function (name, keyPath, options) {
      const index = createIndex.call(this, name, keyPath, options);
      if (name === "bySessionStream") {
        started = true;
        this.transaction.abort();
      }
      return index;
    };
    try {
      await window.storageV3.openObservationStreamV3("capture");
      return null;
    } catch (error) {
      return {
        started,
        unavailable: String(error).includes("observation_v3_unavailable"),
      };
    } finally {
      IDBObjectStore.prototype.createIndex = createIndex;
    }
  });
  assert.deepEqual(interrupted, { started: true, unavailable: true });
  assert.deepEqual(await legacySnapshot(upgradePage), before);
  await upgradePage.evaluate(async () =>
    (await window.storageV3.openObservationStreamV3("capture")).close(),
  );
  const upgraded = await legacySnapshot(upgradePage);
  assert.deepEqual(upgraded, {
    ...(before as object),
    version: 3,
    stores: ["sessions", "streams"],
  });
  await assert.rejects(
    upgradePage.evaluate((id) => window.legacy.queueStatus(id), sessionId),
    /storage_unavailable/,
  );
  console.log(
    "v2 read remains intact on abort; v3 keeps the exact legacy row and hold marker",
  );

  const tabB = await pageAt(origin);
  const same = await Promise.all([
    write(upgradePage, context(8)),
    write(tabB, context(8)),
  ]);
  assert.equal(same[0].streamId, same[1].streamId);
  assert.deepEqual(
    same.map((row) => row.sequence).sort((a, b) => a - b),
    [1, 2],
  );
  assert.equal(new Set(same.map((row) => row.id)).size, 2);
  const later = await write(tabB, context(9));
  assert.notEqual(later.streamId, same[0].streamId);
  assert.equal(later.sequence, 1);
  const switched = await write(tabB, context(9, newClientId));
  assert.notEqual(switched.streamId, later.streamId);
  assert.equal(switched.sequence, 1);
  const beforeRestart = await preserved(tabB);
  assert.equal(beforeRestart.streams.length, 3);
  assert.equal(beforeRestart.legacy!.acknowledged, 0);
  assert.equal(
    beforeRestart.streams.reduce((n, row) => n + row.items.length, 0),
    4,
  );
  assert.deepEqual(await legacySnapshot(tabB), upgraded);
  await browser!.close();
  browser = undefined;

  await openBrowser(origin);
  const restarted = await pageAt(origin);
  assert.deepEqual(await preserved(restarted), beforeRestart);
  const resumed = await write(restarted, context(8));
  assert.equal(resumed.streamId, same[0].streamId);
  assert.equal(resumed.sequence, 3);
  const lastSnapshot = await preserved(restarted);
  await assert.rejects(
    write(restarted, context(8), { count: 7 }),
    /observation_capacity/,
  );
  const size = (items: unknown[]) =>
    new TextEncoder().encode(JSON.stringify(items)).length;
  const byteLimit =
    size(lastSnapshot.legacy!.items) +
    lastSnapshot.streams.reduce((sum, row) => sum + size(row.items), 0);
  await assert.rejects(
    write(restarted, context(10), { bytes: byteLimit }),
    /observation_capacity/,
  );
  await assert.rejects(
    restarted.evaluate(
      async ({ sessionId, event }) => {
        const writer =
          await window.storageV3.openObservationStreamV3("capture");
        try {
          await writer.append(
            { sessionId, requiresOrigin: true, origin: null },
            event,
          );
        } finally {
          writer.close();
        }
      },
      { sessionId, event },
    ),
    /observation_origin_unconfirmed/,
  );
  await assert.rejects(
    restarted.evaluate(
      async ({ capture, event }) => {
        const writer =
          await window.storageV3.openObservationStreamV3("capture");
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, key) {
          if (this.name === "streams")
            throw new DOMException(
              "synthetic quota failure",
              "QuotaExceededError",
            );
          return put.call(this, value, key);
        };
        try {
          await writer.append(capture, event);
        } finally {
          IDBObjectStore.prototype.put = put;
          writer.close();
        }
      },
      { capture: context(8), event },
    ),
    /QuotaExceededError/,
  );
  assert.deepEqual(await preserved(restarted), lastSnapshot);
  const next = await write(restarted, context(8));
  assert.equal(next.sequence, 4);
  assert.equal(next.streamId, resumed.streamId);
  await restarted.reload();
  const preservationTab = await browser!.newPage();
  await preservationTab.goto(`${origin}/v3-fixture`);
  const final = await preservationTab.evaluate(async (id) => {
    const path = "/v3-preservation.js";
    const recovery: PreservationModule = await import(path);
    const reader = await recovery.openObservationPreservation();
    try {
      if ("append" in reader)
        throw new Error("recovery build exposed a writer");
      return await reader.readSession(id);
    } finally {
      reader.close();
    }
  }, sessionId);
  assert.deepEqual(final.legacy, beforeRestart.legacy);
  assert.equal(
    final.streams.reduce((n, row) => n + row.items.length, 0),
    6,
  );
  assert.deepEqual(
    final.streams.find((row) => row.streamId === next.streamId)!.items.at(-1),
    {
      id: next.id,
      sequence: 4,
      event,
      created: final.streams
        .find((row) => row.streamId === next.streamId)!
        .items.at(-1)!.created,
    },
  );
  assert.deepEqual(apiRequests, []);
  console.log(
    "two-tab FIFO numbering, generation/screen switch, restart, aggregate limits, quota failure, and preservation passed; API requests 0",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
    if (
      resolve(profile).startsWith(tempPrefix) &&
      resolve(profile) !== tempPrefix
    )
      await rm(profile, { recursive: true, force: true });
  }
}
