// Synthetic browser fixtures only. This check never connects to a backend or database.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Page, type Route } from "playwright";
import { createServer } from "vite";

const ids = {
  series: "10000000-0000-4000-8000-000000000001",
  draft: "10000000-0000-4000-8000-000000000002",
  published: "10000000-0000-4000-8000-000000000003",
  runPreparing: "20000000-0000-4000-8000-000000000001",
  runRunning: "20000000-0000-4000-8000-000000000002",
  runEnded: "20000000-0000-4000-8000-000000000003",
};
const timestamp = "2026-11-14T02:00:00.000Z";
const body = {
  title: "模擬教材 A",
  researcherDescription: "合成画面確認用の説明です。",
  videoRef: "",
  sbInstructions: "",
  kbInstructions: "",
  integrationInstructions: "",
  kitId: null,
  seedConceptItemIds: [],
  integrationSeconds: null,
};
const draftVersion = {
  id: ids.draft,
  seriesId: ids.series,
  version: 1,
  editRevision: 1,
  state: "DRAFT",
  foundationVersionId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  completedAt: null,
  body,
};
const asset = {
  kitId: "30000000-0000-4000-8000-000000000001",
  kitName: "合成Kit",
  goalMapId: "30000000-0000-4000-8000-000000000002",
  goalTitle: "合成ゴールマップ",
  available: true,
  frozen: true,
  concepts: [{ id: "seed-1", label: "合成初期概念" }],
};
const summaries = [
  {
    id: ids.draft,
    seriesId: ids.series,
    version: 1,
    state: "DRAFT",
    foundationVersionId: null,
    updatedAt: timestamp,
    completedAt: null,
    title: "模擬教材 A",
  },
  {
    id: ids.published,
    seriesId: ids.series,
    version: 2,
    state: "PUBLISHED",
    foundationVersionId: "30000000-0000-4000-8000-000000000003",
    updatedAt: timestamp,
    completedAt: timestamp,
    title: "模擬教材 A",
  },
];
const completedVersions = [
  {
    id: ids.published,
    version: 2,
    title: "模擬教材 A",
    materialVersionId: ids.published,
    integrationSeconds: 601,
  },
];
const runs = [
  {
    id: ids.runPreparing,
    name: "模擬実施・準備中",
    catalogVersionId: ids.published,
    materialVersionId: ids.published,
    materialTitle: "模擬教材 A",
    materialVersion: 2,
    integrationSeconds: 601,
    plannedParticipants: 2,
    registeredSessions: 1,
    state: "PREPARING",
    createdAt: timestamp,
  },
  {
    id: ids.runRunning,
    name: "模擬実施・開始済み",
    catalogVersionId: ids.published,
    materialVersionId: ids.published,
    materialTitle: "模擬教材 A",
    materialVersion: 2,
    integrationSeconds: 601,
    plannedParticipants: 2,
    registeredSessions: 2,
    state: "RUNNING",
    createdAt: timestamp,
  },
  {
    id: ids.runEnded,
    name: "模擬実施・終了",
    catalogVersionId: ids.published,
    materialVersionId: ids.published,
    materialTitle: "模擬教材 A",
    materialVersion: 2,
    integrationSeconds: 601,
    plannedParticipants: 1,
    registeredSessions: 1,
    state: "ENDED",
    createdAt: timestamp,
  },
];

function json(route: Route, payload: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

async function installSyntheticApi(
  page: Page,
  options: {
    empty?: boolean;
    failMaterials?: boolean;
    failRuns?: boolean;
    holdList?: "materials" | "runs";
  } = {},
) {
  let markRequested = () => {};
  const requestSeen = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  let releaseHold = () => {};
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "stage1-access-token",
      "SYNTHETIC_RESEARCHER_TOKEN_ONLY",
    ),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") return json(route, { role: "researcher" });
    if (path === "/api/research/materials/assets")
      return json(route, { assets: [asset] });
    if (path === `/api/research/materials/${ids.draft}`)
      return json(route, draftVersion);
    if (path === `/api/research/materials/${ids.draft}/check`)
      return json(route, {
        ready: false,
        editRevision: 1,
        issues: [{ field: "videoRef", message: "動画を設定してください。" }],
      });
    if (path === "/api/research/materials" && request.method() === "GET") {
      if (options.holdList === "materials") {
        markRequested();
        await hold;
      }
      if (options.failMaterials)
        return json(route, { message: "synthetic unavailable" }, 503);
      return json(route, { versions: options.empty ? [] : summaries });
    }
    if (path === "/api/research/materials" && request.method() === "POST")
      return json(route, { id: ids.draft }, 201);
    if (path === "/api/research/experiment-runs/material-versions")
      return json(route, { versions: completedVersions });
    if (
      path === "/api/research/experiment-runs" &&
      request.method() === "GET"
    ) {
      if (options.holdList === "runs") {
        markRequested();
        await hold;
      }
      if (options.failRuns)
        return json(route, { message: "synthetic unavailable" }, 503);
      return json(route, { runs: options.empty ? [] : runs });
    }
    if (
      path === "/api/research/experiment-runs" &&
      request.method() === "POST"
    ) {
      return json(
        route,
        {
          ...runs[0],
          id: "20000000-0000-4000-8000-000000000004",
          name: "合成新規実施",
          plannedParticipants: 0,
          registeredSessions: 0,
        },
        201,
      );
    }
    return json(route, { error: "not_found" }, 404);
  });
  return { requestSeen, release: releaseHold };
}

const directory = join(tmpdir(), "sbkb-researcher-ui-20261114-final");
await mkdir(directory, { recursive: true });
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const metrics: Array<Record<string, unknown>> = [];
async function captureComparison(
  page: Page,
  name: string,
  viewport: { width: number; height: number },
) {
  for (const phase of ["before", "after"] as const) {
    const enabled = phase === "after";
    const styleCount = await page.evaluate((isEnabled) => {
      const styles = document.querySelectorAll<HTMLStyleElement>(
        "style[data-vite-dev-id$='researcher-ui.css']",
      );
      for (const style of styles)
        if (style.sheet) style.sheet.disabled = !isEnabled;
      return styles.length;
    }, enabled);
    assert.ok(
      styleCount > 0,
      "researcher-ui.css must be loaded for matched before/after comparison",
    );
    await page.screenshot({
      path: join(
        directory,
        `${phase}-${name}-${viewport.width}x${viewport.height}.png`,
      ),
      fullPage: true,
    });
    const geometry = await page.evaluate(() => {
      const header = document
        .querySelector(".materials-header")
        ?.getBoundingClientRect();
      const pageLabel = document
        .querySelector(".materials-header > span")
        ?.getBoundingClientRect();
      const accountSwitch = document
        .querySelector(".auth-toolbar button")
        ?.getBoundingClientRect();
      const complete = document
        .querySelector(".material-complete")
        ?.getBoundingClientRect();
      return {
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        bodyOverflow: document.body.scrollWidth > innerWidth,
        scrollHeight: document.documentElement.scrollHeight,
        headerTop: header?.top ?? null,
        completeBottom: complete?.bottom ?? null,
        primaryBottom:
          document.querySelector(".run-submit")?.getBoundingClientRect()
            .bottom ?? null,
        accountSwitchOverlapsLabel: Boolean(
          pageLabel &&
          accountSwitch &&
          !(
            accountSwitch.left >= pageLabel.right ||
            accountSwitch.right <= pageLabel.left ||
            accountSwitch.top >= pageLabel.bottom ||
            accountSwitch.bottom <= pageLabel.top
          ),
        ),
      };
    });
    assert.equal(
      geometry.pageOverflow,
      false,
      `${name}: horizontal overflow at ${viewport.width}`,
    );
    assert.equal(
      geometry.bodyOverflow,
      false,
      `${name}: body overflow at ${viewport.width}`,
    );
    if (phase === "after")
      assert.equal(
        geometry.accountSwitchOverlapsLabel,
        false,
        `${name}: access switch must not cover the page label`,
      );
    if (phase === "after" && name === "material-draft") {
      assert.equal(
        geometry.headerTop,
        0,
        "R04 header should start at the top of the PC viewport",
      );
      assert.ok(
        (geometry.completeBottom ?? Infinity) <= viewport.height,
        "R04 completion action should fit in the initial 1366x768/1440x900 viewport",
      );
    }
    if (phase === "after" && name === "run-create") {
      assert.ok(
        (geometry.primaryBottom ?? Infinity) <= viewport.height,
        "R06 create action should fit in the initial PC viewport",
      );
    }
    metrics.push({ phase, viewport, case: name, ...geometry });
  }
  await page.evaluate(() => {
    for (const style of document.querySelectorAll<HTMLStyleElement>(
      "style[data-vite-dev-id$='researcher-ui.css']",
    ))
      if (style.sheet) style.sheet.disabled = false;
  });
}

async function verifyLoading(
  browserInstance: Awaited<ReturnType<typeof chromium.launch>>,
  path: string,
  list: "materials" | "runs",
) {
  const context = await browserInstance.newContext({
    viewport: { width: 1366, height: 768 },
  });
  const page = await context.newPage();
  const fixture = await installSyntheticApi(page, { holdList: list });
  await page.goto(
    new URL(path.replace(/^\//, ""), vite.resolvedUrls!.local[0]!).toString(),
  );
  await fixture.requestSeen;
  await page
    .getByRole("status")
    .filter({
      hasText:
        list === "materials"
          ? "教材を読み込んでいます"
          : "実施一覧を読み込んでいます",
    })
    .waitFor();
  fixture.release();
  await page
    .getByRole("heading", {
      name: list === "materials" ? "教材一覧" : "登録された実施",
      exact: true,
    })
    .waitFor();
  await context.close();
}
try {
  await vite.listen();
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL ?? "msedge",
  });
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
  ]) {
    const cases = [
      {
        name: "materials-list",
        path: "/research/materials",
        title: "教材一覧",
        options: {},
      },
      {
        name: "material-draft",
        path: `/research/materials/${ids.draft}`,
        title: "教材管理 / 教材を編集",
        options: {},
      },
      {
        name: "runs-list",
        path: "/research/experiment-runs",
        title: "実施管理 / 実施一覧",
        options: {},
      },
      {
        name: "run-create",
        path: "/research/experiment-runs/new",
        title: "実施管理 / 実施を作成",
        options: {},
      },
    ];
    for (const item of cases) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const requestPaths: string[] = [];
      page.on("request", (request) =>
        requestPaths.push(new URL(request.url()).pathname),
      );
      page.on("pageerror", (error) =>
        console.error(`Synthetic page error: ${error.message}`),
      );
      await installSyntheticApi(page, item.options);
      await page.goto(
        new URL(
          item.path.replace(/^\//, ""),
          vite.resolvedUrls!.local[0]!,
        ).toString(),
      );
      try {
        await page
          .getByRole("heading", { name: item.title, exact: true })
          .waitFor({ timeout: 7000 });
      } catch (error) {
        console.error(
          `Synthetic screen did not reach ${item.name}; path=${new URL(page.url()).pathname}; requests=${requestPaths.join(",")}; text=${(await page.locator("body").innerText()).slice(0, 800)}`,
        );
        throw error;
      }
      if (item.name === "materials-list") {
        await page
          .getByRole("heading", { name: "教材一覧", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "教材の下書きを作成" })
          .waitFor();
      }
      if (item.name === "material-draft") {
        await page.getByRole("heading", { name: "完成チェック" }).waitFor();
        await captureComparison(page, item.name, viewport);
        await page
          .getByRole("button", { name: "SB 課題説明 未設定・要確認" })
          .click();
        await page.waitForFunction(
          () => document.activeElement?.id === "material-sb",
        );
        assert.equal(
          await page
            .locator("#material-sb")
            .evaluate((el) => el === document.activeElement),
          true,
        );
        await context.close();
        continue;
      }
      if (item.name === "runs-list") {
        await page.getByRole("heading", { name: "登録された実施" }).waitFor();
        assert.equal(
          (await page
            .getByText("登録済み参加者Session数", { exact: false })
            .count()) > 0,
          true,
        );
        for (const [state, label] of [
          ["preparing", "準備中"],
          ["running", "実施中（模擬）"],
          ["ended", "終了"],
        ] as const) {
          assert.equal(await page.locator(`.run-state-${state}`).count(), 1);
          await page.getByText(label, { exact: true }).waitFor();
        }
      }
      if (item.name === "run-create") {
        await page.getByLabel("実施名 *").fill("合成入力の実施");
        await page.getByLabel("完成教材版 *").selectOption(ids.published);
        await page.getByLabel("予定人数 *").fill("1.5");
        await page.getByRole("alert").waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "準備中の実施を作成" })
            .isDisabled(),
          true,
        );
        await page.getByLabel("予定人数 *").fill("0");
        assert.equal(
          await page
            .getByRole("button", { name: "準備中の実施を作成" })
            .isEnabled(),
          true,
        );
        await page
          .getByRole("heading", { name: item.title, exact: true })
          .click();
      }
      await captureComparison(page, item.name, viewport);
      await context.close();
    }
  }
  // Empty and error states are asserted without adding additional screenshot fixtures.
  for (const path of ["/research/materials", "/research/experiment-runs"]) {
    for (const mode of ["empty", "error"] as const) {
      const context = await browser.newContext({
        viewport: { width: 1366, height: 768 },
      });
      const page = await context.newPage();
      await installSyntheticApi(page, {
        empty: mode === "empty",
        failMaterials: mode === "error" && path.endsWith("materials"),
        failRuns: mode === "error" && path.endsWith("experiment-runs"),
      });
      await page.goto(
        new URL(
          path.replace(/^\//, ""),
          vite.resolvedUrls!.local[0]!,
        ).toString(),
      );
      if (mode === "empty")
        await page
          .getByText(
            path.endsWith("materials")
              ? "教材はまだありません"
              : "実施はまだありません",
          )
          .waitFor();
      else await page.getByRole("alert").waitFor();
      await context.close();
    }
  }
  await verifyLoading(browser, "/research/materials", "materials");
  await verifyLoading(browser, "/research/experiment-runs", "runs");
  await writeFile(
    join(directory, "comparison-metrics.json"),
    JSON.stringify(metrics, null, 2),
  );
  console.log(
    "Researcher UI layout: PASS (matched before/after screenshots; synthetic materials/runs; 1366x768 and 1440x900; loading/empty/error/form validation/focus/overflow; no API or DB)",
  );
  console.log(`Screenshots: ${directory}`);
} finally {
  await browser?.close();
  await vite.close();
}
