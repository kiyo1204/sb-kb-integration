// Synthetic-response browser verification only. No API, DB, or participant data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { createServer } from "vite";

const runId = "00000000-0000-4000-8000-000000000008";
const participant = (
  label: string,
  status: string,
  completedStages: number,
  activeStageCount: number,
  currentStageType: string | null,
) => ({
  id: randomUUID(),
  label: `TEST ONLY ${label}`,
  status,
  registeredAt: "2026-11-14T09:00:00.000Z",
  credentialGeneration: 0,
  deviceGeneration: 0,
  activeClientId: null,
  completedStages,
  activeStageCount,
  currentStageType,
  clients: [],
});
function response(state: "RUNNING" | "ENDED") {
  const ended = state === "ENDED";
  return {
    run: {
      id: runId,
      name: "TEST ONLY R08 progress display",
      materialTitle: "TEST ONLY material",
      materialVersion: 1,
      catalogVersionId: "00000000-0000-4000-8000-000000000009",
      plannedParticipants: ended ? 3 : 4,
      registeredSessions: ended ? 3 : 4,
      state,
      integrationSeconds: 600,
      endedAt: ended ? "2026-11-14T09:30:00.000Z" : null,
    },
    startAvailable: false,
    learnerFlowAvailable: false,
    participants: ended
      ? [
          participant("ended active", "IN_PROGRESS", 1, 1, "PRIOR_MAP"),
          participant("ended not started", "NOT_STARTED", 0, 0, null),
          participant("ended completed", "COMPLETED", 4, 0, null),
        ]
      : [
          participant("not started", "NOT_STARTED", 0, 0, null),
          participant("active", "IN_PROGRESS", 2, 1, "KB_MAP"),
          participant("completed", "COMPLETED", 4, 0, null),
          participant("ambiguous stage", "IN_PROGRESS", 1, 2, null),
        ],
  };
}

const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
const directory =
  process.env.R08_PROGRESS_SCREENSHOT_DIR ??
  join(tmpdir(), "sbkb-r08-progress-display");
await mkdir(directory, { recursive: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  await page.addInitScript(() =>
    sessionStorage.setItem("stage1-access-token", "TEST_ONLY_SYNTHETIC_TOKEN"),
  );
  let view = response("RUNNING");
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/me")
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ role: "researcher" }),
      });
    if (pathname === `/api/research/experiment-runs/${runId}/participants`)
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(view),
      });
    return route.fulfill({ status: 404, body: "" });
  });

  const origin = vite.resolvedUrls!.local[0]!;
  await page.goto(origin + `research/experiment-runs/${runId}`);
  await page
    .getByRole("row")
    .filter({ hasText: "TEST ONLY not started" })
    .waitFor({ state: "visible" });
  assert.equal(await page.locator(".participants-table tbody tr").count(), 4);
  const notStarted = page
      .getByRole("row")
      .filter({ hasText: "TEST ONLY not started" }),
    active = page.getByRole("row").filter({ hasText: "TEST ONLY active" }),
    completed = page
      .getByRole("row")
      .filter({ hasText: "TEST ONLY completed" }),
    ambiguous = page
      .getByRole("row")
      .filter({ hasText: "TEST ONLY ambiguous stage" });
  assert.equal(await notStarted.getByRole("cell").nth(1).innerText(), "未開始");
  assert.equal(await notStarted.getByRole("cell").nth(2).innerText(), "0 / 4");
  assert.equal(await notStarted.getByRole("cell").nth(3).innerText(), "未開始");
  assert.equal(await active.getByRole("cell").nth(1).innerText(), "KB");
  assert.equal(await active.getByRole("cell").nth(2).innerText(), "2 / 4");
  assert.equal(await active.getByRole("cell").nth(3).innerText(), "進行中");
  assert.equal(
    await completed.getByRole("cell").nth(1).innerText(),
    "すべての活動が完了",
  );
  assert.equal(await completed.getByRole("cell").nth(2).innerText(), "4 / 4");
  assert.equal(
    await completed.getByRole("cell").nth(3).innerText(),
    "本人完了",
  );
  assert.equal(
    await ambiguous.getByRole("cell").nth(1).innerText(),
    "活動情報を確認できません",
  );
  assert.equal(
    await page.getByRole("columnheader", { name: "作業時間" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("columnheader", { name: "最終操作" }).count(),
    0,
  );

  view = response("ENDED");
  await page.getByRole("button", { name: "状態を更新" }).click();
  const endedActive = page
      .getByRole("row")
      .filter({ hasText: "TEST ONLY ended active" }),
    endedNotStarted = page
      .getByRole("row")
      .filter({ hasText: "TEST ONLY ended not started" }),
    endedCompleted = page
      .getByRole("row")
      .filter({ hasText: "TEST ONLY ended completed" });
  assert.equal(
    await endedActive.getByRole("cell").nth(1).innerText(),
    "終了時：SB",
  );
  assert.match(
    await endedActive.getByRole("cell").nth(3).innerText(),
    /実施終了時に進行中[\s\S]*Sessionの状態は変更していません/,
  );
  assert.equal(
    await endedNotStarted.getByRole("cell").nth(1).innerText(),
    "実施終了時点で未開始",
  );
  assert.equal(
    (await endedNotStarted.getByRole("cell").nth(3).innerText()).split("\n")[0],
    "実施終了時に未開始",
  );
  assert.equal(
    await endedCompleted.getByRole("cell").nth(3).innerText(),
    "本人完了",
  );
  assert.equal(await endedActive.getByRole("cell").nth(2).innerText(), "1 / 4");
  assert.equal(await page.locator(".participants-table tbody tr").count(), 3);
  assert.equal(
    await page.getByRole("button", { name: "実施を終了" }).isDisabled(),
    true,
  );
  await page.screenshot({
    path: join(directory, "r08-ended-progress-desktop.png"),
    fullPage: true,
  });
  for (const width of [1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const phase of ["before", "after"]) {
      await page.evaluate((disabled) => {
        for (const element of document.querySelectorAll<HTMLStyleElement>("style[data-vite-dev-id$='rehearsal-ui.css']")) {
          if (element.sheet) element.sheet.disabled = disabled;
        }
      }, phase === "before");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the page must not overflow horizontally");
      await page.screenshot({ path: join(directory, `r08-${width}-${phase}.png`), fullPage: true });
    }
  }
  console.log(
    "R08 progress display browser: PASS (synthetic API responses only; desktop not-started/active/completed/ended-incomplete states; screenshot contains synthetic labels only)",
  );
} finally {
  await browser.close();
  await vite.close();
}
