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

async function installApiFixture(
  page: Page,
  scenario: Scenario,
  onSessionListRequest?: () => Promise<void>,
  onAccessRequest?: () => Promise<void>,
) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") {
      if (scenario === "login-pending") await onAccessRequest?.();
      if (scenario === "login-error")
        return json(route, { error: "synthetic_invalid_code" }, 401);
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
        state: scenario === "ended" ? "ENDED" : "PREPARING",
      });
    if (path === "/api/experiment-client/claim")
      return json(route, {
        clientId: "00000000-0000-4000-8000-000000000002",
        ownership: "OWNED",
        deviceGeneration: 0,
      });
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

const directory = join(tmpdir(), "sbkb-tutorial-researcher-home-20261114");
await mkdir(directory, { recursive: true });
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
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
        assert.equal(await page.getByRole("link", { name: /操作の練習へ/ }).getAttribute("href"), "/tutorial");
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
    `Rehearsal UI: PASS (shared code entry/auth request/error/pending; unpublished/waiting/ended; tutorial local-only/mode/reset/exit; researcher two primary cards and retained results/status/rows/loading/empty/error; Edge synthetic fixtures at 1366x768 and 1440x900; screenshots: ${directory}; no API or DB persistence verified)`,
  );
} finally {
  await browser?.close();
  await vite.close();
}
