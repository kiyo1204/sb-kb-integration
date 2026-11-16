// Synthetic display fixtures only. No database, credentials or real participant data.
import assert from "node:assert/strict";
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
  | "researcher-populated"
  | "researcher-empty"
  | "researcher-loading"
  | "researcher-error";

const syntheticSessions = [
  {
    id: "00000000-0000-4000-8000-000000000011",
    participantCode: "合成A",
    studyGroup: null,
    status: "COMPLETED",
    protocolKey: "SBKB_INTEGRATION_V1",
    currentStageType: null,
    currentStageOrder: null,
    startedAt: "2026-11-14T01:00:00.000Z",
    completedAt: "2026-11-14T01:45:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000012",
    participantCode: "合成B",
    studyGroup: "CONTROL",
    status: "IN_PROGRESS",
    protocolKey: "STAGE1_6",
    currentStageType: "PRIOR_MAP",
    currentStageOrder: 2,
    startedAt: "2026-11-14T02:00:00.000Z",
    completedAt: null,
  },
];
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
  onSessionListRequest?: () => Promise<void>,
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
    if (path === "/api/research/stage1/sessions") {
      await onSessionListRequest?.();
      if (scenario === "researcher-error")
        return json(route, { error: "synthetic_unavailable" }, 503);
      return json(route, {
        sessions: scenario === "researcher-populated" ? syntheticSessions : [],
      });
    }
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
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    `${name}: no horizontal overflow at ${width}px`,
  );
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
    p02Page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
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
    await p02Page.getByRole("heading", { name: "P02：活動の案内" }).waitFor();
    const practiceCard = p02Page.locator(".session-practice-card");
    assert.equal(await practiceCard.count(), 1);
    const practiceLink = practiceCard.getByRole("button", { name: /練習を開く/ });
    assert.equal(
      await p02Page.getByRole("button", { name: "セッションを開始", exact: true }).isEnabled(),
      true,
      "practice is optional and the normal start action remains available",
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
    await p02Page.waitForFunction(
      (sessionId) =>
        Array.from(document.querySelectorAll("a")).some(
          (link) => link.textContent?.includes("練習を終了") && link.getAttribute("href") === `/sessions/${sessionId}`,
        ),
      "00000000-0000-4000-8000-000000000001",
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
    assert.equal(
      tutorialRequests.some((request) => request.method !== "GET" || !request.path.endsWith("/flow")),
      false,
      "inline practice only reads existing flow access; no learning/map/logging writes",
    );
    assert.equal(
      await p02Page.getByRole("link", { name: "練習を終了" }).getAttribute("href"),
      "/sessions/00000000-0000-4000-8000-000000000001",
      "tutorial return points to this learner's session",
    );
    await p02Page.getByRole("link", { name: "練習を終了" }).click();
    await p02Page.getByRole("heading", { name: "P02：活動の案内" }).waitFor();
    assert.equal(await p02Page.locator(".session-practice-card").count(), 1);
    assert.equal(p02ApiObservations.filter(request => request.path === "/api/experiment-client/claim").length, claimsBeforePractice, "practice does not regenerate client registration (including StrictMode setup)");
    assert.equal(
      await p02Page.evaluate(() => sessionStorage.getItem("stage1-access-token")),
      learnerToken,
      "learner authentication and client registration survive inline return",
    );
    await p02Context.close();

    for (const failure of ["ended", "switched", "expired"] as const) {
      const guardContext = await browser.newContext({ viewport: { width, height } });
      await guardContext.addInitScript(token => sessionStorage.setItem("stage1-access-token", token), learnerToken);
      const guardPage = await guardContext.newPage();
      await installApiFixture(guardPage, "p02");
      await guardPage.goto(vite.resolvedUrls!.local[0]!);
      await guardPage.getByRole("button", { name: /練習を開く/ }).click();
      await guardPage.getByRole("heading", { name: "操作の練習", exact: true }).waitFor();
      await guardPage.route("**/api/sessions/*/flow", route => json(route, {
        error: failure === "ended" ? "experiment_ended" : failure === "switched" ? "experiment_client_stale" : "authentication_required",
      }, failure === "expired" ? 401 : 409));
      await guardPage.evaluate(() => window.dispatchEvent(new Event("focus")));
      await guardPage.getByRole("heading", { name: failure === "ended" ? "実施は終了しました" : "利用状態を確認できません", exact: true }).waitFor();
      assert.equal(await guardPage.getByRole("heading", { name: "操作の練習", exact: true }).count(), 0);
      await guardContext.close();
    }

    const startContext = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await startContext.addInitScript((token) => {
      sessionStorage.setItem("stage1-access-token", token);
    }, learnerToken);
    const startPage = await startContext.newPage();
    await installApiFixture(startPage, "p02");
    await startPage.goto(vite.resolvedUrls!.local[0]!);
    await startPage.getByRole("heading", { name: "P02：活動の案内" }).waitFor();
    const sessionStart = startPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/sessions/00000000-0000-4000-8000-000000000001/start" &&
        response.request().method() === "POST",
    );
    await startPage.getByRole("button", { name: "セッションを開始", exact: true }).click();
    await sessionStart;
    await startPage.getByRole("button", { name: "開始する", exact: true }).waitFor();
    assert.equal(await startPage.getByRole("heading", { name: "P02：活動の案内" }).count(), 0);
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
    const tutorialApiRequests: string[] = [];
    tutorialPage.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        tutorialApiRequests.push(new URL(request.url()).pathname);
    });
    await tutorialPage.goto(`${vite.resolvedUrls!.local[0]}tutorial`);
    await tutorialPage.getByRole("heading", { name: "操作の練習" }).waitFor();
    assert.match(
      await tutorialPage.locator(".tutorial-heading").innerText(),
      /通常の学習Sessionとは別.*保存しません/s,
    );
    assert.equal(
      tutorialApiRequests.length,
      0,
      "tutorial does not call the API",
    );
    assert.equal(
      await tutorialPage
        .getByRole("link", { name: "練習を終了" })
        .getAttribute("href"),
      "/",
    );
    await captureBeforeAfter(tutorialPage, "tutorial-prior", width, directory);
    assert.equal(
      await tutorialPage
        .getByRole("button", { name: "マップ作成の練習" })
        .getAttribute("aria-pressed"),
      "true",
    );
    await tutorialPage.getByLabel("概念の名前").fill("合成概念");
    await tutorialPage.getByRole("button", { name: "概念を追加" }).click();
    assert.equal(await tutorialPage.locator(".concept-node").count(), 1);
    await tutorialPage
      .getByRole("button", { name: "最初からやり直す" })
      .click();
    assert.equal(await tutorialPage.locator(".concept-node").count(), 0);
    await tutorialPage.getByRole("button", { name: "Kit-Buildの練習" }).click();
    assert.equal(
      await tutorialPage
        .getByRole("heading", { name: "Kit-Buildの練習" })
        .count(),
      1,
    );
    await captureBeforeAfter(
      tutorialPage,
      "tutorial-kit-build",
      width,
      directory,
    );
    assert.equal(
      await tutorialPage
        .getByRole("button", { name: "Kit-Buildの練習" })
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await tutorialPage.locator(".tutorial-tools form").count(), 0);
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
    await homePage
      .getByRole("heading", { name: "参加Sessionと結果" })
      .waitFor({ state: "attached" });
    assert.equal(await homePage.getByLabel("アクセスコード").count(), 0);
    assert.equal(await homePage.locator(".home-research-primary-grid .home-workflow-card").count(), 2);
    assert.equal(await homePage.getByRole("heading", { name: "教材を管理" }).count(), 1);
    assert.equal(await homePage.getByRole("heading", { name: "実施を管理" }).count(), 1);
    assert.equal(await homePage.getByRole("heading", { name: "参加Sessionを確認" }).count(), 1);
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
    assert.equal(
      await homePage.locator('a[href="/research/stage1/new"]').count(),
      1,
    );
    const legacyFlow = homePage.locator(".home-researcher-legacy-details");
    const legacySummary = legacyFlow.locator("summary");
    const legacyCreateLink = homePage.locator('a[href="/research/stage1/new"]');
    assert.equal((await legacySummary.textContent())?.trim(), "旧フローの作成");
    assert.equal(
      await homePage
        .locator('.home-research-primary-grid a[href="/research/stage1/new"]')
        .count(),
      0,
    );
    assert.equal(
      await legacyFlow.evaluate(
        (element) => (element as HTMLDetailsElement).open,
      ),
      false,
    );
    assert.equal(await legacyCreateLink.isVisible(), false);
    await legacySummary.focus();
    assert.equal(
      await legacySummary.evaluate(
        (element) => getComputedStyle(element).outlineStyle,
      ),
      "solid",
    );
    await legacySummary.press("Enter");
    assert.equal(
      await legacyFlow.evaluate(
        (element) => (element as HTMLDetailsElement).open,
      ),
      true,
    );
    assert.equal(await legacyCreateLink.isVisible(), true);
    assert.equal(
      await legacyCreateLink.getAttribute("href"),
      "/research/stage1/new",
    );
    await legacySummary.press("Enter");
    assert.equal(
      await legacyFlow.evaluate(
        (element) => (element as HTMLDetailsElement).open,
      ),
      false,
    );
    await legacySummary.evaluate((element) => element.blur());
    for (const path of [
      "/research/data-management",
      "/research/events",
      "/research/event-exports",
      "/research/goal-maps",
    ]) {
      assert.equal(
        await homePage.locator(`a[href="${path}"]`).count(),
        path === "/research/data-management" ? 2 : 1,
      );
    }
    assert.equal(
      await homePage
        .locator('a[href="/research/goal-maps"]')
        .isVisible(),
      true,
    );
    assert.equal(
      await homePage
        .locator(
          'a[href="/research/stage1/00000000-0000-4000-8000-000000000011/analysis"]',
        )
        .count(),
      1,
    );
    assert.equal(
      await homePage
        .locator('a[href="/sessions/00000000-0000-4000-8000-000000000012"]')
        .count(),
      1,
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
    for (const scenario of ["researcher-empty", "researcher-error"] as const) {
      const context = await browser.newContext({
        viewport: { width, height },
      });
      await context.addInitScript(() =>
        sessionStorage.setItem(
          "stage1-access-token",
          "SYNTHETIC_RESEARCHER_TOKEN_ONLY",
        ),
      );
      const page = await context.newPage();
      await installApiFixture(page, scenario);
      await page.goto(vite.resolvedUrls!.local[0]!);
      if (scenario === "researcher-empty")
        await page
          .getByText("参加Sessionはまだありません。", { exact: true })
          .waitFor();
      else
        await page
          .getByRole("alert")
          .getByText(/一覧を取得できませんでした/)
          .waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        `${scenario}: no horizontal overflow at ${width}px`,
      );
      await context.close();
    }

    let releaseHold = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const loadingContext = await browser.newContext({ viewport: { width, height } });
    await loadingContext.addInitScript(() =>
      sessionStorage.setItem(
        "stage1-access-token",
        "SYNTHETIC_RESEARCHER_TOKEN_ONLY",
      ),
    );
    const loadingPage = await loadingContext.newPage();
    await installApiFixture(loadingPage, "researcher-loading", async () => {
      await hold;
    });
    const requestStarted = loadingPage.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/research/stage1/sessions",
    );
    await loadingPage.goto(vite.resolvedUrls!.local[0]!);
    await requestStarted;
    await loadingPage
      .getByText("参加Sessionを読み込んでいます…", { exact: true })
      .waitFor();
    await assertNoHorizontalOverflow(loadingPage, "researcher-loading", width);
    releaseHold();
    await loadingPage
      .getByText("参加Sessionはまだありません。", { exact: true })
      .waitFor();
    await loadingContext.close();
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
    await installApiFixture(pendingPage, "login-pending", undefined, async () => {
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

  console.log(
    `Rehearsal UI: PASS (signed-out code entry without practice card; P02 inline practice/return with unchanged client claims and no learning writes; normal start and legacy link preserved; unpublished/waiting/ended; researcher states; Edge synthetic fixtures at 1366x768 and 1440x900; screenshots: ${directory}; no real API or DB persistence verified)`,
  );
} finally {
  await browser?.close();
  await vite.close();
}
