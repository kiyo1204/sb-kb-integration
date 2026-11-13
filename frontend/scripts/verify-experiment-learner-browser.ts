// TEST ONLY. Actual API and fresh browser Session supplied by parent verification.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
try {
  const page = await browser.newPage({
    viewport: { width: 1366, height: 1200 },
  });
  await page.addInitScript("globalThis.__name = (fn) => fn;");
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
  await page.getByText("初期概念は移動・リンク接続ができます。名前変更・削除はできません。", { exact: true }).waitFor();
  await page.screenshot({ path: join(dir, "sb-unselected.png"), fullPage: true });
  // UI-only missing-seed fixture. No persisted seed or DB constraint is changed.
  const mapGet = /\/api\/maps\/[^/?]+$/;
  await page.route(mapGet, async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = JSON.stringify(await response.json(), (key, value) => key === "isSeed" ? false : value);
    await route.fulfill({ response, body });
  });
  await page.getByRole("link", { name: /セッション画面へ戻る/ }).click();
  await page.getByRole("button", { name: "続ける", exact: true }).click();
  await page.getByRole("heading", { name: /Scratch-Build/ }).waitFor();
  await page.locator(".concept-node").first().waitFor();
  assert.equal(await page.locator(".experiment-seed-guidance").count(), 0);
  await page.screenshot({ path: join(dir, "sb-no-seed-fixture.png"), fullPage: true });
  await page.unroute(mapGet);
  await page.getByRole("link", { name: /セッション画面へ戻る/ }).click();
  await page.getByRole("button", { name: "続ける", exact: true }).click();
  await page.locator(".experiment-seed-guidance").waitFor();
  const seedNode = page.locator(".concept-node").first(),
    seedBox = await seedNode.boundingBox();
  assert.ok(seedBox);
  const moved = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      /\/concepts\/[^/]+\/position$/.test(new URL(r.url()).pathname),
  );
  await page.mouse.move(
    seedBox.x + seedBox.width / 2,
    seedBox.y + seedBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    seedBox.x + seedBox.width / 2 + 40,
    seedBox.y + seedBox.height / 2 + 30,
    { steps: 10 },
  );
  await page.mouse.up();
  assert.equal((await moved).status(), 200);
  await page.screenshot({ path: join(dir, "p05.png"), fullPage: true });
  await seedNode.click();
  assert.ok(await page.locator(".experiment-seed-guidance").isVisible());
  await page.screenshot({ path: join(dir, "sb-selected.png"), fullPage: true });
  await page.getByRole("button", { name: "Drawerを閉じる", exact: true }).click();
  await page.context().setOffline(true);
  await page
    .getByText("オフライン：保存・提出はできません。", { exact: false })
    .waitFor();
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
  await page.locator("#kb-submission-guidance").filter({hasText:"未確認です"}).waitFor();
  await page.getByText("最終提出時は、前回の結果にかかわらずサーバーが最新のマップを再判定します。", { exact: true }).waitFor();
  await page.screenshot({ path: join(dir, "kb-unchecked.png"), fullPage: true });
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
  await page.locator("#kb-submission-guidance").filter({hasText:"確認結果：不一致"}).waitFor();
  await page.screenshot({ path: join(dir, "kb-mismatch.png"), fullPage: true });
  // Native mouse drag of a real palette part, then Undo restores its availability.
  const part = page.locator(".kit-palette-part.is-concept").first(),
    canvas = page.locator(".concept-canvas").first();
  await part.scrollIntoViewIfNeeded();
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
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLButtonElement>(".kit-palette-part.is-concept")
        ?.disabled === true,
  );
  await page.waitForFunction(() => !document.querySelector(".kit-feedback-check-button")?.hasAttribute("disabled"));
  await page.locator("#kb-submission-guidance").filter({hasText:"前回の結果は古く"}).waitFor();
  assert.ok(await page.getByRole("button", { name: "最終提出", exact: true }).isDisabled());
  await page.screenshot({ path: join(dir, "kb-stale.png"), fullPage: true });
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLButtonElement>(".kit-palette-part.is-concept")
        ?.disabled === false,
  );
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
  // A reload has a new screen identity: researcher explicitly transfers it;
  // current graph survives, but no cached KB match is treated as confirmation.
  await page.reload();
  await page
    .getByRole("heading", { name: "この画面では利用できません" })
    .waitFor();
  const candidate = (
    await page.locator(".session-card code").innerText()
  ).trim();
  const researcher = process.env.RESEARCHER_API_TOKEN!,
    run = process.env.EXPERIMENT_BROWSER_RUN!;
  const viewResponse = await fetch(
    base + `/api/research/experiment-runs/${run}/participants`,
    { headers: { Authorization: "Bearer " + researcher } },
  );
  assert.equal(viewResponse.status, 200);
  const participant = (await viewResponse.json()).participants.find(
    (p: { id: string }) => p.id === sid,
  );
  const switched = await fetch(
    base +
      `/api/research/experiment-runs/${run}/participants/${sid}/client-switch`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + researcher,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        clientId: candidate,
        expectedDeviceGeneration: participant.deviceGeneration,
      }),
    },
  );
  assert.equal(switched.status, 200);
  await page
    .getByRole("button", { name: "接続状態を更新", exact: true })
    .click();
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
  await page.locator("#kb-submission-guidance").filter({hasText:"確認結果：一致"}).waitFor();
  await page.screenshot({ path: join(dir, "kb-confirmed.png"), fullPage: true });
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
  await browser.close();
  await vite.close();
}
