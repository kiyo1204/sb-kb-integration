// TEST ONLY. Actual API and fresh browser Session supplied by parent verification.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requestDigest } from "../src/client-identity";
const base = process.env.API_BASE_URL!,
  token = process.env.EXPERIMENT_BROWSER_TOKEN!,
  sid = process.env.EXPERIMENT_BROWSER_SESSION!;
const vite = await createServer({
  server: {
    host: "127.0.0.1",
    port: 0,
    proxy: { "/api": { target: base, changeOrigin: true } },
  },
});
await vite.listen();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
const dir =
  process.env.LEARNER_SCREENSHOT_DIR ?? join(tmpdir(), "sbkb-learner-preview");
await mkdir(dir, { recursive: true });
let releaseDeliveryGate = () => {};
const deliveryRouteTasks = new Set<Promise<void>>();
const practiceTrace: { case: string; phase: string; kind: string }[] = [];
const practiceGates = new Set<() => void>();
const practiceRouteTasks = new Set<Promise<void>>();
function tracePractice(testCase: string, phase: string, kind: string) {
  if (practiceTrace.length >= 40) return;
  practiceTrace.push({ case: testCase, phase, kind });
}
try {
  const page = await browser.newPage({
    viewport: { width: 1366, height: 1200 },
  });
  await page.addInitScript("globalThis.__name = (fn) => fn;");
  // This real-API browser suite tests learner flow after a previously completed
  // local rehearsal. Gesture-by-gesture completion is covered by rehearsal UI tests.
  await page.addInitScript(({ key }) => sessionStorage.setItem(key, "1"), {
    key: `sbkb-practice-complete-v1:${sid}:${requestDigest(token)}`,
  });
  page.on("dialog", (d) => void d.accept());
  await page.goto(vite.resolvedUrls!.local[0]);
  await page.locator("#home-access-code").fill(token);
  await page.locator("#home-access-code").press("Enter");
  async function refreshConnection(title: string) {
    const checked = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/experiment-material",
    );
    await page
      .getByRole("button", { name: "接続状態を更新", exact: true })
      .click();
    await checked;
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll("button")).find(
          (b) => b.textContent === "接続状態を更新",
        )?.disabled,
    );
  }
  const waiting = page.getByRole("heading", {
    name: "実施の開始を待っています",
    exact: true,
  });
  await waiting.waitFor();
  await page
    .getByText("コードの確認と、この画面の端末登録は完了しています。", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "セッションを開始", exact: true })
      .count(),
    0,
  );
  assert.equal(await page.locator("svg,canvas").count(), 0);
  const initialClient = await page.locator(".session-card code").innerText();
  await refreshConnection("実施の開始を待っています");
  assert.equal(
    await page.locator(".session-card code").innerText(),
    initialClient,
    "refresh keeps same registration",
  );
  await page.screenshot({ path: join(dir, "waiting.png"), fullPage: true });
  const secondContext = await browser.newContext();
  await secondContext.addInitScript(
    (t) => sessionStorage.setItem("stage1-access-token", t),
    token,
  );
  const second = await secondContext.newPage();
  await second.goto(vite.resolvedUrls!.local[0] + `sessions/${sid}`);
  await second
    .getByRole("heading", { name: "この画面では利用できません", exact: true })
    .waitFor();
  assert.equal(
    await second
      .getByRole("heading", { name: "実施の開始を待っています", exact: true })
      .count(),
    0,
  );
  await second.screenshot({
    path: join(dir, "client-conflict.png"),
    fullPage: true,
  });
  await secondContext.close();
  // Transport fault fixtures are separate from the real API waiting/claim checks.
  for (const status of [503, 409]) {
    await page.route("**/api/experiment-material", (route) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({
          error: "TEST ONLY unknown response",
          message: "TEST ONLY private exception",
        }),
      }),
    );
    await refreshConnection("接続状態を確認できません");
    assert.equal(await waiting.count(), 0);
    assert.ok(
      !(await page.locator("body").innerText()).includes("private exception"),
    );
    assert.equal(
      await page
        .getByText("コードの確認と、この画面の端末登録は完了しています。", {
          exact: true,
        })
        .count(),
      0,
    );
    await page.unroute("**/api/experiment-material");
  }
  // A failed/unrecognized claim must not assert that this screen is registered.
  for (const status of [503, 409]) {
    await page.route("**/api/experiment-client/claim", (route) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({
          error:
            status === 409
              ? "experiment_not_running"
              : "access_storage_unavailable",
          message: "TEST ONLY private claim failure",
        }),
      }),
    );
    const checked = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/experiment-client/claim",
    );
    await page
      .getByRole("button", { name: "接続状態を更新", exact: true })
      .click();
    await checked;
    await page
      .getByRole("heading", { name: "接続状態を確認できません", exact: true })
      .waitFor();
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll("button")).find(
          (b) => b.textContent === "接続状態を更新",
        )?.disabled,
    );
    assert.equal(await waiting.count(), 0);
    assert.ok(
      !(await page.locator("body").innerText()).includes(
        "private claim failure",
      ),
    );
    assert.equal(
      await page
        .getByText("コードの確認と、この画面の端末登録は完了しています。", {
          exact: true,
        })
        .count(),
      0,
    );
    await page.unroute("**/api/experiment-client/claim");
  }
  await refreshConnection("実施の開始を待っています");
  const startKey = crypto.randomUUID();
  for (let i = 0; i < 2; i++) {
    const started = await fetch(
      base +
        `/api/research/experiment-runs/${process.env.EXPERIMENT_BROWSER_RUN!}/start`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.RESEARCHER_API_TOKEN!,
          "Content-Type": "application/json",
          "Idempotency-Key": startKey,
        },
        body: "{}",
      },
    );
    assert.equal(started.status, 200);
  }
  await refreshConnection("P02：活動の案内");
  const documentBeforePractice = await page.evaluate(
    () => performance.timeOrigin,
  );
  const documentClientChecks: string[] = [];
  // Count request starts, not response completions. Existing delivery is not
  // practice generation: validate its owner, exact queued event and counters.
  const settleDelivery = () =>
    page.evaluate(async (sessionId) => {
      const outbox = await import("/src/observation-outbox.ts");
      const auth = await import("/src/auth-client.ts");
      return outbox.flush(sessionId, auth.apiFetch);
    }, sid);
  const queueSnapshot = () =>
    page.evaluate(async (sessionId) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open("stage1-observation-outbox");
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(new Error("test queue read failed"));
      });
      try {
        return await new Promise<{
          next: number;
          acknowledged: number;
          clientId: string;
          items: {
            id: string;
            order: number;
            event: unknown;
            experimentOrigin: { clientId: string; generation: number };
          }[];
        }>((resolve, reject) => {
          const read = db
            .transaction("sessions", "readonly")
            .objectStore("sessions")
            .get(sessionId);
          read.onsuccess = () => resolve(read.result);
          read.onerror = () => reject(new Error("test queue read failed"));
        });
      } finally {
        db.close();
      }
    }, sid);
  const flowSnapshot = () =>
    page.evaluate(async (sessionId) => {
      const { apiFetch } = await import("/src/auth-client.ts");
      const response = await apiFetch(`/api/sessions/${sessionId}/flow`);
      if (!response.ok) throw new Error("test flow read failed");
      const flow = await response.json();
      return JSON.stringify({ session: flow.session, stages: flow.stages });
    }, sid);
  for (const testCase of ["empty", "existing-observation"] as const) {
    assert.equal(await settleDelivery(), true);
    assert.equal((await queueSnapshot()).items.length, 0);
    if (testCase === "existing-observation") {
      // A valid pre-practice observation, never an action from the tutorial.
      await page.evaluate(async ({sessionId, timestamp}) => {
        const { apiFetch, getExperimentObservationOrigin } =
          await import("/src/auth-client.ts");
        const outbox = await import("/src/observation-outbox.ts");
        const response = await apiFetch(`/api/sessions/${sessionId}/flow`);
        if (!response.ok) throw new Error("fixture flow unavailable");
        const flow = await response.json();
        const origin = getExperimentObservationOrigin(sessionId);
        if (!origin) throw new Error("fixture origin unavailable");
        // getSessionFlow exposes neither currentStage nor nextStage before
        // Session start. Select its own first pending LESSON from stages.
        const stage = flow.stages.find((item: {orderIndex:number}) => item.orderIndex === 0);
        if (flow.session.status !== "NOT_STARTED" || stage?.stageType !== "LESSON" || stage.status !== "PENDING" || !stage.id)
          throw new Error("fixture first pending lesson unavailable");
        await outbox.enqueue(
          sessionId,
          {
            schemaVersion: 1,
            eventType: "SCREEN_ENTER",
            targetType: "SCREEN",
            stageId: stage.id,
            outcome: "SUCCESS",
            clientTimestamp: timestamp,
            clientTimeQuality: "OBSERVED",
          },
          origin,
        );
      }, {sessionId:sid,timestamp:process.env.EXPERIMENT_PRACTICE_OBSERVATION_TIMESTAMP!});
    }
    const beforeQueue = await queueSnapshot();
    const beforeFlow = await flowSnapshot();
    const deliveryResults: { status: number; saved: boolean }[] = [];
    const forwardReport = (route: import("playwright").Route) => {
      const task = (async () => {
        // Read the real upstream response before forwarding unchanged; avoid
        // a later CDP Network.getResponseBody lookup for this probe.
        const response = await route.fetch();
        const body = await response.json();
        deliveryResults.push({ status: response.status(), saved: body.reportSaved === true });
        await route.fulfill({ response });
      })();
      practiceRouteTasks.add(task);
      void task.finally(() => practiceRouteTasks.delete(task)).catch(() => undefined);
      return task;
    };
    const ownReportRoute = `**/api/sessions/${sid}/delivery-status`;
    await page.route(ownReportRoute, forwardReport);
    let phase = "before-practice";
    const mutations: import("playwright").Request[] = [];
    const observePractice = (request: import("playwright").Request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/") && request.method() !== "GET")
        mutations.push(request);
      if (path === `/api/sessions/${sid}/flow`)
        documentClientChecks.push(
          request.headers()["x-experiment-client"] ?? "",
        );
      if (path === `/api/sessions/${sid}/delivery-status`)
        tracePractice(testCase, phase, "delivery-request-start");
    };
    page.on("request", observePractice);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    practiceGates.add(release);
    let entered = () => {};
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holdIdentity = (route: import("playwright").Route) => {
      const task = (async () => {
        tracePractice(testCase, phase, "retry-identity-request-start");
        entered();
        await gate;
        await route.continue();
      })();
      practiceRouteTasks.add(task);
      void task
        .finally(() => practiceRouteTasks.delete(task))
        .catch(() => undefined);
      return task;
    };
    await page.route("**/api/me", holdIdentity);
    if (testCase === "empty") {
      // The production online handler uses the same retry callback as its
      // initial effect and 15s interval. Let this chain cross practice entry.
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await held;
    }
    const accessChecked = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/sessions/${sid}/flow` &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: /練習を開く/ }).click();
    await page
      .getByRole("heading", { name: "操作の練習", exact: true })
      .waitFor();
    await accessChecked;
    phase = "practice";
    tracePractice(testCase, phase, "practice-open");
    if (testCase === "existing-observation") {
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await held;
    }
    const delivered = page.waitForResponse((response) => {
      if (
        new URL(response.url()).pathname !==
        `/api/sessions/${sid}/delivery-status`
      )
        return false;
      return (
        response.request().postDataJSON().pending === 0 &&
        response.status() === 200
      );
    });
    tracePractice(testCase, phase, "release-identity-response");
    release();
    practiceGates.delete(release);
    await delivered;
    tracePractice(testCase, phase, "delivery-response-complete");
    assert.equal(await settleDelivery(), true);
    await page.unroute("**/api/me", holdIdentity);
    await page.getByLabel("概念の名前").fill("TEST ONLY practice");
    await page.getByRole("button", { name: "概念を追加", exact: true }).click();
    await page.getByLabel("リンクの名前").fill("TEST ONLY practice relation");
    await page
      .getByRole("button", { name: "リンクを追加", exact: true })
      .click();
    await page.getByRole("button", { name: "案内へ戻る（練習未完了）", exact: true }).click();
    await page.getByRole("heading", { name: "P02：活動の案内" }).waitFor();
    phase = "returned";
    const afterQueue = await queueSnapshot();
    assert.equal(
      afterQueue.next,
      beforeQueue.next,
      "practice must not enqueue any observation",
    );
    assert.equal(
      afterQueue.items.length,
      0,
      "pre-existing observation is ACKed, not discarded",
    );
    assert.equal(
      afterQueue.acknowledged,
      beforeQueue.acknowledged + beforeQueue.items.length,
    );
    assert.equal(
      afterQueue.clientId === beforeQueue.clientId,
      true,
      "stream retained",
    );
    assert.equal(
      (await flowSnapshot()) === beforeFlow,
      true,
      "practice leaves Session/Stages unchanged",
    );
    page.off("request", observePractice);
    await Promise.all([...practiceRouteTasks]);
    await page.unroute(ownReportRoute, forwardReport);
    assert.ok(deliveryResults.length > 0 && deliveryResults.every(result => result.status === 200 && result.saved), "own Session reports accepted by the real API");
    const reports = mutations.filter(
      (r) =>
        new URL(r.url()).pathname === `/api/sessions/${sid}/delivery-status`,
    );
    const observations = mutations.filter(
      (r) => new URL(r.url()).pathname === `/api/sessions/${sid}/events`,
    );
    assert.ok(
      reports.length > 0,
      "delivery report actually crosses the monitored practice window",
    );
    const reportKeys = [
      "clientId",
      "reportSequence",
      "pending",
      "retrying",
      "acknowledged",
      "capacityLost",
      "expiredLost",
      "rejectedLost",
      "storageLost",
      "attempts",
      "lastResponse",
    ];
    for (const report of reports) {
      const body = report.postDataJSON();
      assert.equal(report.method(), "POST");
      assert.equal(
        report.headers()["authorization"] === `Bearer ${token}`,
        true,
        "own authenticated Session only",
      );
      assert.equal(
        body.clientId === beforeQueue.clientId,
        true,
        "own existing stream only",
      );
      assert.equal(
        Object.keys(body).sort().join() === [...reportKeys].sort().join(),
        true,
        "only delivery metadata, no practice content",
      );
      for (const key of reportKeys.filter(
        (k) => !["clientId", "lastResponse"].includes(k),
      ))
        assert.ok(Number.isSafeInteger(body[key]) && body[key] >= 0);
      assert.ok(
        ["NONE", "ACK", "NETWORK", "RETRYABLE", "REJECTED", "SENDING"].includes(
          body.lastResponse,
        ),
      );
    }
    assert.equal(
      observations.length,
      beforeQueue.items.length,
      "only exact pre-practice queued observations may be sent",
    );
    for (const request of observations) {
      const item = beforeQueue.items.find(
        (i) => i.id === request.headers()["idempotency-key"],
      );
      assert.ok(item, "no newly generated practice event");
      assert.equal(request.method(), "POST");
      assert.equal(
        request.headers()["authorization"] === `Bearer ${token}`,
        true,
      );
      assert.equal(
        request.headers()["x-client-stream-id"] === beforeQueue.clientId,
        true,
      );
      assert.equal(
        request.headers()["x-client-sequence"] === String(item.order),
        true,
      );
      assert.equal(
        request.headers()["x-experiment-origin-client"] ===
          item.experimentOrigin.clientId,
        true,
      );
      assert.equal(
        request.headers()["x-experiment-origin-generation"] ===
          String(item.experimentOrigin.generation),
        true,
      );
      assert.equal(
        JSON.stringify(request.postDataJSON()) === JSON.stringify(item.event),
        true,
        "pre-existing content unchanged",
      );
    }
    assert.equal(
      mutations.length,
      reports.length + observations.length,
      "no Map/Stage/claim/other mutation, including other Sessions",
    );
    console.log(
      JSON.stringify({
        check: "practice-delivery-contract",
        case: testCase,
        queuedBefore: beforeQueue.items.length,
        pendingAfter: afterQueue.items.length,
        newObservations: afterQueue.next - beforeQueue.next,
        receivedExisting: afterQueue.acknowledged - beforeQueue.acknowledged,
        reportRequests: reports.length,
        eventRequests: observations.length,
        otherMutations: 0,
      }),
    );
  }
  assert.equal(
    await page.evaluate(() => performance.timeOrigin),
    documentBeforePractice,
  );
  assert.ok(
    documentClientChecks.length > 0 &&
      documentClientChecks.every(
        (value) => value.length > 0 && value === documentClientChecks[0],
      ),
    "same registered client for access checks; values not reported",
  );
  await page
    .getByRole("button", { name: "セッションを開始", exact: true })
    .click();
  await page.getByRole("button", { name: "開始する", exact: true }).click();
  const checkbox = page.getByRole("checkbox");
  await checkbox.check();
  await page
    .getByRole("button", { name: "視聴を終えて次へ", exact: true })
    .click();
  await page.getByRole("region", { name: "P04 課題説明" }).waitFor();
  assert.ok((await page.locator("main").innerText()).includes("TEST ONLY SB"));
  await page.getByRole("button", { name: "開始する", exact: true }).click();
  await page.getByRole("heading", { name: /Scratch-Build/ }).waitFor();
  await page.locator(".experiment-task-instructions summary").click();
  assert.ok(
    (await page.locator(".experiment-task-instructions").innerText()).includes(
      "TEST ONLY SB",
    ),
  );
  await page.locator(".experiment-task-instructions summary").click();
  await page.locator(".map-editor-tools button").first().click();
  await page
    .locator(".map-editor-drawer-form input")
    .first()
    .fill("TEST ONLY unsaved input");
  assert.ok(
    await page
      .getByRole("button", { name: "最終提出", exact: true })
      .isDisabled(),
    "unsaved drawer prevents submission",
  );
  await page
    .getByRole("button", { name: "Drawerを閉じる", exact: true })
    .click();
  await page.getByRole("button", { name: "全体表示", exact: true }).click();
  await page
    .getByText(
      "初期概念は移動・リンク接続ができます。名前変更・削除はできません。",
      { exact: true },
    )
    .waitFor();
  await page.screenshot({
    path: join(dir, "sb-unselected.png"),
    fullPage: true,
  });
  // UI-only missing-seed fixture. No persisted seed or DB constraint is changed.
  const mapGet = /\/api\/maps\/[^/?]+$/;
  await page.route(mapGet, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = JSON.stringify(await response.json(), (key, value) =>
      key === "isSeed" ? false : value,
    );
    await route.fulfill({ response, body });
  });
  await page.getByRole("link", { name: /セッション画面へ戻る/ }).click();
  await page.getByRole("button", { name: "続ける", exact: true }).click();
  await page.getByRole("heading", { name: /Scratch-Build/ }).waitFor();
  await page.locator(".concept-node").first().waitFor();
  assert.equal(await page.locator(".experiment-seed-guidance").count(), 0);
  await page.screenshot({
    path: join(dir, "sb-no-seed-fixture.png"),
    fullPage: true,
  });
  await page.unroute(mapGet);
  await page.getByRole("link", { name: /セッション画面へ戻る/ }).click();
  await page.getByRole("button", { name: "続ける", exact: true }).click();
  await page.locator(".experiment-seed-guidance").waitFor();
  const reopenCurrentMap = async () => {
    await page.getByRole("link", { name: /セッション画面へ戻る/ }).click();
    await page.getByRole("button", { name: "続ける", exact: true }).click();
    await page.getByRole("heading", { name: /Scratch-Build/ }).waitFor();
    await page.locator(".experiment-seed-guidance").waitFor();
  };
  const scrollSeed = await page.evaluate(async (sessionId) => {
    const { apiFetch } = await import("/src/auth-client.ts");
    const flowResponse = await apiFetch(`/api/sessions/${sessionId}/flow`);
    if (!flowResponse.ok) throw new Error("scroll fixture flow unavailable");
    const flow = await flowResponse.json();
    const mapId = flow.currentStage.mapId as string;
    const mapResponse = await apiFetch(`/api/maps/${mapId}`);
    if (!mapResponse.ok) throw new Error("scroll fixture map unavailable");
    const map = await mapResponse.json();
    const seed = map.concepts.find(
      (concept: { isSeed?: boolean }) => concept.isSeed,
    );
    if (!seed) throw new Error("scroll fixture seed unavailable");
    const moved = await apiFetch(`/api/concepts/${seed.id}/position`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positionX: 1250, positionY: 720 }),
    });
    if (!moved.ok) throw new Error("scroll fixture position unavailable");
    return { mapId, seedId: seed.id };
  }, sid);
  // Hold only genuine observation transport; Map PATCHes still use the API.
  let releaseGate!: () => void;
  const deliveryGate = new Promise<void>((resolve) => { releaseGate = resolve; });
  releaseDeliveryGate = releaseGate;
  const eventPath = `/api/sessions/${sid}/events`;
  const heldObservation = page.waitForRequest((request) => new URL(request.url()).pathname === eventPath && request.method() === "POST");
  void heldObservation.catch(() => undefined);
  await page.route(`**${eventPath}`, (route) => {
    const task = (async () => { await deliveryGate; await route.continue(); })();
    deliveryRouteTasks.add(task);
    return task.finally(() => deliveryRouteTasks.delete(task));
  });
  // Re-enter through the session flow so the active experimental client claim
  // remains the same while MapPage fetches the persisted state again.
  await reopenCurrentMap();
  await heldObservation;
  const deliveryNotice = page.locator(".map-editor-delivery-status p");
  await deliveryNotice.waitFor({ state: "visible" });
  await page.setViewportSize({ width: 1366, height: 640 });
  const scrollState = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(
        ".concept-canvas-viewport",
      ),
      canvas = document.querySelector<HTMLElement>(".concept-canvas");
    if (!viewport || !canvas) throw new Error("scroll canvas unavailable");
    const pageMax = document.documentElement.scrollHeight - window.innerHeight;
    if (pageMax > 0) window.scrollTo(0, Math.min(100, pageMax));
    const maxLeft = viewport.scrollWidth - viewport.clientWidth,
      maxTop = viewport.scrollHeight - viewport.clientHeight;
    viewport.scrollLeft = maxLeft;
    viewport.scrollTop = maxTop;
    return {
      pageMax,
      pageScrollY: window.scrollY,
      scrollLeft: viewport.scrollLeft,
      maxLeft,
      scrollTop: viewport.scrollTop,
      maxTop,
      zoom: canvas.style.zoom,
    };
  });
  assert.ok(scrollState.maxLeft > 0, "test map must overflow horizontally");
  assert.ok(scrollState.maxTop > 0, "test map must overflow vertically");
  assert.ok(scrollState.scrollLeft > 0 && scrollState.scrollTop > 0);
  assert.equal(scrollState.zoom, "1", "scroll coordinate case uses 100% zoom");
  if (scrollState.pageMax > 0)
    assert.ok(scrollState.pageScrollY > 0, "outer page scroll is active");
  // Opt-in, bounded observations for this synthetic coordinate case only.
  const coordinateProbe = process.env.EXPERIMENT_SCROLL_DIAGNOSTICS === "1";
  const positionTraffic: unknown[] = [];
  const recordPositionRequest = (request: import("playwright").Request) => {
    try {
      if (positionTraffic.length >= 20 || request.method() !== "PATCH" ||
          !/\/concepts\/[^/]+\/position$/.test(new URL(request.url()).pathname)) return;
      const value = request.postDataJSON();
      positionTraffic.push({ kind: "request", conceptId: new URL(request.url()).pathname.split("/")[3], positionX: typeof value.positionX === "number" ? value.positionX : null, positionY: typeof value.positionY === "number" ? value.positionY : null });
    } catch { /* Diagnostic failures must not change the test outcome. */ }
  };
  if (coordinateProbe) {
    try {
    console.log(JSON.stringify({ check: "scroll-coordinate-runtime", node: process.version, platform: process.platform, browser: browser.version(), viewport: page.viewportSize() }));
    page.on("request", recordPositionRequest);
    await page.evaluate(() => {
      const samples: unknown[] = [];
      const record = (event: Event) => {
        try {
        if (samples.length >= 40) return;
        const canvas = document.querySelector<HTMLElement>(".concept-canvas");
        const viewport = document.querySelector<HTMLElement>(".concept-canvas-viewport");
        const node = document.querySelector<HTMLElement>(".concept-node");
        if (!canvas || !viewport || !node) return;
        const rect = canvas.getBoundingClientRect();
        const pointer = event instanceof PointerEvent ? { x: event.clientX, y: event.clientY, conceptId: (event.target as Element)?.closest?.("[data-concept-id]")?.getAttribute("data-concept-id") } : undefined;
        const ancestors = [];
        for (let ancestor = canvas.parentElement; ancestor && ancestors.length < 8; ancestor = ancestor.parentElement) {
          const bounds = ancestor.getBoundingClientRect();
          ancestors.push({ tag: ancestor.tagName, className: ancestor.className, x: bounds.x, y: bounds.y, scrollLeft: ancestor.scrollLeft, scrollTop: ancestor.scrollTop });
        }
        const regions = Array.from(document.querySelectorAll(".map-editor-header, .map-editor-header-actions, .map-editor-header-actions > *, .experiment-state-guidance"), (element) => {
          const bounds = element.getBoundingClientRect();
          return { tag: element.tagName, className: element.className, delivery: element.textContent?.startsWith("操作記録：送信待ち") ?? false, y: bounds.y, height: bounds.height, display: getComputedStyle(element).display };
        }).slice(0, 20);
        samples.push({ event: event.type, pointer, canvas: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scaleX: canvas.offsetWidth / rect.width, scaleY: canvas.offsetHeight / rect.height }, zoom: canvas.style.zoom, scrollX: window.scrollX, scrollY: window.scrollY, viewportScroll: { x: viewport.scrollLeft, y: viewport.scrollTop }, ancestors, regions, node: { id: node.dataset.conceptId, left: node.style.left, top: node.style.top } });
        } catch { /* Observe without affecting pointer dispatch. */ }
      };
      const types = ["pointerdown", "pointermove", "pointerup", "scroll"];
      for (const type of types) document.addEventListener(type, record, { capture: true, passive: true });
      Object.assign(window, { __scrollCoordinateProbe: samples, __stopScrollCoordinateProbe: () => types.forEach((type) => document.removeEventListener(type, record, true)) });
    });
    } catch { /* Setup diagnostics must not replace the original assertion. */ }
  }
  const seedNode = page.locator(".concept-node").first();
  let seedBox: { x: number; y: number; width: number; height: number } | null = null;
  let persistedPosition!: { positionX: number; positionY: number };
  try {
  // Fully expose the real target after setting both scroll containers.
  // The reserved notification row changes the available viewport area.
  await seedNode.scrollIntoViewIfNeeded();
  seedBox = await seedNode.boundingBox();
  assert.ok(seedBox);
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return { tag: element?.tagName, conceptId: element?.closest("[data-concept-id]")?.getAttribute("data-concept-id") };
  }, { x: seedBox.x + seedBox.width / 2, y: seedBox.y + seedBox.height / 2 });
  console.log(JSON.stringify({ check: "scroll-pointer-target", expectedId: scrollSeed.seedId, hit }));
  assert.equal(hit.conceptId, scrollSeed.seedId, "drag starts on the intended visible concept");
  const moved = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      /\/concepts\/[^/]+\/position$/.test(new URL(r.url()).pathname),
  );
  // Retain the original rejection for the awaited assertion while other
  // controlled UI work is in progress; do not create an unhandled rejection.
  void moved.catch(() => undefined);
  await page.mouse.move(
    seedBox.x + seedBox.width / 2,
    seedBox.y + seedBox.height / 2,
  );
  await page.mouse.down();
  const beforeDeliveryClears = await page.locator(".concept-canvas").boundingBox();
  releaseGate();
  await deliveryNotice.waitFor({ state: "hidden" });
  const afterDeliveryClears = await page.locator(".concept-canvas").boundingBox();
  console.log(JSON.stringify({ check: "delivery-clears-during-drag", before: beforeDeliveryClears, after: afterDeliveryClears }));
  assert.deepEqual(afterDeliveryClears, beforeDeliveryClears, "observation ACK must not move the canvas during a drag");
  await page.mouse.move(
    seedBox.x + seedBox.width / 2 + 40,
    seedBox.y + seedBox.height / 2 + 30,
    { steps: 10 },
  );
  await page.mouse.up();
  const positionResponse = await moved;
  if (coordinateProbe) {
    try { positionTraffic.push({ kind: "waited-response", conceptId: new URL(positionResponse.url()).pathname.split("/")[3], status: positionResponse.status() }); } catch { /* Preserve the response assertion. */ }
  }
  assert.equal((await moved).status(), 200);
  persistedPosition = await page.evaluate(async ({ mapId, seedId }) => {
    const { apiFetch } = await import("/src/auth-client.ts");
    const response = await apiFetch(`/api/maps/${mapId}`);
    if (!response.ok) throw new Error("saved scroll map unavailable");
    const map = await response.json();
    const seed = map.concepts.find(
      (concept: { id: string }) => concept.id === seedId,
    );
    if (!seed) throw new Error("saved scroll seed unavailable");
    return { positionX: seed.positionX, positionY: seed.positionY };
  }, scrollSeed);
  assert.deepEqual(persistedPosition, { positionX: 1290, positionY: 750 });
  } finally {
  if (coordinateProbe) {
    try {
      console.log(JSON.stringify({ check: "scroll-coordinate-probe", conceptId: scrollSeed.seedId, before: { positionX: 1250, positionY: 720 }, expected: { positionX: 1290, positionY: 750 }, pointerStart: seedBox, apiReadback: persistedPosition, traffic: positionTraffic, samples: await page.evaluate(() => (window as unknown as { __scrollCoordinateProbe: unknown[] }).__scrollCoordinateProbe) }));
    } catch { /* Preserve the original assertion even if observation fails. */ }
    try { page.off("request", recordPositionRequest); } catch { /* Preserve the original outcome. */ }
    try { await page.evaluate(() => (window as unknown as { __stopScrollCoordinateProbe?: () => void }).__stopScrollCoordinateProbe?.()); } catch { /* Best effort diagnostic cleanup only. */ }
  }
  }
  await reopenCurrentMap();
  const reloadedPosition = await page.evaluate(async ({ mapId, seedId }) => {
    const { apiFetch } = await import("/src/auth-client.ts");
    const response = await apiFetch(`/api/maps/${mapId}`);
    if (!response.ok) throw new Error("reloaded scroll map unavailable");
    const map = await response.json();
    const seed = map.concepts.find(
      (concept: { id: string }) => concept.id === seedId,
    );
    if (!seed) throw new Error("reloaded scroll seed unavailable");
    return { positionX: seed.positionX, positionY: seed.positionY };
  }, scrollSeed);
  assert.deepEqual(reloadedPosition, persistedPosition);
  await page.setViewportSize({ width: 1366, height: 1200 });
  await page.getByRole("button", { name: "全体表示", exact: true }).click();
  await page.locator(".experiment-seed-guidance").waitFor();
  await page
    .locator(".map-editor-save-status")
    .filter({ hasText: "保存済み" })
    .waitFor();
  await page.screenshot({ path: join(dir, "p05.png"), fullPage: true });
  let clickPositionWrites = 0;
  const countClickPositionWrites = (request: import("playwright").Request) => {
    if (
      request.method() === "PATCH" &&
      /\/concepts\/[^/]+\/position$/.test(new URL(request.url()).pathname)
    )
      clickPositionWrites += 1;
  };
  page.on("request", countClickPositionWrites);
  try {
    await seedNode.click();
    await page
      .getByRole("button", { name: "Drawerを閉じる", exact: true })
      .waitFor();
  } finally {
    page.off("request", countClickPositionWrites);
  }
  assert.equal(
    clickPositionWrites,
    0,
    "clicking a concept after canvas fit must not save a position change",
  );
  assert.ok(await page.locator(".experiment-seed-guidance").isVisible());
  await page.screenshot({ path: join(dir, "sb-selected.png"), fullPage: true });
  await page
    .getByRole("button", { name: "Drawerを閉じる", exact: true })
    .click();
  await page.context().setOffline(true);
  await page
    .getByText("オフライン：保存・提出はできません。", { exact: false })
    .waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "この画面では利用できません" }).count(),
    0,
    "same-tab F5 does not require researcher client-switch",
  );
  assert.ok(
    await page
      .getByRole("button", { name: "最終提出", exact: true })
      .isDisabled(),
  );
  await page.context().setOffline(false);
  await page.getByRole("button", { name: "最終提出", exact: true }).click();
  await page.getByRole("region", { name: "P04 課題説明" }).waitFor();
  await page.getByRole("button", { name: "開始する", exact: true }).click();
  await page
    .getByRole("heading", { name: "STEP 3：Kit-Build", exact: true })
    .waitFor();
  assert.ok(
    await page
      .getByRole("button", { name: "最終提出", exact: true })
      .isDisabled(),
  );
  await page
    .locator("#kb-submission-guidance")
    .filter({ hasText: "未確認です" })
    .waitFor();
  await page
    .getByText(
      "最終提出時は、前回の結果にかかわらずサーバーが最新のマップを再判定します。",
      { exact: true },
    )
    .waitFor();
  await page.screenshot({
    path: join(dir, "kb-unchecked.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "一時提出", exact: true }).click();
  await page.locator(".kit-feedback-result-heading").waitFor();
  assert.ok(
    !(await page.getByRole("dialog").innerText()).includes("正しい接続先"),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "閉じる", exact: true })
    .click();
  assert.ok(
    (await page.locator(".concept-canvas-viewport").boundingBox())!.height <=
      601,
    "bounded visible working area",
  );
  assert.equal(await page.locator(".kit-palette-list").count(), 2);
  assert.ok(
    await page
      .locator(".kit-palette-list")
      .evaluateAll((nodes) =>
        nodes.every((n) => getComputedStyle(n).overflowX === "auto"),
      ),
    "independent scrolling palettes",
  );
  await page
    .locator("#kb-submission-guidance")
    .filter({ hasText: "確認結果：不一致" })
    .waitFor();
  await page.screenshot({ path: join(dir, "kb-mismatch.png"), fullPage: true });
  // Force the existing two-item real palette into a scrollable row in this
  // test only, then use the scrolled part through the actual learner API.
  const conceptList = page.locator(".kit-palette-list").first(),
    part = page.locator(".kit-palette-part.is-concept").nth(1),
    canvas = page.locator(".concept-canvas").first();
  const paletteWidth = await conceptList.evaluate((list) => {
    const first = list.firstElementChild as HTMLElement | null;
    if (!first) throw new Error("palette concept fixture unavailable");
    first.style.flex = `0 0 ${list.clientWidth}px`;
    return { clientWidth: list.clientWidth, scrollWidth: list.scrollWidth };
  });
  assert.ok(paletteWidth.scrollWidth > paletteWidth.clientWidth);
  await part.scrollIntoViewIfNeeded();
  const scrolledPart = await conceptList.evaluate((list) => {
    const item = list.querySelectorAll<HTMLElement>(
        ".kit-palette-part.is-concept",
      )[1],
      viewport = list.getBoundingClientRect(),
      bounds = item?.getBoundingClientRect();
    return {
      scrollLeft: list.scrollLeft,
      visible:
        !!bounds &&
        bounds.right > viewport.left &&
        bounds.left < viewport.right,
    };
  });
  assert.ok(
    scrolledPart.scrollLeft > 0,
    "second Kit Concept is reached by horizontal scrolling",
  );
  assert.equal(scrolledPart.visible, true);
  const from = await part.boundingBox(),
    box = await canvas.boundingBox();
  assert.ok(box && from);
  page.on("response", (r) => {
    if (r.url().includes("/import"))
      console.log("Palette import HTTP", r.status());
  });
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 250, box.y + 100, { steps: 15 });
  await page.mouse.move(box.x + 255, box.y + 105);
  await page.mouse.up();
  await page.waitForFunction(() => {
    const parts = document.querySelectorAll<HTMLButtonElement>(
      ".kit-palette-part.is-concept",
    );
    return parts[1]?.disabled === true;
  });
  await page.waitForFunction(
    () =>
      !document
        .querySelector(".kit-feedback-check-button")
        ?.hasAttribute("disabled"),
  );
  await page
    .locator("#kb-submission-guidance")
    .filter({ hasText: "前回の結果は古く" })
    .waitFor();
  assert.ok(
    await page
      .getByRole("button", { name: "最終提出", exact: true })
      .isDisabled(),
  );
  await page.screenshot({ path: join(dir, "kb-stale.png"), fullPage: true });
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await page.waitForFunction(() => {
    const parts = document.querySelectorAll<HTMLButtonElement>(
      ".kit-palette-part.is-concept",
    );
    return parts[1]?.disabled === false;
  });
  await conceptList.evaluate((list) => {
    const first = list.firstElementChild as HTMLElement | null;
    if (first) first.style.flex = "";
    list.scrollLeft = 0;
  });
  await page.screenshot({ path: join(dir, "p06.png"), fullPage: true });
  // Use the same application client for the rest of the synthetic graph, preserving
  // real authentication, edit generation, persistence and API checks.
  await page.evaluate(async (session) => {
    const { apiFetch } = await import("/src/auth-client.ts");
    const call = async (path: string, method = "GET", body?: unknown) => {
      const r = await apiFetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!r.ok) throw new Error("mock browser setup request failed");
      return r.json();
    };
    const f = await call(`/api/sessions/${session}/flow`),
      m = f.currentStage.mapId,
      g = await call(`/api/maps/${m}`),
      ids: Record<string, string> = {};
    for (const [i, p] of g.kitConcepts.entries())
      ids[p.label] = (
        await call(
          `/api/maps/${m}/kit-concepts/${p.kitConceptItemId}/import`,
          "POST",
          { positionX: 100 + i * 300, positionY: 150 },
        )
      ).id;
    for (const l of g.kitLinks)
      await call(`/api/maps/${m}/kit-links/${l.kitLinkItemId}`, "POST", {
        sourceConceptId: ids["TEST ONLY seed"],
        targetConceptId: ids["TEST ONLY second"],
      });
  }, sid);
  // Same-tab F5 reuses the registered client, but must re-claim ownership
  // from the real API. It must not require a researcher device transfer.
  // The current map survives; a prior KB match is not reused as confirmation.
  const [reloadClaim] = await Promise.all([
    page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/experiment-client/claim" &&
      response.request().method() === "POST",
    ),
    page.reload(),
  ]);
  assert.equal(reloadClaim.status(), 200, "same-tab F5 can re-claim ownership");
  const reloadOwnership = await reloadClaim.json();
  assert.equal(reloadOwnership.ownership, "OWNED");
  assert.equal(
    reloadOwnership.clientId,
    initialClient.trim(),
    "same-tab F5 preserves the original registered client",
  );
  assert.ok(
    Number.isInteger(reloadOwnership.deviceGeneration),
    "server still supplies a valid device generation",
  );
  await page
    .getByRole("heading", { name: "STEP 3：Kit-Build", exact: true })
    .waitFor();
  assert.ok(
    await page
      .getByRole("button", { name: "最終提出", exact: true })
      .isDisabled(),
  );
  await page.getByRole("link", { name: /セッション画面へ戻る/ }).click();
  await page.getByRole("button", { name: "続ける", exact: true }).click();
  await page.getByRole("button", { name: "一時提出", exact: true }).click();
  await page.getByRole("dialog").getByText("一致", { exact: true }).waitFor();
  await page.screenshot({ path: join(dir, "kb-match.png"), fullPage: true });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "閉じる", exact: true })
    .click();
  await page
    .locator("#kb-submission-guidance")
    .filter({ hasText: "確認結果：一致" })
    .waitFor();
  await page.screenshot({
    path: join(dir, "kb-confirmed.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "最終提出", exact: true }).click();
  await page.getByRole("region", { name: "P04 課題説明" }).waitFor();
  await page.getByRole("button", { name: "開始する", exact: true }).click();
  await page
    .getByRole("heading", { name: "STEP 4：統合", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "一時提出", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "最終提出", exact: true }).click();
  await page.getByRole("button", { name: "次へ", exact: true }).click();
  await page.getByRole("region", { name: "P08 完了・待機" }).waitFor();
  await page.screenshot({ path: join(dir, "p08.png"), fullPage: true });
  console.log(
    "Experiment learner browser: PASS (real waiting/claim/conflict/start, transport faults separately, P01–P08, offline submit guard, palette mouse/Undo, neutral flow, no survey/feedback during integration)",
  );
} finally {
  for (const release of practiceGates) release();
  await Promise.allSettled([...practiceRouteTasks]);
  if (process.env.PRACTICE_DELIVERY_DIAGNOSTICS_FILE) {
    await writeFile(
      process.env.PRACTICE_DELIVERY_DIAGNOSTICS_FILE,
      JSON.stringify({ records: practiceTrace, limit: 40 }, null, 2) + "\n",
    ).catch(() =>
      console.warn(
        "practice metadata diagnostic unavailable; primary result retained",
      ),
    );
  }
  releaseDeliveryGate();
  // Complete these route continuations before their browser context closes.
  await Promise.allSettled([...deliveryRouteTasks]);
  await browser.close();
  await vite.close();
}
