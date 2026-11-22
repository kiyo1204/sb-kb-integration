// Synthetic display fixtures only. No database, credentials or real participant data.
import assert from "node:assert/strict";
import { requestDigest } from "../src/client-identity";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Page, type Route } from "playwright";
import { createServer } from "vite";

type Scenario =
  | "login"
  | "login-error"
  | "login-pending"
  | "unpublished"
  | "waiting"
  | "ended"
  | "p02"
  | "legacy-session"
  | "researcher-populated";

const syntheticAccessCode = "SYNTHETIC_UI_ACCESS_CODE_ONLY_0000000000000001";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function syntheticSessionFlow(
  sessionId: string,
  protocolKey: "SBKB_INTEGRATION_V1" | "STAGE1_6",
  started: boolean,
) {
  const lesson = {
    id: "00000000-0000-4000-8000-000000000021",
    sessionId,
    stageType: "LESSON",
    orderIndex: 0,
    status: "PENDING",
    startedAt: null,
    completedAt: null,
    mapId: null,
  };
  return {
    session: {
      id: sessionId,
      status: started ? "IN_PROGRESS" : "NOT_STARTED",
      startedAt: started ? "2026-11-15T01:00:00.000Z" : null,
      completedAt: null,
      protocolKey,
      lessonVideoUrl: null,
      researchKitDefinitionId: null,
      studyGroup: null,
      groupActivitySeconds: null,
    },
    serverNow: "2026-11-15T01:00:00.000Z",
    currentMapSubmitted: false,
    currentIntegrationMapExists: false,
    currentMapAutoSubmittedAt: null,
    stages: started ? [lesson] : [],
    currentStage: started ? lesson : null,
    nextStage: null,
  };
}

async function installApiFixture(
  page: Page,
  scenario: Scenario,
  onAccessRequest?: () => Promise<void>,
) {
  let p02Started = false;
  let p02ActiveClient: string | null = null;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") {
      if (scenario === "login-pending") await onAccessRequest?.();
      if (scenario === "login-error")
        return json(route, { error: "synthetic_invalid_code" }, 401);
      if (scenario === "p02")
        return json(route, {
          role: "learner",
          sessionId: "00000000-0000-4000-8000-000000000001",
          protocolKey: "SBKB_INTEGRATION_V1",
          flowAvailable: true,
          runState: "RUNNING",
        });
      if (scenario === "legacy-session")
        return json(route, {
          role: "learner",
          sessionId: "00000000-0000-4000-8000-000000000003",
          protocolKey: "STAGE1_6",
          flowAvailable: true,
        });
      if (scenario.startsWith("researcher-") || scenario === "login" || scenario === "login-pending")
        return json(route, { role: "researcher" });
      return json(route, {
        role: "learner",
        sessionId: "00000000-0000-4000-8000-000000000001",
        protocolKey: "SBKB_INTEGRATION_V1",
        flowAvailable: scenario !== "unpublished",
        runState: scenario === "ended" ? "ENDED" : "PREPARING",
      });
    }
    if (path === "/api/health") return json(route, { database: true });
    if (path === "/api/experiment-status")
      return json(route, {
        state: scenario === "ended" ? "ENDED" : scenario === "p02" ? "RUNNING" : "PREPARING",
      });
    if (path === "/api/experiment-client/claim") {
      if (scenario === "p02") {
        const candidate = route.request().headers()["x-experiment-client"] ?? "";
        if (p02ActiveClient === null) p02ActiveClient = candidate;
        const ownsClient = candidate === p02ActiveClient;
        return json(
          route,
          {
            clientId: "00000000-0000-4000-8000-000000000002",
            ownership: ownsClient ? "OWNED" : "PENDING",
            deviceGeneration: ownsClient ? 0 : null,
            ...(!ownsClient ? { error: "experiment_client_in_use" } : {}),
          },
          ownsClient ? 200 : 409,
        );
      }
      return json(route, {
        clientId: "00000000-0000-4000-8000-000000000002",
        ownership: "OWNED",
        deviceGeneration: 0,
      });
    }
    if (scenario === "p02" && path === "/api/experiment-material")
      return json(route, {
        sbInstructions: "合成SB案内",
        kbInstructions: "合成KB案内",
        integrationInstructions: "合成統合案内",
      });
    if (scenario === "p02" && path === "/api/sessions/00000000-0000-4000-8000-000000000001/flow")
      return json(
        route,
        syntheticSessionFlow(
          "00000000-0000-4000-8000-000000000001",
          "SBKB_INTEGRATION_V1",
          p02Started,
        ),
      );
    if (
      scenario === "p02" &&
      path === "/api/sessions/00000000-0000-4000-8000-000000000001/start" &&
      route.request().method() === "POST"
    ) {
      p02Started = true;
      return json(route, { logSaved: true });
    }
    if (scenario === "legacy-session" && path === "/api/sessions/00000000-0000-4000-8000-000000000003/flow")
      return json(
        route,
        syntheticSessionFlow(
          "00000000-0000-4000-8000-000000000003",
          "STAGE1_6",
          false,
        ),
      );
    return json(
      route,
      { error: "experiment_not_running" },
      path === "/api/experiment-material" ? 409 : 200,
    );
  });
}

async function captureBeforeAfter(
  page: Page,
  name: string,
  width: number,
  directory: string,
) {
  for (const phase of ["before", "after"] as const) {
    const enabled = phase === "after";
    const count = await page.evaluate((isEnabled) => {
      const styles = document.querySelectorAll<HTMLStyleElement>(
        "style[data-vite-dev-id$='rehearsal-ui.css']",
      );
      for (const style of styles)
        if (style.sheet) style.sheet.disabled = !isEnabled;
      return styles.length;
    }, enabled);
    assert.ok(count > 0, "rehearsal-ui.css is present for comparison");
    await page.screenshot({
      path: join(
        directory,
        `${name}-${width}x${width === 1366 ? 768 : 900}-${phase}.png`,
      ),
      fullPage: true,
    });
    if (phase === "after") await assertNoHorizontalOverflow(page, name, width);
  }
}

async function assertNoHorizontalOverflow(page: Page, name: string, width: number) {
  const layout = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    if (scrollWidth <= viewportWidth) return { viewportWidth, scrollWidth, suspects: [] };

    const suspects: Array<{
      element: string;
      left: number;
      right: number;
      width: number;
      scrollWidth: number;
      clientWidth: number;
      minWidth: string;
      overflowX: string;
      clippedBy: string | null;
    }> = [];
    for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display === "none" || rect.width <= 0 || rect.right <= viewportWidth + 1) continue;
      let clippedBy: string | null = null;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        if (!/^(auto|scroll|hidden|clip)$/.test(ancestorStyle.overflowX)) continue;
        if (rect.right > ancestor.getBoundingClientRect().right + 1) {
          clippedBy = `${ancestor.tagName.toLowerCase()}${ancestor.id ? `#${ancestor.id}` : ""}.${Array.from(ancestor.classList).slice(0, 3).join(".")}`;
          break;
        }
      }
      suspects.push({
        element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${Array.from(element.classList).slice(0, 3).join(".")}`,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        minWidth: style.minWidth,
        overflowX: style.overflowX,
        clippedBy,
      });
    }
    suspects.sort((a, b) => Number(!!a.clippedBy) - Number(!!b.clippedBy) || b.right - a.right);
    return { viewportWidth, scrollWidth, suspects: suspects.slice(0, 16) };
  });
  assert.equal(
    layout.scrollWidth > layout.viewportWidth,
    false,
    `${name}: no horizontal overflow at ${width}px; layout=${JSON.stringify(layout)}`,
  );
}

// This event-level check intentionally uses synthetic HTML5 drag events.
// It exercises palette dragstart and Canvas dragover/drop handlers, not the native
// pointer-driven drag-and-drop path. Keep that limitation explicit in the test.
async function dispatchSyntheticKitLinkDrop(page: Page) {
  const { types, accepted } = await page.evaluate(() => {
    const linkPart = document.querySelector<HTMLButtonElement>(
      '.tutorial-practice-panel:not([hidden]) .kit-palette-part.is-link:not(:disabled)',
    );
    const canvas = document.querySelector<HTMLElement>(
      '.tutorial-practice-panel:not([hidden]) .concept-canvas',
    );
    if (!linkPart || !canvas) {
      throw new Error("Kitリンク部品またはCanvasが見つかりません");
    }

    const dataTransfer = new DataTransfer();
    linkPart.dispatchEvent(
      new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }),
    );

    const types = Array.from(dataTransfer.types);
    if (!types.includes("application/x-kbcm-kit-part")) {
      throw new Error(
        `ドラッグデータが生成されていません: ${JSON.stringify(types)}`,
      );
    }

    const rect = canvas.getBoundingClientRect();
    const x = rect.left + Math.min(90, rect.width / 2);
    const y = rect.top + Math.min(300, rect.height / 2);
    const dragOver = new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX: x,
      clientY: y,
    });
    canvas.dispatchEvent(dragOver);
    const accepted = dragOver.defaultPrevented;

    if (accepted) {
      canvas.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX: x,
          clientY: y,
        }),
      );
    }
    linkPart.dispatchEvent(
      new DragEvent("dragend", {
        bubbles: true,
        dataTransfer,
      }),
    );
    return { types, accepted };
  });

  assert.ok(
    types.includes("application/x-kbcm-kit-part"),
    "Kit link dragstart provides its expected MIME type",
  );
  assert.equal(accepted, true, "Canvas accepts the synthetic Kit link drop");
}

const directory = join(tmpdir(), "sbkb-ui-copy-common-terms-20261116");
await mkdir(directory, { recursive: true });
const vite = await createServer({
  cacheDir: join(directory, "vite-cache"),
  server: { host: "127.0.0.1", port: 0 },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  await vite.listen();
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL ?? "msedge",
  });

  for (const width of [1366, 1440]) {
    const height = width === 1366 ? 768 : 900;

    for (const state of ["login", "unpublished", "waiting", "ended"] as const) {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });
      if (state !== "login")
        await context.addInitScript(() =>
          sessionStorage.setItem(
            "stage1-access-token",
            "SYNTHETIC_LEARNER_TOKEN_ONLY",
          ),
        );
      const page = await context.newPage();
      await installApiFixture(page, state);
      await page.goto(vite.resolvedUrls!.local[0]!);
      const heading =
        state === "login"
          ? "アクセスコードを入力"
          : state === "unpublished"
            ? "学習者フローはまだ利用できません"
            : state === "ended"
              ? "実施は終了しました"
              : "実施の開始を待っています";
      await page.getByRole("heading", { name: heading }).waitFor();
      await captureBeforeAfter(page, `learner-${state}`, width, directory);
      if (state === "login") {
        const input = page.getByLabel("アクセスコード", { exact: true });
        assert.equal(await input.getAttribute("placeholder"), "アクセスコードを入力");
        assert.equal(await page.locator(".home-practice-card").count(), 0);
        assert.equal(
          await page.locator('a[href="/tutorial"]').count(),
          0,
          "signed-out code entry has no practice entry",
        );
        await input.focus();
        assert.equal(
          await input.evaluate((element) => getComputedStyle(element).outlineStyle),
          "solid",
        );
        await input.fill(syntheticAccessCode);
        const accessRequestStarted = page.waitForRequest(
          (request) => new URL(request.url()).pathname === "/api/me",
        );
        await page.getByRole("button", { name: "続行" }).click();
        const accessRequest = await accessRequestStarted;
        assert.equal(accessRequest.method(), "GET");
        assert.ok(
          (await accessRequest.headerValue("authorization"))?.startsWith("Bearer "),
          "existing access-code request still uses the Bearer header",
        );
        await page.getByRole("heading", { name: "研究者トップ" }).waitFor();
      }
      if (state === "ended")
        assert.equal(await page.locator(".map-editor-page").count(), 0);
      await context.close();
    }

    const learnerToken = syntheticAccessCode;
    const p02Context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    const p02Page = await p02Context.newPage();
    const p02ApiObservations: Array<{
      path: string;
      method: string;
      hasBearer: boolean;
    }> = [];
    const p02ClaimSecrets: string[] = [];
    p02Page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/experiment-client/claim")
        p02ClaimSecrets.push(request.headers()["x-experiment-client"] ?? "");
      if (path.startsWith("/api/"))
        p02ApiObservations.push({
          path,
          method: request.method(),
          hasBearer: (request.headers().authorization ?? "").startsWith("Bearer "),
        });
    });
    await installApiFixture(p02Page, "p02");
    await p02Page.goto(vite.resolvedUrls!.local[0]!);
    await p02Page.getByLabel("アクセスコード", { exact: true }).fill(learnerToken);
    await p02Page.getByRole("button", { name: "続行", exact: true }).click();
    await p02Page.getByRole("heading", { name: "活動の案内" }).waitFor();
    const practiceCard = p02Page.locator(".session-practice-card");
    assert.equal(await practiceCard.count(), 1);
    const practiceLink = practiceCard.getByRole("button", { name: /練習を開く/ });
    assert.equal(
      await p02Page.getByRole("button", { name: "セッションを開始", exact: true }).isEnabled(),
      false,
      "session start stays disabled until all three practice modes are completed",
    );
    assert.equal(await p02Page.locator(".map-editor-page").count(), 0);
    await assertNoHorizontalOverflow(p02Page, "p02-practice-card", width);
    await captureBeforeAfter(p02Page, "learner-p02-practice-card", width, directory);
    let practiceLinkKeyboardFocused = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      await p02Page.keyboard.press("Tab");
      if (await practiceLink.evaluate((element) => element.matches(":focus-visible"))) {
        practiceLinkKeyboardFocused = true;
        break;
      }
    }
    assert.equal(practiceLinkKeyboardFocused, true);
    assert.equal(
      await practiceLink.evaluate((element) => getComputedStyle(element).outlineStyle),
      "solid",
      "P02 practice card link has visible keyboard focus",
    );
    const beforeTutorialRequestIndex = p02ApiObservations.length;
    const claimsBeforePractice = p02ApiObservations.filter(request => request.path === "/api/experiment-client/claim").length;
    await practiceLink.click();
    assert.equal(new URL(p02Page.url()).pathname, "/");
    await p02Page.getByRole("heading", { name: "操作の練習" }).waitFor();
    await p02Page.getByRole("button", { name: "練習を終了", exact: true }).waitFor();
    assert.equal(
      await p02Page.getByRole("button", { name: "練習を終了", exact: true }).isDisabled(),
      true,
      "incomplete practice cannot be marked finished",
    );
    assert.equal(
      await p02Page.evaluate(() => sessionStorage.getItem("stage1-access-token")),
      learnerToken,
      "learner authentication survives entry to tutorial",
    );
    await p02Page.getByLabel("概念の名前").fill("合成練習概念");
    await p02Page.getByRole("button", { name: "概念を追加" }).click();
    assert.equal(await p02Page.locator(".concept-node").count(), 1);
    const tutorialRequests = p02ApiObservations.slice(beforeTutorialRequestIndex);

    const allowedPracticeReads = new Set([
      "/api/experiment-status",
      "/api/sessions/00000000-0000-4000-8000-000000000001/flow",
    ]);
    const unexpectedTutorialRequests = tutorialRequests.filter(
      (request) =>
        request.method !== "GET" ||
        !allowedPracticeReads.has(request.path),
    );

    assert.deepEqual(
      unexpectedTutorialRequests,
      [],
      "inline practice must not send mutations or unexpected API requests",
    );
    await p02Page.getByRole("button", { name: "案内へ戻る（練習未完了）" }).click();
    await p02Page.getByRole("heading", { name: "活動の案内" }).waitFor();
    assert.equal(await p02Page.locator(".session-practice-card").count(), 1);
    assert.equal(
      await p02Page.getByRole("button", { name: "セッションを開始", exact: true }).isDisabled(),
      true,
      "returning before finishing cannot unlock the session",
    );
    assert.equal(p02ApiObservations.filter(request => request.path === "/api/experiment-client/claim").length, claimsBeforePractice, "practice does not regenerate client registration (including StrictMode setup)");
    assert.equal(
      await p02Page.evaluate(() => sessionStorage.getItem("stage1-access-token")),
      learnerToken,
      "learner authentication and client registration survive inline return",
    );

    // F5 remains the same logical tab, and must use the same server-owned
    // client secret instead of registering a new (PENDING) device candidate.
    const originalClaimSecret = p02ClaimSecrets.at(-1);
    assert.ok(originalClaimSecret, "initial client claim contains a secret");
    const cacheKey = "sbkb-experiment-client-v1:00000000-0000-4000-8000-000000000001";
    const cachedIdentity = await p02Page.evaluate(key => sessionStorage.getItem(key), cacheKey);
    assert.ok(cachedIdentity, "F5 identity is cached in this tab");
    const claimsBeforeReload = p02ClaimSecrets.length;
    await p02Page.reload();
    await p02Page.getByRole("heading", { name: "活動の案内" }).waitFor();
    assert.ok(p02ClaimSecrets.length > claimsBeforeReload, "F5 rechecks the server binding");
    assert.equal(p02ClaimSecrets.at(-1), originalClaimSecret, "F5 reuses the existing client secret");
    assert.equal(await p02Page.evaluate(key => sessionStorage.getItem(key), cacheKey), cachedIdentity);

    // Duplicate-tab storage is copied, but it must never be treated as an
    // additional owner of the original secret (nor issue a claim request).
    const duplicatePage = await p02Context.newPage();
    await duplicatePage.addInitScript(({ token, key, value }) => {
      sessionStorage.setItem("stage1-access-token", token);
      sessionStorage.setItem(key, value);
    }, { token: learnerToken, key: cacheKey, value: cachedIdentity! });
    await installApiFixture(duplicatePage, "p02");
    let duplicateClaims = 0;
    duplicatePage.on("request", request => {
      if (new URL(request.url()).pathname === "/api/experiment-client/claim") duplicateClaims++;
    });
    await duplicatePage.goto(vite.resolvedUrls!.local[0]!);
    await duplicatePage.getByRole("heading", { name: "この画面は別タブで利用中です" }).waitFor();
    assert.equal(duplicateClaims, 0, "duplicate tab must not claim copied credentials");
    await duplicatePage.close();
    assert.equal(await p02Page.getByRole("heading", { name: "活動の案内" }).count(), 1);
    await p02Context.close();

    for (const failure of ["ended", "switched", "expired", "temporary-server", "temporary-network"] as const) {
      const guardContext = await browser.newContext({ viewport: { width, height } });
      await guardContext.addInitScript(token => sessionStorage.setItem("stage1-access-token", token), learnerToken);
      const guardPage = await guardContext.newPage();
      await installApiFixture(guardPage, "p02");
      await guardPage.goto(vite.resolvedUrls!.local[0]!);
      await guardPage.getByRole("button", { name: /練習を開く/ }).click();
      await guardPage.getByRole("heading", { name: "操作の練習", exact: true }).waitFor();
      const temporary = failure === "temporary-server" || failure === "temporary-network";
      if (temporary) {
        await guardPage.getByLabel("概念の名前").fill("通信復帰前の練習概念");
        await guardPage.getByRole("button", { name: "概念を追加" }).click();
        assert.equal(await guardPage.locator(".concept-node").count(), 1);
      }
      let canRecover = false;
      await guardPage.route("**/api/sessions/*/flow", route => {
        if (temporary) {
          if (!canRecover) {
            return failure === "temporary-server"
              ? json(route, { error: "safety_lookup_unavailable" }, 503)
              : route.abort("failed");
          }
          return json(route, syntheticSessionFlow("00000000-0000-4000-8000-000000000001", "SBKB_INTEGRATION_V1", false));
        }
        return json(route, {
          error: failure === "ended" ? "experiment_ended" : failure === "switched" ? "experiment_client_stale" : "authentication_required",
        }, failure === "expired" ? 401 : 409);
      });
      await guardPage.evaluate(() => window.dispatchEvent(new Event("focus")));
      if (temporary) {
        await guardPage.getByRole("heading", { name: "接続を再確認しています", exact: true }).waitFor();
        assert.equal(await guardPage.locator(".concept-node").count(), 1);
        assert.equal(await guardPage.getByRole("heading", { name: "利用状態を確認できません" }).count(), 0);
        canRecover = true;
        await guardPage.getByRole("button", { name: "接続状態を再確認" }).click();
        await guardPage.getByRole("heading", { name: "操作の練習", exact: true }).waitFor();
        assert.equal(await guardPage.locator(".concept-node").count(), 1, "temporary outage preserves local practice state");
      } else {
        await guardPage.getByRole("heading", { name: failure === "ended" ? "実施は終了しました" : "利用状態を確認できません", exact: true }).waitFor();
        assert.equal(await guardPage.getByRole("heading", { name: "操作の練習", exact: true }).count(), 0);
      }
      await guardContext.close();
    }

    // Initial material fetch 503 is retryable; no new client owner is claimed.
    const retryContext = await browser.newContext({ viewport: { width, height } });
    await retryContext.addInitScript(token => sessionStorage.setItem("stage1-access-token", token), learnerToken);
    const retryPage = await retryContext.newPage();
    await installApiFixture(retryPage, "p02");
    let materialRequests = 0;
    let allowMaterial = false;
    await retryPage.route("**/api/experiment-material", route => {
      materialRequests++;
      return !allowMaterial
        ? json(route, { error: "safety_lookup_unavailable" }, 503)
        : json(route, { sbInstructions: "合成SB案内", kbInstructions: "合成KB案内", integrationInstructions: "合成統合案内" });
    });
    await retryPage.goto(vite.resolvedUrls!.local[0]!);
    await retryPage.getByRole("heading", { name: "接続状態を確認できません", exact: true }).waitFor();
    allowMaterial = true;
    await retryPage.getByRole("heading", { name: "活動の案内" }).waitFor({ timeout: 25000 });
    assert.ok(materialRequests >= 2, "transient material fetch recovers automatically");
    await retryContext.close();

    const startContext = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await startContext.addInitScript(({ token, completionKey }) => {
      sessionStorage.setItem("stage1-access-token", token);
      // Synthetic fixture: this separate start-flow scenario assumes practice
      // was already completed. Real completion is tested by tutorial gestures.
      sessionStorage.setItem(completionKey, "1");
    }, {
      token: learnerToken,
      completionKey: `sbkb-practice-complete-v1:00000000-0000-4000-8000-000000000001:${requestDigest(learnerToken)}`,
    });
    const startPage = await startContext.newPage();
    await installApiFixture(startPage, "p02");
    await startPage.goto(vite.resolvedUrls!.local[0]!);
    await startPage.getByRole("heading", { name: "活動の案内" }).waitFor();
    assert.equal(
      await startPage.getByRole("button", { name: "セッションを開始", exact: true }).isEnabled(),
      true,
      "previously completed practice unlocks session start",
    );
    await startPage.reload();
    await startPage.getByRole("heading", { name: "活動の案内" }).waitFor();
    assert.equal(
      await startPage.getByRole("button", { name: "セッションを開始", exact: true }).isEnabled(),
      true,
      "same-tab F5 restores the previously completed practice start gate",
    );
    const sessionStart = startPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/sessions/00000000-0000-4000-8000-000000000001/start" &&
        response.request().method() === "POST",
    );
    await startPage.getByRole("button", { name: "セッションを開始", exact: true }).click();
    await sessionStart;
    await startPage.getByRole("button", { name: "開始する", exact: true }).waitFor();
    assert.equal(await startPage.getByRole("heading", { name: "活動の案内" }).count(), 0);
    assert.equal(await startPage.locator(".map-editor-page").count(), 0);
    await startContext.close();

    const legacyContext = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await legacyContext.addInitScript((token) => {
      sessionStorage.setItem("stage1-access-token", token);
    }, learnerToken);
    const legacyPage = await legacyContext.newPage();
    await installApiFixture(legacyPage, "legacy-session");
    await legacyPage.goto(vite.resolvedUrls!.local[0]!);
    await legacyPage.getByRole("button", { name: "セッションを開始", exact: true }).waitFor();
    assert.equal(await legacyPage.locator(".session-practice-card").count(), 0);
    assert.equal(
      await legacyPage.getByRole("link", { name: "操作の練習", exact: true }).getAttribute("href"),
      "/tutorial",
      "legacy protocol keeps its existing practice link",
    );
    await assertNoHorizontalOverflow(legacyPage, "legacy-session-guide", width);
    await legacyContext.close();

    const tutorialContext = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    const tutorialPage = await tutorialContext.newPage();
    // The 1440px run completes every practice task *inside* the P02 session,
    // then verifies the same-tab F5/start handoff. The 1366px run still tests
    // the standalone tutorial and performs the 390px native Kit gestures.
    const inlineP02 = width === 1440;
    const p02SessionId = "00000000-0000-4000-8000-000000000001";
    const p02FlowPath = `/api/sessions/${p02SessionId}/flow`;
    const tutorialApiRequests: Array<{ path: string; method: string }> = [];
    const tutorialClaimSecrets: string[] = [];
    tutorialPage.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/"))
        tutorialApiRequests.push({ path, method: request.method() });
      if (path === "/api/experiment-client/claim")
        tutorialClaimSecrets.push(request.headers()["x-experiment-client"] ?? "");
    });
    if (inlineP02) {
      await installApiFixture(tutorialPage, "p02");
      await tutorialPage.goto(vite.resolvedUrls!.local[0]!);
      await tutorialPage.getByLabel("アクセスコード", { exact: true }).fill(syntheticAccessCode);
      await tutorialPage.getByRole("button", { name: "続行", exact: true }).click();
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();
      assert.equal(
        await tutorialPage.getByRole("button", { name: "セッションを開始", exact: true }).isDisabled(),
        true,
        "P02 start is gated before all actual practice operations",
      );
      await tutorialPage.getByRole("button", { name: /練習を開く/ }).click();
    } else {
      await tutorialPage.goto(`${vite.resolvedUrls!.local[0]}tutorial`);
    }
    await tutorialPage.getByRole("heading", { name: "操作の練習" }).waitFor();
    const practiceRequestIndex = tutorialApiRequests.length;
    const tutorialClaimsBeforePractice = tutorialClaimSecrets.length;
    const activeTutorialPanel = tutorialPage.locator(".tutorial-practice-panel:not([hidden])");
    assert.equal(
      await tutorialPage.locator(".tutorial-practice-note").innerText(),
      "Scratch-Build → Kit-Build → 統合マップの順で、各段階のすべての操作を完了すると次へ進めます。完了した段階へはいつでも戻り、練習内容を続けて確認できます。",
      "practice introduction uses the shorter rehearsal-approved wording",
    );
    if (!inlineP02) assert.deepEqual(tutorialApiRequests, [], "standalone tutorial never calls the API");
    assert.equal(
      await tutorialPage.getByRole("button", { name: "練習を終了" }).isDisabled(),
      true,
      "practice cannot end before all three modes are complete",
    );
    assert.equal(
      await tutorialPage.getByRole("button", { name: "最初からやり直す" }).count(),
      0,
    );
    await captureBeforeAfter(tutorialPage, "tutorial-prior", width, directory);
    assert.equal(
      await tutorialPage
        .getByRole("button", { name: "Scratch-Buildの練習", exact: true })
        .getAttribute("aria-pressed"),
      "true",
      "初期状態ではScratch-Buildが選択されている",
    );
    assert.equal(await tutorialPage.getByRole("button", { name: "Kit-Buildの練習", exact: true }).isDisabled(), true);
    assert.equal(await tutorialPage.getByRole("button", { name: "統合マップの練習", exact: true }).isDisabled(), true);
    assert.equal(await tutorialPage.getByRole("button", { name: "次へ：Kit-Buildの練習", exact: true }).isDisabled(), true);
    await tutorialPage.getByLabel("概念の名前").fill("合成A");
    await tutorialPage.getByRole("button", { name: "概念を追加" }).click();
    assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 1);
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "1 / 6 件達成",
      "creating a saved local concept completes only the add task",
    );
    // Keep the first concept and finish SB without resetting the practice map.
    for (const label of ["合成B", "合成C"]) {
      await tutorialPage.getByLabel("概念の名前").fill(label);
      await tutorialPage.getByRole("button", { name: "概念を追加" }).click();
    }
    assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 3);
    await activeTutorialPanel.locator(".concept-node").first().click();
    await tutorialPage.getByLabel("選択した名前を編集").fill("合成A変更");
    await activeTutorialPanel.locator(".tutorial-edit").getByRole("button", { name: "変更" }).click();
    const moving = await activeTutorialPanel.locator(".concept-node").first().boundingBox();
    assert.ok(moving, "first SB concept has a bounding box");
    await tutorialPage.mouse.move(moving.x + 30, moving.y + 30);
    await tutorialPage.mouse.down();
    await tutorialPage.mouse.move(moving.x + 100, moving.y + 75, { steps: 6 });
    await tutorialPage.mouse.up();
    await tutorialPage.getByLabel("リンクの名前").fill("合成リンク");
    await tutorialPage.getByRole("button", { name: "リンクを追加" }).click();

    const connectTemporary = async (source: number, target: number) => {
      await activeTutorialPanel.locator(".link-connector.is-temporary .link-connector-handle.is-source")
        .first().dragTo(activeTutorialPanel.locator(".concept-node").nth(source));
      await activeTutorialPanel.locator(".link-connector.is-temporary .link-connector-handle.is-target")
        .first().dragTo(activeTutorialPanel.locator(".concept-node").nth(target));
      await activeTutorialPanel.locator(".link-connector.is-temporary").first()
        .waitFor({ state: "detached" });
    };
    await connectTemporary(0, 1);
    await activeTutorialPanel.locator(".link-connector:not(.is-temporary) .link-connector-handle.is-target")
      .first().dragTo(activeTutorialPanel.locator(".concept-node").nth(2));
    await activeTutorialPanel.locator(".concept-node").nth(2).click();
    await tutorialPage.getByRole("button", { name: "選択した要素を削除" }).click();
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "6 / 6 件達成",
      "all six SB tasks are completed by actual interactions",
    );
    assert.equal(await tutorialPage.getByRole("button", { name: "統合マップの練習", exact: true }).isDisabled(), true);
    await tutorialPage.getByRole("button", { name: "次へ：Kit-Buildの練習", exact: true }).click();
    await tutorialPage.getByRole("heading", { name: "Kit-Buildの練習" }).waitFor();
    assert.equal(
      await activeTutorialPanel.getByRole("searchbox", { name: "キット一覧を検索" }).count(),
      1, "Kit-Build practice palette uses the new kit wording",
    );
    assert.match(
      await activeTutorialPanel.locator(".tutorial-practice-description").innerText(),
      /キット一覧から概念とリンクをマップへ追加/,
    );
    assert.equal(await tutorialPage.getByRole("button", { name: "Scratch-Buildの練習", exact: true }).isDisabled(), false);
    assert.equal(await tutorialPage.getByRole("button", { name: "統合マップの練習", exact: true }).isDisabled(), true);
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "0 / 3 件達成",
    );
    await captureBeforeAfter(tutorialPage, "tutorial-kit-build", width, directory);
    // At one desktop iteration, run the *real* Kit pointer drag/connect sequence
    // at mobile width. The other iteration retains its desktop coverage.
    // Keep the entire 960px Map canvas scrollable within the narrow viewport.
    if (width === 1366) {
      await tutorialPage.setViewportSize({ width: 390, height: 844 });
      await assertNoHorizontalOverflow(tutorialPage, "mobile kit before gestures", 390);
    }
    assert.equal(await activeTutorialPanel.locator(".tutorial-tools form").count(), 0);
    const canvas = activeTutorialPanel.locator(".concept-canvas");

    // Native mobile-width mouse drag: put the palette item and drop point in
    // the visible browser viewport before starting. Locator.dragTo() may
    // re-scroll the tall page to center the 960px Canvas, hiding the palette.
    const dragVisibleMobileKitPart = async (
      part: ReturnType<typeof activeTutorialPanel.locator>,
      dropX: number,
      dropY: number,
    ) => {
      const mapViewport = activeTutorialPanel.locator(".concept-canvas-viewport");
      // Center the desired Canvas coordinate in its *internal* horizontal scroll.
      await mapViewport.evaluate((element, x) => {
        element.scrollLeft = Math.max(0, x - element.clientWidth / 2);
      }, dropX);
      const before = await part.boundingBox();
      assert.ok(before, "mobile Kit palette item exists");
      // Place the source near the top; the Canvas then remains lower in view.
      await tutorialPage.evaluate((sourceY) => {
        window.scrollBy(0, sourceY - 100);
      }, before.y);
      const source = await part.boundingBox();
      const target = await canvas.boundingBox();
      const clip = await mapViewport.boundingBox();
      assert.ok(source && target && clip, "mobile Kit drag elements have bounds");
      const fromX = source.x + source.width / 2;
      const fromY = source.y + source.height / 2;
      const toX = target.x + dropX;
      const toY = target.y + dropY;
      const visible =
        fromX > 2 && fromX < 388 && fromY > 2 && fromY < 842 &&
        toX > clip.x + 2 && toX < clip.x + clip.width - 2 &&
        toY > clip.y + 2 && toY < clip.y + clip.height - 2 &&
        toY > 2 && toY < 842;
      assert.ok(visible,
        `mobile Kit drag source/target must both be visible: ${JSON.stringify({ source, target, clip, fromX, fromY, toX, toY })}`,
      );
      // Actual pointer movement: no synthetic DragEvent or direct callback.
      await tutorialPage.mouse.move(fromX, fromY);
      await tutorialPage.mouse.down();
      await tutorialPage.mouse.move(fromX + 8, fromY + 8, { steps: 3 });
      await tutorialPage.mouse.move(toX, toY, { steps: 20 });
      await tutorialPage.mouse.up();
    };

    // Playwright may horizontally center the 960px Canvas while preparing dragTo.
    // Drop near its center so the native pointer target stays inside the
    // narrow viewport even after that automatic scrolling.
    for (const [index, x, y] of (width === 1366 ? [
      [0, 480, 90],
      [1, 480, 220],
      [2, 480, 350],
    ] : [
      [0, 150, 130],
      [1, 440, 170],
      [2, 720, 130],
    ])) {
      const part = activeTutorialPanel
        .locator(".kit-palette-part.is-concept")
        .nth(index);

      const expected = index + 1;

      for (let attempt = 0; attempt < 2; attempt++) {
        if (width === 1366) {
          await dragVisibleMobileKitPart(part, x, attempt === 0 ? y : Math.min(y + 40, 320));
        } else {
          await part.dragTo(canvas, {
            targetPosition: { x, y: attempt === 0 ? y : 390 },
            steps: 16,
          });
        }

        try {
          await tutorialPage.waitForFunction(
            (count) =>
              document.querySelectorAll(".tutorial-practice-panel:not([hidden]) .concept-node").length >= count,
            expected,
            { timeout: 2000 }
          );
          break;
        } catch {
          // 初回の配置が成立しなかった場合だけ再試行
        }
      }

      const actual = await activeTutorialPanel.locator(".concept-node").count();

      if (actual !== expected) {
        const feedback = await activeTutorialPanel
          .locator(".kit-palette-feedback")
          .allInnerTexts();
        const viewport = await activeTutorialPanel.locator(".concept-canvas-viewport")
          .evaluate((element) => ({
            scrollLeft: element.scrollLeft,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            left: element.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right,
          }));
        const partBox = await part.boundingBox();
        const canvasBox = await canvas.boundingBox();

        throw new Error(
          `KB概念 ${expected} 個目の配置に失敗しました。\n` +
          `実際の概念数: ${actual}\n` +
          `配置結果: ${JSON.stringify(feedback)}\n` +
          `viewport: ${JSON.stringify(viewport)}\n` +
          `part: ${JSON.stringify(partBox)}\n` +
          `canvas: ${JSON.stringify(canvasBox)}`
        );
      }
    }
    assert.equal(
      await activeTutorialPanel.locator(".kit-palette-part.is-link").first().isEnabled(),
      true,
      "KBリンク部品が使用可能である",
    );

    // Keep the link's central handle in the same visible Canvas region on mobile.
    const kitLinkPart = activeTutorialPanel.locator(".kit-palette-part.is-link").first();
    if (width === 1366) {
      await dragVisibleMobileKitPart(kitLinkPart, 480, 30);
    } else {
      await kitLinkPart.dragTo(canvas, {
        targetPosition: { x: 30, y: 30 },
        steps: 16,
      });
    }

    const temporaryLink = activeTutorialPanel.locator(".link-connector.is-temporary");

    if (await temporaryLink.count() === 0) {
      const feedback = await activeTutorialPanel
        .locator(".kit-palette-feedback")
        .allInnerTexts();

      const linkParts = await activeTutorialPanel
        .locator(".kit-palette-part.is-link")
        .allInnerTexts();

      throw new Error(
        "KBのリンク部品がCanvasへ配置されていません。\n" +
        `パレットの状態: ${JSON.stringify(linkParts)}\n` +
        `配置結果: ${JSON.stringify(feedback)}`
      );
    }

    await connectTemporary(0, 1);
    await activeTutorialPanel.locator(".link-connector:not(.is-temporary) .link-connector-handle.is-target")
      .first().dragTo(activeTutorialPanel.locator(".concept-node").nth(2));
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "3 / 3 件達成",
      "all three KB tasks are completed by actual interactions",
    );
    if (width === 1366) {
      await assertNoHorizontalOverflow(tutorialPage, "mobile kit after gestures", 390);
      await tutorialPage.setViewportSize({ width, height });
    }
    await tutorialPage.getByRole("button", { name: "次へ：統合マップの練習", exact: true }).click();
    await tutorialPage.getByRole("heading", { name: "統合マップの練習" }).waitFor();
    assert.equal(
      await activeTutorialPanel.locator(".tutorial-practice-description").count(),
      0, "the integration practice description below the heading is removed",
    );
    assert.equal(
      await activeTutorialPanel.getByRole("searchbox", { name: "キット一覧を検索" }).count(),
      1, "integration practice uses the kit-list wording too",
    );
    assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 2);
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "0 / 7 件達成",
    );
    const mergePanel = tutorialPage.getByRole("region", { name: "Concept Merge" });
    await mergePanel.getByLabel("Concept A").selectOption("practice-sb-a");
    await mergePanel.getByLabel("Concept B").selectOption("practice-sb-b");
    await mergePanel.getByLabel("Merge後のlabel").fill("点AB");
    tutorialPage.once("dialog", async (dialog) => dialog.accept());
    await mergePanel.getByRole("button", { name: "Merge", exact: true }).click();
    assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 1);
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "1 / 7 件達成",
    );
    await tutorialPage.getByRole("button", { name: "元に戻す（Undo）" }).click();
    assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 2);
    await tutorialPage.getByRole("button", { name: "やり直す（Redo）" }).click();
    assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 1);
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "3 / 7 件達成",
    );
    const mergedNode = activeTutorialPanel.locator(".concept-node").first();
    await mergedNode.click();
    const releaseButton = tutorialPage.getByRole("button", {
      name: "Merge結果を削除して1段階解除",
    });
    await releaseButton.waitFor();
    tutorialPage.once("dialog", async (dialog) => dialog.accept());
    await releaseButton.click();
    assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 2);
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "4 / 7 件達成",
    );
    assert.equal(await tutorialPage.getByText("すべてのマップの操作練習が完了しました。").count(), 0);
    const integrationCanvas = activeTutorialPanel.locator(".concept-canvas");

    const kitConceptPart = activeTutorialPanel
      .locator(".kit-palette-part.is-concept")
      .first();

    assert.equal(
      await kitConceptPart.getAttribute("draggable"),
      "true",
      "統合マップのKit概念がドラッグ可能である",
    );

    // Canvasの左上寄りにドロップする
    await kitConceptPart.dragTo(integrationCanvas, {
      targetPosition: { x: 30, y: 30 },
      steps: 16,
    });

    // Kitから取り込んだ「形」の概念を確認
    const integrationKitConcept = activeTutorialPanel
      .locator(".concept-node")
      .filter({ hasText: "形" });

    try {
      await integrationKitConcept.waitFor({
        state: "visible",
        timeout: 5000,
      });
    } catch {
      const feedback = await activeTutorialPanel
        .locator(".kit-palette-feedback")
        .allInnerTexts();

      const concepts = await activeTutorialPanel
        .locator(".concept-node")
        .allInnerTexts();

      throw new Error(
        "統合マップでKit概念「形」を取り込めませんでした。\n" +
        `概念一覧: ${JSON.stringify(concepts)}\n` +
        `配置結果: ${JSON.stringify(feedback)}`
      );
    }
    const integrationLinkPart = activeTutorialPanel
      .locator(".kit-palette-part.is-link")
      .first();

    assert.equal(
      await integrationLinkPart.isEnabled(),
      true,
      "統合マップのKitリンクが使用可能である",
    );

    // This uses synthetic DOM drag events: it verifies the event handlers,
    // but does not verify a user's physical drag-and-drop gesture.
    await dispatchSyntheticKitLinkDrop(tutorialPage);

    // 未接続リンクが生成されたことを確認
    const integrationTemporarySource = activeTutorialPanel
      .locator(".link-connector.is-temporary .link-connector-handle.is-source")
      .first();

    try {
      await integrationTemporarySource.waitFor({
        state: "visible",
        timeout: 5000,
      });
    } catch {
      const feedback = await activeTutorialPanel
        .locator(".kit-palette-feedback")
        .allInnerTexts();

      const linkParts = await activeTutorialPanel
        .locator(".kit-palette-part.is-link")
        .allInnerTexts();

      throw new Error(
        "統合マップのKitリンクが配置されませんでした。\n" +
        `リンク部品: ${JSON.stringify(linkParts)}\n` +
        `配置結果: ${JSON.stringify(feedback)}`
      );
    }

    await connectTemporary(0, 1);
    await activeTutorialPanel
      .locator(".link-connector:not(.is-temporary) .link-connector-handle.is-target")
      .first()
      .dragTo(integrationKitConcept);
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "7 / 7 件達成",
    );
    await tutorialPage.getByText("すべてのマップの操作練習が完了しました。").waitFor();
    assert.equal(await tutorialPage.getByRole("button", { name: "練習を終了", exact: true }).isEnabled(), true);
    await tutorialPage.getByRole("button", { name: "Scratch-Buildの練習", exact: true }).click();
    await tutorialPage.getByRole("heading", { name: "Scratch-Buildの練習" }).waitFor();
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "6 / 6 件達成",
    );
    assert.ok(await activeTutorialPanel.locator(".concept-node").count() > 0, "SB map is retained");
    await tutorialPage.getByRole("button", { name: "Kit-Buildの練習", exact: true }).click();
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "3 / 3 件達成",
    );
    assert.equal(await activeTutorialPanel.locator(".concept-node").count(), 3, "KB map is retained");
    await tutorialPage.getByRole("button", { name: "統合マップの練習", exact: true }).click();
    assert.equal(
      await activeTutorialPanel.locator('.tutorial-task-progress [role="status"]').innerText(),
      "7 / 7 件達成",
    );
    if (inlineP02) {
      const allowedPracticeReads = new Set(["/api/experiment-status", p02FlowPath]);
      assert.deepEqual(
        tutorialApiRequests.slice(practiceRequestIndex).filter(
          (request) => request.method !== "GET" || !allowedPracticeReads.has(request.path),
        ),
        [],
        "actual three-mode P02 practice makes no research writes or unexpected API calls",
      );
      assert.equal(
        tutorialClaimSecrets.length,
        tutorialClaimsBeforePractice,
        "actual practice never registers another experiment client",
      );
    } else {
      assert.deepEqual(tutorialApiRequests, [], "standalone three-mode practice makes no API requests");
    }
    await tutorialPage.getByRole("button", { name: "練習を終了", exact: true }).click();
    if (inlineP02) {
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();
      const startButton = tutorialPage.getByRole("button", { name: "セッションを開始", exact: true });
      assert.equal(await startButton.isEnabled(), true, "actual completion unlocks P02 start");
      const completionKey = `sbkb-practice-complete-v1:${p02SessionId}:${requestDigest(syntheticAccessCode)}`;
      assert.equal(
        await tutorialPage.evaluate((key) => sessionStorage.getItem(key), completionKey),
        "1",
        "real practice finish records only the tab-local completion marker",
      );
      assert.equal(
        await tutorialPage.evaluate(() => sessionStorage.getItem("stage1-access-token")),
        syntheticAccessCode,
        "the access token survives actual practice completion",
      );
      const claimSecret = tutorialClaimSecrets.at(-1);
      assert.ok(claimSecret, "P02 has an existing experiment client identity");
      const clientKey = `sbkb-experiment-client-v1:${p02SessionId}`;
      const clientState = await tutorialPage.evaluate((key) => sessionStorage.getItem(key), clientKey);
      assert.ok(clientState, "same-tab client ownership is stored before F5");
      const claimsBeforeF5 = tutorialClaimSecrets.length;
      await tutorialPage.reload();
      await tutorialPage.getByRole("heading", { name: "活動の案内" }).waitFor();
      assert.ok(tutorialClaimSecrets.length > claimsBeforeF5, "F5 rechecks client ownership");
      assert.equal(tutorialClaimSecrets.at(-1), claimSecret, "F5 reuses the original client identity");
      assert.equal(await tutorialPage.evaluate((key) => sessionStorage.getItem(key), clientKey), clientState);
      assert.equal(await tutorialPage.evaluate((key) => sessionStorage.getItem(key), completionKey), "1");
      assert.equal(await startButton.isEnabled(), true, "actual completion survives F5");

      const startPath = `/api/sessions/${p02SessionId}/start`;
      const requestIndexBeforeStart = tutorialApiRequests.length;
      const started = tutorialPage.waitForResponse(
        (response) => new URL(response.url()).pathname === startPath && response.request().method() === "POST",
      );
      await startButton.click();
      assert.equal((await started).ok(), true, "session starts after real practice and F5");
      await tutorialPage.getByRole("button", { name: "開始する", exact: true }).waitFor();
      assert.deepEqual(
        tutorialApiRequests.slice(requestIndexBeforeStart).filter((request) => request.method !== "GET"),
        [{ path: startPath, method: "POST" }],
        "only the expected session start mutates the synthetic API",
      );
    } else {
      await tutorialPage.waitForURL(vite.resolvedUrls!.local[0]!);
    }
    await tutorialContext.close();

    const homeContext = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await homeContext.addInitScript(() =>
      sessionStorage.setItem(
        "stage1-access-token",
        "SYNTHETIC_RESEARCHER_TOKEN_ONLY",
      ),
    );
    const homePage = await homeContext.newPage();
    await installApiFixture(homePage, "researcher-populated");
    await homePage.goto(vite.resolvedUrls!.local[0]!);
    await homePage.getByRole("heading", { name: "研究者トップ" }).waitFor();
    assert.equal(await homePage.getByLabel("アクセスコード").count(), 0);
    assert.equal(await homePage.locator(".home-research-primary-grid .home-workflow-card").count(), 2);
    assert.equal(await homePage.getByRole("heading", { name: "教材を管理" }).count(), 1);
    assert.equal(await homePage.getByRole("heading", { name: "実施を管理" }).count(), 1);
    assert.equal(await homePage.getByRole("heading", { name: "実施の結果を確認" }).count(), 1);
    assert.equal(await homePage.getByRole("heading", { name: "システム状態", exact: true }).count(), 1);
    assert.equal(
      await homePage
        .getByRole("link", { name: /教材管理を開く/ })
        .getAttribute("href"),
      "/research/materials",
    );
    assert.equal(
      await homePage
        .getByRole("link", { name: /実施一覧を開く/ })
        .getAttribute("href"),
      "/research/experiment-runs",
    );
    // Researcher home exposes only the current management workflow.
    // Legacy Session data and researcher-only APIs remain available by direct route.
    for (const path of [
      "/research/stage1/new",
      "/research/data-management",
      "/research/events",
      "/research/event-exports",
    ]) {
      assert.equal(
        await homePage.locator(`a[href="${path}"]`).count(),
        0,
        `obsolete researcher-home entry ${path} must be absent`,
      );
    }
    assert.equal(
      await homePage.getByText("旧フローの作成", { exact: true }).count(),
      0,
    );
    assert.equal(
      await homePage.getByText("研究データ・ログ", { exact: true }).count(),
      0,
    );
    assert.equal(
      await homePage.locator('a[href="/research/goal-maps"]').count(),
      1,
    );
    assert.equal(
      await homePage
        .locator('a[href="/research/goal-maps"]')
        .isVisible(),
      true,
    );
    assert.equal(
      await homePage.locator(".research-session-list").count(),
      0,
      "old mixed-protocol Session listing is retired",
    );
    await captureBeforeAfter(
      homePage,
      "researcher-home-populated",
      width,
      directory,
    );
    await homePage.locator('a[href="/research/materials"]').focus();
    assert.equal(
      await homePage
        .locator('a[href="/research/materials"]')
        .evaluate((element) => getComputedStyle(element).outlineStyle),
      "solid",
      "main researcher navigation has a visible keyboard focus",
    );
    await homeContext.close();
  }

  for (const width of [1366, 1440]) {
    const height = width === 1366 ? 768 : 900;
    const errorContext = await browser.newContext({ viewport: { width, height } });
    const errorPage = await errorContext.newPage();
    await installApiFixture(errorPage, "login-error");
    await errorPage.goto(vite.resolvedUrls!.local[0]!);
    await errorPage.getByLabel("アクセスコード", { exact: true }).fill(syntheticAccessCode);
    await errorPage.getByRole("button", { name: "続行" }).click();
    await errorPage.getByRole("alert").getByText(/コードを確認できませんでした/).waitFor();
    assert.equal(await errorPage.getByRole("heading", { name: "アクセスコードを入力" }).count(), 1);
    await assertNoHorizontalOverflow(errorPage, "login-error", width);
    await errorContext.close();

    let releaseAccessRequest = () => {};
    const pending = new Promise<void>((resolve) => {
      releaseAccessRequest = resolve;
    });
    const pendingContext = await browser.newContext({ viewport: { width, height } });
    const pendingPage = await pendingContext.newPage();
    await installApiFixture(pendingPage, "login-pending", async () => {
      await pending;
    });
    await pendingPage.goto(vite.resolvedUrls!.local[0]!);
    await pendingPage.getByLabel("アクセスコード", { exact: true }).fill(syntheticAccessCode);
    const pendingRequest = pendingPage.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/me",
    );
    await pendingPage.getByRole("button", { name: "続行" }).click();
    await pendingRequest;
    assert.equal(await pendingPage.getByRole("button", { name: "確認中…" }).isDisabled(), true);
    await pendingPage.getByRole("status").getByText("コードを確認しています…").waitFor();
    await assertNoHorizontalOverflow(pendingPage, "login-pending", width);
    releaseAccessRequest();
    await pendingPage.getByRole("heading", { name: "研究者トップ" }).waitFor();
    await pendingContext.close();
  }

  // Narrow-screen smoke test uses isolated API fixtures and never touches a DB.
  // The desktop gesture suite above still covers the full three-mode exercise.
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  const mobilePage = await mobileContext.newPage();
  const mobileApiRequests: Array<{ path: string; method: string }> = [];
  mobilePage.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/"))
      mobileApiRequests.push({ path, method: request.method() });
  });
  await installApiFixture(mobilePage, "p02");
  await mobilePage.goto(vite.resolvedUrls!.local[0]!);
  await mobilePage.getByLabel("アクセスコード", { exact: true }).fill(syntheticAccessCode);
  await mobilePage.getByRole("button", { name: "続行", exact: true }).click();
  await mobilePage.getByRole("heading", { name: "活動の案内" }).waitFor();
  await assertNoHorizontalOverflow(mobilePage, "P02 mobile entry", 390);
  assert.equal(
    await mobilePage.getByRole("button", { name: "セッションを開始", exact: true }).isDisabled(),
    true,
  );
  const beforeMobilePractice = mobileApiRequests.length;
  await mobilePage.getByRole("button", { name: /練習を開く/ }).click();
  await mobilePage.getByRole("heading", { name: "操作の練習" }).waitFor();
  await assertNoHorizontalOverflow(mobilePage, "mobile practice", 390);
  for (const label of ["Scratch-Buildの練習", "Kit-Buildの練習", "統合マップの練習"]) {
    assert.equal(
      await mobilePage.getByRole("button", { name: label, exact: true }).isVisible(),
      true,
      `${label} is visible at 390px`,
    );
  }
  assert.equal(
    await mobilePage.getByRole("button", { name: "Kit-Buildの練習", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await mobilePage.getByRole("button", { name: "練習を終了", exact: true }).isDisabled(),
    true,
  );
  await mobilePage.getByLabel("概念の名前").fill("390px合成概念");
  await mobilePage.getByRole("button", { name: "概念を追加" }).click();
  assert.equal(await mobilePage.locator(".tutorial-practice-panel:not([hidden]) .concept-node").count(), 1);
  await assertNoHorizontalOverflow(mobilePage, "mobile practice after concept creation", 390);
  const mobilePracticeRequests = mobileApiRequests.slice(beforeMobilePractice);
  assert.deepEqual(
    mobilePracticeRequests.filter((request) => request.method !== "GET"),
    [],
    "mobile practice must not issue API mutations",
  );
  await mobilePage.getByRole("button", { name: "案内へ戻る（練習未完了）" }).click();
  await mobilePage.getByRole("heading", { name: "活動の案内" }).waitFor();
  assert.equal(
    await mobilePage.getByRole("button", { name: "セッションを開始", exact: true }).isDisabled(),
    true,
  );
  await assertNoHorizontalOverflow(mobilePage, "P02 mobile return", 390);
  await mobileContext.close();

  console.log(
    `Rehearsal UI: PASS (signed-out code entry without practice card; P02 inline practice/return with unchanged client claims and no learning writes; precompleted start gate survives F5; 390px P02/practice smoke; normal start and historical session compatibility preserved; unpublished/waiting/ended; researcher states; Edge synthetic fixtures at 1366x768 and 1440x900; screenshots: ${directory}; no real API or DB persistence verified)`,
  );
} finally {
  await browser?.close();
  await vite.close();
}
