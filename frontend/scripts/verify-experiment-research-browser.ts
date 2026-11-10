// TEST ONLY: researcher UI over the actual disposable API, no production data.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const base = process.env.API_BASE_URL!,
  run = process.env.EXPERIMENT_RESEARCH_RUN!,
  session = process.env.EXPERIMENT_RESEARCH_SESSION!,
  token = process.env.RESEARCHER_API_TOKEN!;
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
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.addInitScript(
    (t) => sessionStorage.setItem("stage1-access-token", t),
    token,
  );
  await page.goto(
    vite.resolvedUrls!.local[0] + "research/experiment-runs/" + run,
  );
  const link = page.locator(`a[href="/research/stage1/${session}/analysis"]`);
  await link.waitFor();
  await link.click();
  await page
    .getByRole("heading", { name: "実施と固定教材版", exact: true })
    .waitFor();
  await page
    .getByText("SB/KB統合（アンケートなし）", { exact: false })
    .waitFor();
  await page
    .getByRole("heading", { name: "統合開始時・受理済み提出状態", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "アンケート回答", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "特徴量CSVを出力", exact: true })
      .count(),
    0,
  );
  await page
    .getByText("Scratch-Buildの保存状態・出所情報", { exact: true })
    .click();
  await page.getByText("CLONED_FROM", { exact: false }).first().waitFor();
  if(process.env.EXPERIMENT_MISSING_SNAPSHOT==="1") {
    const section=page.locator("section.session-card").filter({has:page.getByRole("heading",{name:"統合開始時・受理済み提出状態",exact:true})});
    await section.getByText("状態記録なし／算出不可：INITIAL_SNAPSHOT_MISSING_OR_INVALID",{exact:true}).first().waitFor();
    assert.equal(await section.locator(".map-history-preview").count(),0,"no fabricated start/submission map");
    const raw=await (await fetch(base+`/api/research/sessions/${session}/export`,{headers:{Authorization:"Bearer "+token}})).json();
    assert.equal(raw.integrationStates.start.state,null);assert.equal(raw.integrationStates.submission.state,null);
  } else {
  const select = page.locator(".map-history-section select");
  const analysis = await (
    await fetch(base + `/api/research/stage1/sessions/${session}/analysis`, {
      headers: { Authorization: "Bearer " + token },
    })
  ).json();
  const value = analysis.maps.find(
    (m: { type: string }) => m.type === "INTEGRATION",
  ).id;
  await select
    .locator(`option[value="${value}"]`)
    .waitFor({ state: "attached" });
  await select.selectOption(value);
  const history = page.locator(".map-operation-list details");
  // Wait on recorded operations, rather than a generic heading or sleep.
  if (await history.count()) {
    await history.first().locator("summary").click();
  } else {
    await page.locator(".map-history-section details summary").first().click();
  }
  await page.getByRole("heading", { name: "変更点", exact: true }).waitFor();
  }
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/map-states.csv"),
  );
  await page
    .getByRole("button", { name: "保存Map・開始／提出状態CSV", exact: true })
    .click();
  const file = await response;
  assert.equal(file.status(), 200);
  assert.ok(file.headers()["content-type"].includes("text/csv"));
  const out =
    process.env.VISUALIZATION_DIR ??
    join(tmpdir(), "experiment-research-visual");
  await mkdir(out, { recursive: true });
  await page.screenshot({
    path: join(out, "experiment-research-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 2,
    ),
    "mobile page fits viewport; canvas remains internally pannable",
  );
  await page.screenshot({
    path: join(out, "experiment-research-mobile.png"),
    fullPage: true,
  });
  console.log(
    "Experiment research browser: PASS (R08 link, fixed material, saved maps/provenance, accepted states, history and CSV)",
  );
} finally {
  await browser.close();
  await vite.close();
}
