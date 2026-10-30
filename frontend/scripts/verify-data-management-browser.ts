import {verifyMockTestUrl} from "../../backend/src/scripts/mock-db.js";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { join } from "node:path";
import { tmpdir } from "node:os";
const token = process.env.RESEARCHER_API_TOKEN!;
await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
assert.ok(/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(process.env.API_BASE_URL ?? ""));
process.env.API_PROXY_TARGET = process.env.API_BASE_URL;
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? "msedge", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1366, height: 1000 },
  });
  await page.addInitScript(
    (v) => sessionStorage.setItem("stage1-access-token", v),
    token,
  );
  await page.addInitScript(()=>localStorage.setItem("stage1-assessment-draft-unknown-owner","MOCK OWNER-UNKNOWN NEVER DISPLAY"));
  await page.goto(vite.resolvedUrls!.local[0] + "research/data-management");
  await page
    .getByRole("heading", { name: "研究データ管理", exact: true })
    .waitFor();
  await page.getByRole("heading",{name:"所有者不明の旧評価下書き",exact:true}).waitFor();
  assert.equal(await page.getByText("MOCK OWNER-UNKNOWN NEVER DISPLAY",{exact:false}).count(),0);
  assert.equal(await page.evaluate(()=>localStorage.getItem("stage1-assessment-draft-unknown-owner")),"MOCK OWNER-UNKNOWN NEVER DISPLAY");
  await page
    .getByRole("heading", { name: "研究ごとの保存期限", exact: true })
    .waitFor();
  await page
    .getByRole("button", {
      name: "このセッションの削除範囲を確認",
      exact: true,
    })
    .first()
    .click();
  await page
    .getByRole("heading", { name: "削除の最終確認", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "確認した対象を削除する", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByLabel("削除する場合は DELETE と入力").fill("DELETE");
  assert.equal(
    await page
      .getByRole("button", { name: "確認した対象を削除する", exact: true })
      .isDisabled(),
    false,
  );
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  await page
    .getByRole("button", { name: "仮名IDを再発行…", exact: true })
    .first()
    .click();
  await page
    .getByRole("heading", { name: "仮名IDの再発行", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  await page.screenshot({
    path: join(tmpdir(), "stage1-issue11-management.png"),
    fullPage: false,
  });
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
    .getByRole("heading", { name: "研究データ管理", exact: true })
    .waitFor({ state: "hidden" });
  console.log(
    "Edge management UI: retention/pseudonyms/deletion preview/final confirmation/reissue cancel/learner denial: PASS",
  );
} finally {
  await browser.close();
  await vite.close();
}
