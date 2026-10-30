import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
const mapId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11",
  a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12",
  b = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13",
  link = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa14";
const map = {
  id: mapId,
  type: "PRIOR",
  status: "DRAFT",
  title: "MOCK map",
  basedOnMapId: null,
  kitDefinitionId: null,
  kitDefinitionName: null,
  sessionStageId: null,
  sessionId: null,
  sessionProtocolKey: "STAGE1_4",
  submittedAt: null,
  concepts: [
    {
      id: a,
      mapId,
      label: "MOCK 始点",
      positionX: 100,
      positionY: 100,
      mergedIntoConceptId: null,
    },
    {
      id: b,
      mapId,
      label: "MOCK 終点",
      positionX: 550,
      positionY: 100,
      mergedIntoConceptId: null,
    },
  ],
  links: [
    {
      id: link,
      mapId,
      sourceConceptId: a,
      targetConceptId: b,
      label: "MOCK 関係",
      labelPositionX: 320,
      labelPositionY: 220,
    },
  ],
  kitConcepts: [],
  kitLinks: [],
};
const writes: Array<{ labelPositionX: number; labelPositionY: number }> = [];
let failure: "none" | "reject" | "lost-response" = "none";
let offlineMap=false;
try {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1100 },
  });
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "stage1-access-token",
      "mock-ui-only-long-enough-1234567890",
    ),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/me")
      return route.fulfill({ json: { role: "researcher" } });
    if (path === `/api/maps/${mapId}`) {if(offlineMap)return route.abort("failed");return route.fulfill({json:map});}
    if (path === `/api/maps/${mapId}/access`)
      return route.fulfill({
        json: {
          allowed: true,
          serverNow: new Date().toISOString(),
          expiresAt: null,
        },
      });
    if (path === `/api/maps/${mapId}/undo-redo`)
      return route.fulfill({
        json: {
          status: "AVAILABLE",
          canUndo: false,
          canRedo: false,
          sequenceNumber: writes.length,
        },
      });
    if (
      path === `/api/links/${link}/position` &&
      request.method() === "PATCH"
    ) {
      const body = request.postDataJSON();
      if(failure!=="none"){
        if(failure==="lost-response")Object.assign(map.links[0],body);
        offlineMap=true;return route.abort("failed");
      }
      writes.push(body);
      Object.assign(map.links[0], body);
      return route.fulfill({
        json: {
          id: link,
          mapId,
          labelPositionX: body.labelPositionX,
          labelPositionY: body.labelPositionY,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "mock_not_found" } });
  });
  await page.goto(vite.resolvedUrls!.local[0] + "maps/" + mapId);
  const label = page.locator(
    `[data-connector-id="${link}"] .link-connector-label`,
  );
  await label.waitFor();
  assert.equal(
    await label.locator("..").evaluate((e) => (e as HTMLElement).style.left),
    "320px",
  );
  const box = await label.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 60,
    box.y + box.height / 2 + 40,
    { steps: 8 },
  );
  assert.equal(writes.length, 0);
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/links/${link}/position`) &&
      r.request().method() === "PATCH",
  );
  await page.mouse.up();
  await saved;
  await page
    .getByText("リンクの位置を保存しました。", { exact: true })
    .waitFor();
  assert.equal(writes.length, 1);
  assert.ok(Math.abs(writes[0].labelPositionX - 380) <= 1);
  assert.ok(Math.abs(writes[0].labelPositionY - 260) <= 1);
  await page.reload();
  await label.waitFor();
  assert.equal(
    await label.locator("..").evaluate((e) => (e as HTMLElement).style.left),
    `${writes[0].labelPositionX}px`,
  );
  // Scale the canvas to verify coordinate conversion rather than screen-pixel storage.
  await page.locator(".concept-canvas").evaluate((e) => {
    (e as HTMLElement).style.transform = "scale(0.8)";
    (e as HTMLElement).style.transformOrigin = "0 0";
  });
  const zoomed = await label.boundingBox();
  assert.ok(zoomed);
  await page.mouse.move(
    zoomed.x + zoomed.width / 2,
    zoomed.y + zoomed.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    zoomed.x + zoomed.width / 2 + 40,
    zoomed.y + zoomed.height / 2 + 24,
    { steps: 4 },
  );
  await page.mouse.up();
  await page
    .getByText("リンクの位置を保存しました。", { exact: true })
    .waitFor();
  assert.equal(writes.length, 2);
  assert.ok(
    Math.abs(writes[1].labelPositionX - writes[0].labelPositionX - 50) <= 1,
  );
  assert.ok(
    Math.abs(writes[1].labelPositionY - writes[0].labelPositionY - 30) <= 1,
  );
  await page.locator(".concept-canvas").evaluate(e=>{(e as HTMLElement).style.transform="";});
  for(const mode of ["reject","lost-response"] as const){
    const old={x:map.links[0].labelPositionX,y:map.links[0].labelPositionY};failure=mode;
    const box=await label.boundingBox();assert.ok(box);
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    await page.mouse.move(box.x+box.width/2+85,box.y+box.height/2+65);await page.mouse.up();
    await page.getByText("リンク位置の保存を確認できません。表示はドラッグ前の位置を保持します。通信復旧後に再読み込みして保存状態を確認してください。",{exact:true}).waitFor();
    assert.equal(await label.locator("..").evaluate(e=>(e as HTMLElement).style.left),`${old.x}px`);
    assert.equal(await label.locator("..").evaluate(e=>(e as HTMLElement).style.top),`${old.y}px`);
    failure="none";offlineMap=false;await page.reload();await label.waitFor();
    assert.equal(await label.locator("..").evaluate(e=>(e as HTMLElement).style.left),`${map.links[0].labelPositionX}px`);
    assert.equal(await label.locator("..").evaluate(e=>(e as HTMLElement).style.top),`${map.links[0].labelPositionY}px`);
    if(mode==="reject")assert.equal(map.links[0].labelPositionX,old.x);else assert.notEqual(map.links[0].labelPositionX,old.x);
  }
  map.status = "SUBMITTED";
  await page.reload();
  await label.waitFor();
  const locked = await label.boundingBox();
  assert.ok(locked);
  await page.mouse.move(
    locked.x + locked.width / 2,
    locked.y + locked.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(locked.x + 70, locked.y + 50);
  await page.mouse.up();
  assert.equal(writes.length, 2);
  console.log(
    "Real Map UI: drag-end-only save, persisted reload, zoom coordinates, rejected/lost-response writes + failed reload preserve prior position, recovery sync and read-only lock: PASS",
  );
} finally {
  await browser.close();
  await vite.close();
}
