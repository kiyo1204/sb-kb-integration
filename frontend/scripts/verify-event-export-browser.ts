import {verifyMockTestUrl} from "../../backend/src/scripts/mock-db.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { createServer } from "vite";
const token = process.env.RESEARCHER_API_TOKEN!;
await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
assert.ok(/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(process.env.API_BASE_URL ?? ""));
process.env.API_PROXY_TARGET =
  process.env.API_BASE_URL ?? "http://127.0.0.1:3039";
const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await server.listen();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1366, height: 1000 },
  });
  await page.addInitScript(
    (value) => sessionStorage.setItem("stage1-access-token", value),
    token,
  );
  await page.goto(server.resolvedUrls!.local[0] + "research/event-exports");
  await page
    .getByRole("heading", { name: "研究イベントの絞り込み出力", exact: true })
    .waitFor();
  await page.getByLabel("実験群", { exact: true }).check();
  await page.getByLabel("実験群", { exact: true }).uncheck();
  await page.getByLabel("統制群", { exact: true }).check();
  await page
    .getByText("操作種別（選択 0件、未選択はすべて）", { exact: true })
    .click();
  await page.getByLabel("動画シーク（VIDEO_SEEK）", { exact: true }).check();
  await page
    .getByLabel("開始日時（日本時間 UTC+09:00、この時刻を含む）")
    .fill("2026-04-01T09:00");
  await page
    .getByLabel("終了日時（日本時間 UTC+09:00、この時刻を含まない）")
    .fill("2026-04-01T09:01");
  const made = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/research/event-exports") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "指定した条件で出力を準備", exact: true })
    .click();
  const response = await made;
  assert.equal(response.status(), 201);
  const metadata = await response.json();
  assert.ok(metadata.eventCount > 0);
  assert.equal(metadata.filters.from, "2026-04-01T00:00:00.000Z");
  await page.getByText("個別のファイルを取得", { exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("row")
    .filter({
      has: page.getByRole("cell", { name: "events.json", exact: true }),
    })
    .getByRole("button", { name: "取得", exact: true })
    .click();
  const file = await downloaded;
  assert.equal(file.suggestedFilename(), "events.json");
  const data = JSON.parse(await readFile((await file.path())!, "utf8"));
  assert.equal(data.event_count, metadata.eventCount);
  assert.ok(
    data.events.every(
      (e: { study_group: string; event_type: string }) =>
        e.study_group === "CONTROL" && e.event_type === "VIDEO_SEEK",
    ),
  );
  const zipDownload = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "JSON・共通CSV・用途別CSVを一括取得（ZIP）",
      exact: true,
    })
    .click();
  const zip = await zipDownload;
  assert.equal(zip.suggestedFilename(), "bundle.zip");
  assert.equal(
    (await readFile((await zip.path())!)).subarray(0, 2).toString(),
    "PK",
  );
  await page.screenshot({
    path: join(tmpdir(), "stage1-issue9-export-ui.png"),
    fullPage: true,
  });
  const deleted = page.waitForResponse(
    (r) =>
      r.request().method() === "DELETE" && r.url().includes(metadata.exportId),
  );
  await page
    .getByRole("button", { name: "一時出力を削除", exact: true })
    .click();
  assert.equal((await deleted).status(), 200);
  await page.goto(server.resolvedUrls!.local[0] + "research/events");
  await page.getByRole("heading",{name:"研究イベントの時系列ログ",exact:true}).waitFor();
  await page.getByLabel("成功",{exact:true}).check();
  const viewed=page.waitForResponse(r=>r.url().endsWith("/api/research/event-views")&&r.request().method()==="POST");
  await page.getByRole("button",{name:"指定した条件で検索",exact:true}).click();
  const viewedResponse=await viewed;
  assert.equal(viewedResponse.status(),201);
  const view=await viewedResponse.json();
  assert.deepEqual(view.filters.outcomes,["SUCCESS"]);
  await page.getByRole("button",{name:"詳細 1",exact:true}).click();
  await page.getByRole("heading",{name:"イベント詳細",exact:true}).waitFor();
  await page.getByText("before（保存状態・詳細）",{exact:true}).click();
  if(view.eventCount>25){await page.getByRole("button",{name:"次の25件",exact:true}).click();await page.getByRole("button",{name:"詳細 26",exact:true}).waitFor();}
  const viewDownload=page.waitForEvent("download");
  await page.getByRole("button",{name:"JSON・共通CSV・用途別CSVを一括取得（ZIP）",exact:true}).click();
  assert.equal((await viewDownload).suggestedFilename(),"bundle.zip");
  await page.screenshot({path:join(tmpdir(),"stage1-issue10-viewer.png"),fullPage:true});
  await page.getByRole("button",{name:"一時出力を削除",exact:true}).click();
  await page.route("**/api/me", (r) =>
    r.fulfill({
      json: {
        role: "learner",
        sessionId: "11111111-1111-4111-8111-111111111111",
      },
    }),
  );
  await page.reload();
  await page
    .getByRole("heading", { name: "研究イベントの時系列ログ", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(
    await page
      .getByRole("button", { name: "指定した条件で出力を準備", exact: true })
      .count(),
    0,
  );
  console.log(
    "Real Edge + isolated API: researcher filters/JST conversion, exact snapshot JSON/ZIP downloads, cleanup and learner UI denial: PASS",
  );
} finally {
  await browser.close();
  await server.close();
}
