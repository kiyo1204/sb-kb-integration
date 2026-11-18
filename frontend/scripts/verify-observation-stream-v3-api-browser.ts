// Invoked by the guarded mock DB runner. Browser data and credentials are synthetic.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createServer } from "vite";

type Screen = {
  sessionId: string;
  code: string;
  secret: string;
  clientId: string;
  generation: number;
};
type Modules = {
  auth: typeof import("../src/auth-client");
  legacy: typeof import("../src/observation-outbox");
  storage: typeof import("../src/observation-stream-v3");
  status: typeof import("../src/ObservationStreamV3Status");
  react: typeof import("react");
  dom: typeof import("react-dom/client");
};
declare global {
  interface Window {
    preview: Modules;
    delivery: Awaited<
      ReturnType<Modules["storage"]["openObservationStreamV3"]>
    >;
  }
}
const fixture: {
  old: Screen;
  runId: string;
  legacyStreamId: string;
  event: Record<string, unknown>;
  leaseCases?: boolean;
} = JSON.parse(process.env.OBSERVATION_V3_FIXTURE ?? "null");
const api = new URL(process.env.API_BASE_URL ?? "");
const researcher = process.env.RESEARCHER_API_TOKEN;
assert.equal(api.hostname, "127.0.0.1");
assert.equal(api.protocol, "http:");
assert(
  fixture &&
    researcher?.startsWith("mock-only-") &&
    process.env.STAGE1_MOCK_DATA === "ONLY_SYNTHETIC",
);
const { old, event, runId, legacyStreamId } = fixture;
const { sessionId } = old;
const endpoint = `/api/sessions/${sessionId}/events`;
const server = await createServer({
  configFile: false,
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime"] },
  server: { host: "127.0.0.1", port: 0, strictPort: true },
  plugins: [
    {
      name: "synthetic-v3-real-api-harness",
      resolveId(id) {
        if (id === "/__v3_react") return "\0v3-react";
      },
      load(id) {
        if (id === "\0v3-react")
          return 'import * as react from "react"; import * as dom from "react-dom/client"; export { react, dom };';
      },
      configureServer(vite) {
        vite.middlewares.use("/v3-api-fixture", (_req, res) => {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(
            "<!doctype html><meta charset=utf-8><title>v3 synthetic API verification only</title><div id=delivery></div>",
          );
        });
      },
    },
  ],
});
const profilePrefix = resolve(tmpdir(), "stage1-v3-api-edge-");
const profile = await mkdtemp(profilePrefix);
let browser: BrowserContext | undefined;
type Sent = {
  key: string;
  stream: string;
  order: string;
  body: unknown;
  bodyText: string;
  status: number;
  payload: {
    error?: string;
    eventId?: string;
    sequenceNumber?: string;
    logSaved?: boolean;
  };
};
const requests: Sent[] = [];
let behavior: "normal" | "drop" | "offline" = "normal";
type ResponseGate = {
  arrive(): void;
  decision: Promise<"deliver" | "abandon">;
  release(value: "deliver" | "abandon"): void;
};
let nextGate: ResponseGate | undefined;
let previousGate: ResponseGate | undefined;
const gates = new Set<ResponseGate>();
const routeFailures: string[] = [];

async function openBrowser(origin: string) {
  browser = await chromium.launchPersistentContext(profile, {
    channel: process.env.BROWSER_CHANNEL ?? "msedge",
    headless: true,
  });
  await browser.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      await route.abort();
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (url.pathname !== endpoint || request.method() !== "POST") {
      routeFailures.push("unexpected API request");
      await route.abort();
      return;
    }
    const used = behavior;
    const gate = nextGate;
    nextGate = undefined;
    const supplied = request.headers();
    const headers = Object.fromEntries(
      Object.entries(supplied).filter(
        ([name]) =>
          name === "authorization" ||
          name === "content-type" ||
          name === "idempotency-key" ||
          name.startsWith("x-client-") ||
          name.startsWith("x-experiment-"),
      ),
    );
    const row: Sent = {
      key: headers["idempotency-key"],
      stream: headers["x-client-stream-id"],
      order: headers["x-client-sequence"],
      body: request.postDataJSON(),
      bodyText: request.postData()!,
      status: 0,
      payload: {},
    };
    requests.push(row);
    try {
      if (used === "offline") {
        await route.abort("internetdisconnected");
        return;
      }
      const response = await fetch(new URL(endpoint, api), {
        method: "POST",
        headers,
        body: row.bodyText,
        signal: AbortSignal.timeout(5000),
      });
      row.status = response.status;
      row.payload = await response.json();
      if (used === "drop") {
        behavior = "normal";
        await route.abort("connectionreset");
        return;
      }
      if (gate) {
        gate.arrive();
        if ((await gate.decision) === "abandon") return;
      }
      await route.fulfill({ status: row.status, json: row.payload });
    } catch {
      routeFailures.push("API forwarding failed");
      await route.abort().catch(() => undefined);
    }
  });
}

function queueResponseGate() {
  assert(!nextGate);
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("expected real API response did not reach hold")),
      8000,
    );
    arrive = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
  let release!: ResponseGate["release"];
  const decision = new Promise<"deliver" | "abandon">((resolve) => {
    release = resolve;
  });
  const gate = { arrive, decision, release };
  nextGate = gate;
  gates.add(gate);
  return { arrived, gate };
}
function holdResponse() {
  const fixture = queueResponseGate();
  previousGate = fixture.gate;
  return fixture.arrived;
}
function releaseResponse() {
  previousGate?.release("deliver");
  previousGate = undefined;
}

async function openPage(origin: string) {
  const page = await browser!.newPage();
  await page.addInitScript("globalThis.__name = fn => fn");
  await page.goto(`${origin}/v3-api-fixture`);
  await page.evaluate(
    `(async()=>{const r=await import('/__v3_react');window.preview={...r,auth:await import('/src/auth-client.ts'),legacy:await import('/src/observation-outbox.ts'),storage:await import('/src/observation-stream-v3.ts'),status:await import('/src/ObservationStreamV3Status.tsx')}})()`,
  );
  return page;
}
async function authorize(page: Page, context: Screen) {
  await page.evaluate((screen) => {
    const { auth } = window.preview;
    auth.setAccessToken(screen.code);
    const owner = auth.registerExperimentClientOwner(screen.sessionId);
    auth.bindExperimentClient(
      {
        secret: screen.secret,
        generation: screen.generation,
        clientId: screen.clientId,
      },
      owner,
    );
  }, context);
}
async function openDelivery(page: Page) {
  await page.evaluate(async (id) => {
    const { storage, status, react, dom } = window.preview;
    const reader = await storage.openObservationStreamV3("delivery");
    window.delivery = reader;
    dom.createRoot(document.getElementById("delivery")!).render(
      react.createElement(status.ObservationStreamV3Status, {
        sessionId: id,
        reader,
        operationLogFailed: true,
      }),
    );
  }, sessionId);
}
const append = (page: Page) =>
  page.evaluate(
    ({ sessionId, event }) =>
      window.delivery.append(
        window.preview.auth.captureObservationContext(sessionId, true),
        event,
      ),
    { sessionId, event },
  );
const flush = (page: Page) =>
  page.evaluate(
    (sessionId) =>
      window.delivery.flush(
        window.preview.auth.captureObservationContext(sessionId, true),
      ),
    sessionId,
  );
const snapshot = (page: Page) =>
  page.evaluate(
    (sessionId) => window.delivery.readSession(sessionId),
    sessionId,
  );
const statusText = (page: Page, text: string) =>
  page
    .getByRole("status")
    .getByText(text, { exact: false })
    .waitFor({ timeout: 8000 });

async function switchScreen(prior: Screen): Promise<Screen> {
  const secret = randomBytes(32).toString("base64url");
  const claim = await fetch(new URL("/api/experiment-client/claim", api), {
    method: "POST",
    body: "{}",
    headers: {
      Authorization: `Bearer ${old.code}`,
      "Content-Type": "application/json",
      "X-Experiment-Client": secret,
    },
  });
  assert.equal(claim.status, 409);
  const pending = await claim.json();
  const switched = await researcherPost(
    `/api/research/experiment-runs/${runId}/participants/${sessionId}/client-switch`,
    { clientId: pending.clientId, expectedDeviceGeneration: prior.generation },
  );
  return {
    ...prior,
    secret,
    clientId: pending.clientId,
    generation: switched.deviceGeneration,
  };
}
async function researcherPost(path: string, body: unknown) {
  const result = await fetch(new URL(path, api), {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${researcher}`,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
  });
  assert.ok(result.ok, `${path} HTTP ${result.status}`);
  return result.json();
}

type LegacySeed = NonNullable<Awaited<ReturnType<typeof snapshot>>["legacy"]>;

async function verifyLeaseTakeovers(
  origin: string,
  primary: Page,
  a: Screen,
  legacySeed: LegacySeed,
) {
  const tab = async (screen: Screen) => {
    const page = await openPage(origin);
    await authorize(page, screen);
    await openDelivery(page);
    return page;
  };
  const stream = async (page: Page, id: string) => {
    const row = (await snapshot(page)).streams.find(
      (item) => item.streamId === id,
    );
    assert(row);
    return row;
  };
  const setTime = (page: Page, now: number) =>
    page.evaluate((time) => {
      Date.now = () => time;
    }, now);
  const beforeNetwork = async (page: Page) => {
    await page.evaluate((path) => {
      const send = window.fetch;
      window.fetch = (input, init) => {
        if (String(input) !== path || init?.method !== "POST")
          return send(input, init);
        document.documentElement.dataset.preSendGate = "reached";
        return new Promise<Response>(() => undefined);
      };
    }, endpoint);
    const ended = stoppedFlush(page);
    await page.waitForFunction(
      () => document.documentElement.dataset.preSendGate === "reached",
      undefined,
      { timeout: 8_000 },
    );
    return { ended };
  };
  const stoppedFlush = (page: Page) =>
    flush(page).then(
      () => "resolved",
      (error: unknown) => String(error),
    );
  const killTab = async (page: Page, done: Promise<string>) => {
    await page.close({ runBeforeUnload: false });
    assert.match(await done, /Target page, context or browser has been closed/);
  };
  const expectRequests = (from: number, expected: [string, number][]) =>
    assert.deepEqual(
      requests.slice(from).map((r) => [r.key, r.status]),
      expected,
    );

  // Claim is committed, but the fetch has not produced a browser network request.
  const standby = await tab(a);
  const first = await append(primary),
    second = await append(primary);
  assert.deepEqual([first.sequence, second.sequence], [1, 2]);
  const { ended: deadBeforeSend } = await beforeNetwork(primary);
  const firstLease = await stream(standby, first.streamId);
  assert(firstLease.delivery?.lease);
  assert.equal(firstLease.delivery.acknowledged, 0);
  expectRequests(0, []);
  await killTab(primary, deadBeforeSend);
  assert.deepEqual(await stream(standby, first.streamId), firstLease);
  await setTime(standby, firstLease.delivery.lease.expiresAt - 1);
  await flush(standby);
  expectRequests(0, []);
  await setTime(standby, firstLease.delivery.lease.expiresAt + 1);
  await flush(standby);
  expectRequests(0, [
    [first.id, 201],
    [second.id, 201],
  ]);
  await statusText(standby, "未確認 0件、受付確認済み 2件");
  console.log(
    "PASS lease: source closed before transport; exact first head recovered after expiry",
  );

  // The product API committed before the browser target closed without storing an ACK.
  const newcomer = await tab(a);
  const third = await append(standby),
    fourth = await append(standby);
  const afterCommit = queueResponseGate();
  const deadAfterCommit = stoppedFlush(standby);
  await afterCommit.arrived;
  expectRequests(2, [[third.id, 201]]);
  const thirdLease = await stream(newcomer, third.streamId);
  assert(thirdLease.delivery?.lease);
  assert.equal(thirdLease.delivery.acknowledged, 2);
  assert.deepEqual(
    thirdLease.items.map((item) => item.id),
    [third.id, fourth.id],
  );
  await killTab(standby, deadAfterCommit);
  afterCommit.gate.release("abandon");
  assert.deepEqual(await stream(newcomer, third.streamId), thirdLease);
  await setTime(newcomer, thirdLease.delivery.lease.expiresAt + 1);
  await flush(newcomer);
  expectRequests(2, [
    [third.id, 201],
    [third.id, 201],
    [fourth.id, 201],
  ]);
  assert.deepEqual(requests[3], requests[2]);
  await statusText(newcomer, "未確認 0件、受付確認済み 4件");
  console.log(
    "PASS lease: source closed after database commit; exact replay returns the same receipt",
  );

  // Keep both API responses; the old fence reaches the browser first after takeover.
  const contender = await tab(a);
  const fifth = await append(newcomer),
    sixth = await append(newcomer);
  const oldGate = queueResponseGate();
  const oldFlush = flush(newcomer);
  await oldGate.arrived;
  const expired = await stream(contender, fifth.streamId);
  assert(expired.delivery?.lease);
  await setTime(contender, expired.delivery.lease.expiresAt + 1);
  const newGate = queueResponseGate();
  const newFlush = flush(contender);
  await newGate.arrived;
  expectRequests(5, [
    [fifth.id, 201],
    [fifth.id, 201],
  ]);
  assert.deepEqual(requests[6], requests[5]);
  const taken = await stream(contender, fifth.streamId);
  assert.equal(taken.delivery!.fence, expired.delivery!.fence + 1);
  assert.equal(taken.delivery!.acknowledged, 4);
  oldGate.gate.release("deliver");
  await oldFlush;
  assert.deepEqual(await stream(contender, fifth.streamId), taken);
  expectRequests(5, [
    [fifth.id, 201],
    [fifth.id, 201],
  ]);
  await statusText(contender, "未確認 2件、受付確認済み 4件。送信中");
  newGate.gate.release("deliver");
  await newFlush;
  expectRequests(5, [
    [fifth.id, 201],
    [fifth.id, 201],
    [sixth.id, 201],
  ]);
  await statusText(contender, "未確認 0件、受付確認済み 6件");
  console.log(
    "PASS lease: stale fence cannot remove the head, replace the takeover lease or send the next record",
  );

  // Switch before takeover: the new screen cannot select A, and an unaware old tab is rejected.
  const aHead = await append(newcomer),
    aTail = await append(newcomer);
  const { ended: deadBeforeSwitch } = await beforeNetwork(newcomer);
  const aQueue = await stream(contender, aHead.streamId);
  assert(aQueue.delivery?.lease);
  await killTab(newcomer, deadBeforeSwitch);
  const b = await switchScreen(a);
  const newScreen = await tab(b);
  await setTime(newScreen, aQueue.delivery.lease.expiresAt + 1);
  await flush(newScreen);
  expectRequests(8, []);
  await setTime(contender, aQueue.delivery.lease.expiresAt + 1);
  await flush(contender);
  expectRequests(8, [[aHead.id, 409]]);
  assert.equal(requests[8].payload.error, "experiment_client_stale");
  const refused = await stream(contender, aHead.streamId);
  assert.deepEqual(refused.items, aQueue.items);
  assert.equal(refused.delivery?.acknowledged, 6);
  assert.equal(refused.delivery?.state, "stale");

  // Switch after takeover: both previously accepted responses are in flight when B is replaced.
  const bPeer = await tab(b);
  const bHead = await append(newScreen),
    bTail = await append(newScreen);
  assert.deepEqual([bHead.sequence, bTail.sequence], [1, 2]);
  const bOldGate = queueResponseGate(),
    bOld = flush(newScreen);
  await bOldGate.arrived;
  const bQueue = await stream(bPeer, bHead.streamId);
  assert(bQueue.delivery?.lease);
  await setTime(bPeer, bQueue.delivery.lease.expiresAt + 1);
  const bNewGate = queueResponseGate(),
    bNew = flush(bPeer);
  await bNewGate.arrived;
  assert.deepEqual(requests[10], requests[9]);
  const c = await switchScreen(b);
  await authorize(bPeer, c);
  const cHead = await append(bPeer);
  assert.equal(cHead.sequence, 1);
  bOldGate.gate.release("deliver");
  bNewGate.gate.release("deliver");
  await Promise.all([bOld, bNew]);
  expectRequests(9, [
    [bHead.id, 201],
    [bHead.id, 201],
  ]);
  const bHeld = await stream(bPeer, bHead.streamId);
  assert.deepEqual(bHeld.items, bQueue.items);
  assert.equal(bHeld.delivery?.acknowledged, 0);
  await statusText(bPeer, "未確認 1件、受付確認済み 0件");
  await flush(bPeer);
  await statusText(bPeer, "未確認 0件、受付確認済み 1件");
  await statusText(bPeer, "旧記録の保留 6件");
  expectRequests(11, [[cHead.id, 201]]);
  assert.deepEqual((await snapshot(bPeer)).legacy, legacySeed);
  assert.deepEqual(routeFailures, []);

  const acknowledgedByApi = new Map(
    requests.filter((r) => r.status === 201).map((r) => [r.key, r]),
  );
  assert.equal(acknowledgedByApi.size, 8);
  process.send?.({
    accepted: [...acknowledgedByApi.values()].map((r) => ({
      key: r.key,
      stream: r.stream,
      order: r.order,
      body: r.body,
      eventId: r.payload.eventId,
      sequenceNumber: r.payload.sequenceNumber,
    })),
    unsaved: [
      ...legacySeed.items.map((i) => i.id),
      aHead.id,
      aTail.id,
      bTail.id,
    ],
  });
  console.log(
    "PASS lease: switching before/after takeover retains unmatched records and prevents false ACKs",
  );
}

async function verify() {
  await server.listen();
  const origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
  await openBrowser(origin);
  let primary = await openPage(origin);
  const a = await switchScreen(old);
  assert.notEqual(a.generation, old.generation);
  const legacySeed = await primary.evaluate(
    async ({ old, event, legacyStreamId }) => {
      const { legacy } = window.preview;
      await legacy.changeState(old.sessionId, (row) => {
        row.clientId = legacyStreamId;
        row.next = 3;
        row.acknowledged = 2;
      });
      await legacy.enqueue(old.sessionId, event, {
        clientId: old.clientId,
        generation: old.generation,
      });
      await legacy.enqueue(
        old.sessionId,
        { ...event, eventType: "SCREEN_LEAVE" },
        { clientId: old.clientId, generation: old.generation },
      );
      return legacy.changeState(old.sessionId, (row) => {
        row.heldHeadId = row.items[0].id;
        return row;
      });
    },
    { old, event, legacyStreamId },
  );
  await primary.close();
  primary = await openPage(origin);
  await primary.evaluate(async () =>
    (await window.preview.storage.openObservationStreamV3("capture")).close(),
  );
  await authorize(primary, a);
  await openDelivery(primary);
  assert.deepEqual((await snapshot(primary)).legacy, legacySeed);
  if (fixture.leaseCases)
    return verifyLeaseTakeovers(origin, primary, a, legacySeed);
  const first = await append(primary),
    second = await append(primary);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.notEqual(first.streamId, legacyStreamId);
  await statusText(primary, "旧記録の保留 2件");
  behavior = "drop";
  await flush(primary);
  assert.deepEqual(
    requests.map((r) => [r.key, r.status]),
    [[first.id, 201]],
  );
  await statusText(primary, "未確認 2件、受付確認済み 0件。再送待ち");
  const beforeRestart = await snapshot(primary);
  await browser!.close();
  browser = undefined;
  await openBrowser(origin);
  primary = await openPage(origin);
  await authorize(primary, a);
  await openDelivery(primary);
  assert.deepEqual(await snapshot(primary), beforeRestart);
  const other = await openPage(origin);
  await authorize(other, a);
  await openDelivery(other);
  const replayArrived = holdResponse();
  const drain = flush(primary);
  await replayArrived;
  const replay = requests[1];
  assert.deepEqual(
    replay,
    requests[0],
    "identical replay reuses the existing event and receipt",
  );
  await flush(other);
  assert.equal(
    requests.length,
    2,
    "second tab cannot skip or send the leased head",
  );
  await statusText(other, "未確認 2件、受付確認済み 0件。送信中");
  releaseResponse();
  await drain;
  assert.deepEqual(
    requests.map((r) => r.key),
    [first.id, first.id, second.id],
  );
  assert.equal(requests[2].status, 201);
  await statusText(primary, "未確認 0件、受付確認済み 2件");
  await primary
    .getByRole("alert")
    .getByText("別の操作の記録を保存できませんでした。", { exact: false })
    .waitFor();

  const delayed = await append(primary),
    unsentOld = await append(other);
  assert.deepEqual([delayed.sequence, unsentOld.sequence], [3, 4]);
  const delayedArrived = holdResponse();
  const late = flush(primary);
  await delayedArrived;
  assert.equal(requests[3].status, 201);
  const b = await switchScreen(a);
  await authorize(primary, b);
  const fresh = await append(primary);
  assert.equal(fresh.sequence, 1);
  assert.notEqual(fresh.streamId, first.streamId);
  await statusText(primary, "未確認 1件、受付確認済み 0件");
  releaseResponse();
  await late;
  await statusText(primary, "未確認 1件、受付確認済み 0件");
  const former = (await snapshot(primary)).streams.find(
    (s) => s.streamId === first.streamId,
  )!;
  assert.deepEqual(
    former.items.map((i) => i.id),
    [delayed.id, unsentOld.id],
  );
  assert.equal(former.delivery?.acknowledged, 2);
  await flush(other);
  assert.equal(requests[4].status, 409);
  assert.equal(requests[4].payload.error, "experiment_client_stale");
  await statusText(other, "未確認 2件、受付確認済み 2件。画面切替により保留");
  const authArrived = holdResponse();
  const priorAuth = flush(primary);
  await authArrived;
  assert.equal(requests[5].status, 201);
  await authorize(primary, { ...b, code: randomUUID() });
  await authorize(primary, b); // Same screen and generation, but its prior auth revision is invalid.
  releaseResponse();
  await priorAuth;
  await statusText(primary, "未確認 1件、受付確認済み 0件。送信待ち");
  await flush(primary);
  assert.deepEqual(requests[6], requests[5]);
  await statusText(primary, "未確認 0件、受付確認済み 1件");
  await statusText(primary, "旧記録の保留 4件");
  const rejected = await append(primary);
  await authorize(primary, { ...b, code: randomUUID() });
  await flush(primary);
  assert.equal(requests.at(-1)!.status, 401);
  await statusText(primary, "未確認 1件、受付確認済み 1件。認証確認待ち");
  await authorize(primary, b);
  behavior = "offline";
  await flush(primary);
  await statusText(primary, "未確認 1件、受付確認済み 1件。再送待ち");
  assert.equal(requests.at(-1)!.status, 0);
  behavior = "normal";
  await researcherPost(`/api/research/experiment-runs/${runId}/end`, {
    confirmed: true,
  });
  await flush(primary);
  assert.equal(requests.at(-1)!.status, 409);
  assert.equal(requests.at(-1)!.payload.error, "experiment_ended");
  await statusText(primary, "未確認 1件、受付確認済み 1件。実施終了により保留");
  const final = await snapshot(primary);
  assert.deepEqual(final.legacy, legacySeed);
  assert.deepEqual(
    final.streams
      .find((s) => s.streamId === fresh.streamId)!
      .items.map((i) => i.id),
    [rejected.id],
  );
  assert.deepEqual(
    requests.map((r) => [r.key, r.status]),
    [
      [first.id, 201],
      [first.id, 201],
      [second.id, 201],
      [delayed.id, 201],
      [delayed.id, 409],
      [fresh.id, 201],
      [fresh.id, 201],
      [rejected.id, 401],
      [rejected.id, 0],
      [rejected.id, 409],
    ],
  );
  assert.deepEqual(routeFailures, []);
  const accepted = [requests[0], requests[2], requests[3], requests[5]].map(
    (r) => ({
      key: r.key,
      stream: r.stream,
      order: r.order,
      body: r.body,
      eventId: r.payload.eventId,
      sequenceNumber: r.payload.sequenceNumber,
    }),
  );
  process.send?.({
    accepted,
    unsaved: [...legacySeed.items.map((i) => i.id), unsentOld.id, rejected.id],
  });
  console.log(
    "PASS Edge: lost ACK/restart, concurrent FIFO, late ACK after real switch and auth revision, stale/401/ended/offline hold, legacy and independent warning preserved",
  );
}

try {
  await verify();
} finally {
  for (const gate of gates) gate.release("abandon");
  try {
    await browser?.close();
  } finally {
    await server.close();
    if (
      resolve(profile).startsWith(profilePrefix) &&
      resolve(profile) !== profilePrefix
    )
      await rm(profile, { recursive: true, force: true });
  }
}
