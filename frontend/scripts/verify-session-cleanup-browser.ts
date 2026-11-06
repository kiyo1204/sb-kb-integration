import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
const vite=await createServer({server:{host:"127.0.0.1",port:0}});await vite.listen();
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL??"msedge",headless:true});
try {
  const page=await browser.newPage();await page.addInitScript(()=>sessionStorage.setItem("stage1-access-token","mock-cleanup-only-12345678901234567890"));
  const rows=[{id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",participantCode:"MOCK-EMPTY",protocolKey:"STAGE1_5",status:"NOT_STARTED"},{id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",participantCode:"MOCK-STARTED",protocolKey:"STAGE1_6",status:"IN_PROGRESS"}];
  let calls=0;let refuse=false;
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==="/api/me") return route.fulfill({json:{role:"researcher"}});
    if(path==="/api/health") return route.fulfill({json:{database:true}});
    if(path==="/api/research/stage1/sessions") return route.fulfill({json:{sessions:rows}});
    if(path.endsWith("/cleanup")){calls++;assert.deepEqual(route.request().postDataJSON(),{sessionId:rows[0]!.id,confirm:"DELETE_UNSTARTED"});return route.fulfill({status:refuse?409:200,json:refuse?{error:"confirmed_deletion_required"}:{deleted:true}});}
    return route.fulfill({json:{}});
  });
  await page.goto(vite.resolvedUrls!.local[0]!);
  const button=page.getByRole("button",{name:"MOCK-EMPTYの未開始セッションを削除",exact:true});await button.waitFor();
  assert.equal(await page.getByRole("button",{name:"MOCK-STARTEDの未開始セッションを削除"}).count(),0);
  page.once("dialog",async dialog=>{assert.match(dialog.message(),/MOCK-EMPTY/);assert.match(dialog.message(),/aaaaaaaa/);assert.match(dialog.message(),/共有Goal Map/);await dialog.dismiss();});
  await button.click();assert.equal(calls,0);
  refuse=true;page.once("dialog",dialog=>dialog.accept());await button.click();
  await page.getByText("開始済み、または記録があるため簡易削除できません。確認付きデータ削除を使用してください。",{exact:false}).waitFor();assert.equal(await button.count(),1);
  refuse=false;page.once("dialog",dialog=>dialog.accept());await button.click();
  await page.getByText("未開始セッションを削除しました。",{exact:false}).waitFor();assert.equal(await button.count(),0);assert.equal(calls,2);
  assert.equal(await page.locator('a[href="/research/data-management"]').count()>=1,true);
  console.log("Session cleanup browser: target/scope confirmation, cancel, refusal guidance, success removes only target row: PASS");
} finally {await browser.close();await vite.close();}
