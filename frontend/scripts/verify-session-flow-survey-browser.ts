import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
const sid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
  st = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02",
  mapId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03",
  cid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04";
const questions = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11",
    kind: "TEXT",
    prompt: "模擬の自由記述",
    required: true,
    config: {},
  },
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12",
    kind: "CHOICE",
    prompt: "模擬の選択",
    required: true,
    config: { options: ["部品A", "部品B"] },
  },
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13",
    kind: "RATING",
    prompt: "模擬の段階",
    required: false,
    config: { min: 1, max: 3, minLabel: "小さい", maxLabel: "大きい" },
  },
];
try {
  const ctx = await browser.newContext({
    viewport: { width: 1500, height: 1100 },
  });
  const page = await ctx.newPage();
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "stage1-access-token",
      "mock-ui-only-long-enough-1234567890",
    ),
  );
  let mode = "SURVEY",
    saved: unknown = null,
    failSave = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/me")
      return route.fulfill({
        json: { role: "learner", sessionId: sid, kitId: cid },
      });
    const stage = {
      id: st,
      sessionId: sid,
      stageType: mode,
      orderIndex: mode === "SURVEY" ? 4 : 1,
      status: "IN_PROGRESS",
      startedAt: new Date().toISOString(),
      completedAt: null,
      mapId: mode === "SURVEY" ? null : mapId,
    };
    if (path === `/api/sessions/${sid}/flow`)
      return route.fulfill({
        json: {
          session: {
            id: sid,
            status: "IN_PROGRESS",
            protocolKey: "STAGE1_5",
            studyGroup: null,
            groupActivitySeconds: 3600,
          },
          stages: [stage],
          currentStage: stage,
          nextStage: null,
          serverNow: new Date().toISOString(),
        },
      });
    if (path === `/api/session-stages/${st}/survey`)
      return route.fulfill({ json: { stageId: st, questions, answers: [] } });
    if (path === `/api/session-stages/${st}/survey/save`) {
      saved = request.postDataJSON();
      if (failSave)
        return route.fulfill({
          status: 500,
          json: { message: "模擬の通信失敗", logSaved: false },
        });
      return route.fulfill({
        json: { saved: true, logSaved: true },
        headers: { "X-Operation-Recorded": "true" },
      });
    }
    if (path === `/api/maps/${mapId}`)
      return route.fulfill({
        json: {
          id: mapId,
          type: "PRIOR",
          status: "DRAFT",
          basedOnMapId: null,
          kitDefinitionId: null,
          sessionStageId: st,
          sessionId: sid,
          sessionProtocolKey: "STAGE1_5",
          submittedAt: null,
          concepts: [
            {
              id: cid,
              mapId,
              label: "模擬初期概念",
              isSeed: true,
              positionX: 150,
              positionY: 150,
            },
          ],
          links: [],
          kitConcepts: [],
          kitLinks: [],
        },
      });
    if (path.endsWith("/undo-redo"))
      return route.fulfill({
        json: {
          status: "AVAILABLE",
          canUndo: false,
          canRedo: false,
          sequenceNumber: 0,
        },
      });
    if (path.endsWith("/access")) return route.fulfill({ status: 204 });
    if (path.endsWith("/events"))
      return route.fulfill({
        status: 201,
        json: { eventId: cid, sequenceNumber: "1", logSaved: true },
      });
    return route.fulfill({ json: {} });
  });
  const url = vite.resolvedUrls!.local[0];
  await page.goto(url + "sessions/" + sid);
  await page.getByLabel("1. 模擬の自由記述（必須）").waitFor();
  assert.equal(await page.getByRole("region", { name: "活動一覧" }).count(), 0);
  assert.ok(!(await page.locator("main").innerText()).includes("次の活動"));
  await page.getByRole("button", { name: "回答を提出", exact: true }).click();
  assert.equal(
    await page.locator(":focus").getAttribute("id"),
    "survey-" + questions[0].id,
  );
  await page.getByLabel("1. 模擬の自由記述（必須）").fill("模擬の回答");
  await page.getByLabel("2. 模擬の選択（必須）").selectOption("部品B");
  await page.getByLabel("3. 模擬の段階（任意）").selectOption("2");
  await page.getByRole("button", { name: "回答を保存", exact: true }).click();
  await page.getByText("回答を保存しました。", { exact: true }).waitFor();
  assert.deepEqual(saved, {
    answers: questions.map((q, i) => ({
      questionId: q.id,
      value: i === 0 ? "模擬の回答" : i === 1 ? "部品B" : 2,
    })),
  });
  failSave = true;
  await page.getByRole("button", { name: "回答を保存", exact: true }).click();
  await page.getByText("模擬の通信失敗", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("1. 模擬の自由記述（必須）").inputValue(),
    "模擬の回答",
  );
  const queue = await page.evaluate(async () => {
    const snapshots = [];
    for (const meta of await indexedDB.databases()) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(meta.name!);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      for (const name of db.objectStoreNames) {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const r = db.transaction(name).objectStore(name).getAll();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        snapshots.push(rows);
      }
      db.close();
    }
    return JSON.stringify(snapshots);
  });
  assert.ok(!queue.includes("模擬の回答"));
  mode = "PRIOR_MAP";
  await page.goto(url + "maps/" + mapId);
  const seed = page.getByText("模擬初期概念", { exact: true });
  await seed.waitFor();
  await seed.click();
  await page.locator("#map-editor-concept-edit-label").waitFor();
  assert.ok(await page.locator("#map-editor-concept-edit-label").isDisabled());
  assert.ok(
    await page.getByRole("button", { name: "削除", exact: true }).isDisabled(),
  );
  assert.ok(
    await page.getByRole("button", { name: "保存", exact: true }).isDisabled(),
  );
  console.log(
    "Mock API real browser: learner current-only SURVEY, required focus/input retention, typed save, seeded Concept rename/delete disabled: PASS",
  );
  await ctx.close();
  const research=await browser.newContext();const createPage=await research.newPage();let creation:Record<string,unknown>|null=null;
  await createPage.addInitScript(()=>sessionStorage.setItem("stage1-access-token","mock-ui-only-long-enough-1234567890"));
  await createPage.route("**/api/**",async route=>{const req=route.request(),path=new URL(req.url()).pathname;
    if(path==="/api/me")return route.fulfill({json:{role:"researcher"}});
    if(path==="/api/research/stage1/settings")return route.fulfill({json:{minutes:1}});
    if(path==="/api/kits")return route.fulfill({json:{kits:[{id:cid,name:"模擬Kit"}]}});
    if(path===`/api/kits/${cid}`)return route.fulfill({json:{concepts:[{kitConceptItemId:cid,label:"模擬初期概念"}],links:[]}});
    if(path==="/api/research/stage1/sessions"&&req.method()==="POST"){creation=req.postDataJSON();return route.fulfill({status:201,json:{id:sid,learnerAccessToken:"mock-not-a-server-credential"}});}
    return route.fulfill({json:{}});
  });
  await createPage.goto(url+"research/stage1/new");await createPage.getByLabel("模擬初期概念",{exact:true}).waitFor();assert.equal(await createPage.getByLabel("群",{exact:true}).count(),0);
  await createPage.getByLabel("参加者コード（仮名）").fill("MOCK-UI");await createPage.getByLabel("授業動画のURL / ファイル公開パス").fill("/mock.mp4");
  let fields=createPage.locator("fieldset").filter({has:createPage.locator("textarea")});
  await fields.nth(0).locator("textarea").first().fill("模擬選択の設問");await fields.nth(0).getByRole("combobox").selectOption("CHOICE");await fields.nth(0).getByLabel("選択肢（1行に1項目）").fill("部品A\n部品B");await createPage.getByRole("button",{name:"設問を追加",exact:true}).click();
  fields=createPage.locator("fieldset").filter({has:createPage.locator("textarea")});await fields.nth(1).locator("textarea").first().fill("模擬尺度の設問");await fields.nth(1).getByRole("combobox").selectOption("RATING");await fields.nth(1).getByLabel("回答必須").uncheck();await fields.nth(1).getByRole("button",{name:"上へ",exact:true}).click();await createPage.getByRole("button",{name:"設問を追加",exact:true}).click();await fields.nth(2).getByRole("button",{name:"設問を削除",exact:true}).click();assert.equal(await fields.count(),2);
  await createPage.getByLabel("模擬初期概念",{exact:true}).check();await createPage.getByRole("button",{name:"活動 1 セッションを作成",exact:true}).click();await createPage.getByText("セッションを作成しました。学習者用コードを安全な方法で本人に渡してください。",{exact:true}).waitFor();assert.ok(creation);assert.equal(Object.hasOwn(creation!,"studyGroup"),false);const sent=creation as {seedConceptIds:string[];surveyQuestions:{kind:string;required:boolean}[]};assert.deepEqual(sent.seedConceptIds,[cid]);assert.deepEqual(sent.surveyQuestions.map(q=>q.kind),["RATING","CHOICE"]);assert.equal(sent.surveyQuestions[0].required,false);await research.close();
  console.log("Mock API real browser: researcher 5-stage creation, Kit seed selection, survey types/reorder/delete/optional without group fields: PASS");

} finally {
  await browser.close();
  await vite.close();
}
