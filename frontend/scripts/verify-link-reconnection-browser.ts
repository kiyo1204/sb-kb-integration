import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { createServer } from "vite";
const id = (n: number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const sid = id(1),
  mid = id(2),
  lid = id(3),
  stage = id(4),
  now = new Date().toISOString();
const map = {
  id: mid,
  type: "PRIOR",
  status: "DRAFT",
  title: "Synthetic SB",
  sessionId: sid,
  sessionStageId: stage,
  sessionStageStatus: "IN_PROGRESS",
  sessionProtocolKey: "SBKB_INTEGRATION_V1",
  kitDefinitionId: null,
  kitDefinitionName: null,
  basedOnMapId: null,
  submittedAt: null,
  concepts: [5, 6, 7].map((n, i) => ({
    id: id(n),
    mapId: mid,
    label: `MOCK ${i}`,
    positionX: 80 + i * 300,
    positionY: 250,
    createdAt: now,
    updatedAt: now,
  })),
  links: [
    {
      id: lid,
      mapId: mid,
      label: "MOCK relation",
      sourceConceptId: id(5),
      targetConceptId: id(6),
      labelPositionX: 450,
      labelPositionY: 180,
      kitLinkItemId: null,
      provenance: [],
    },
  ],
  kitConcepts: [],
  kitLinks: [],
  availableKitDefinitions: [],
};
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
async function drag(page: Page, endpoint: string, concept: string) {
  await page.getByRole("button", { name: "全体表示", exact: true }).click();
  const h = page.locator(`[data-connector-id="${lid}"] .is-${endpoint}`),
    c = page.locator(`[data-concept-id="${concept}"]`);
  await h.scrollIntoViewIfNeeded();
  const hb = await h.boundingBox();
  assert.ok(hb);
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await c.scrollIntoViewIfNeeded();
  const cb = await c.boundingBox();
  assert.ok(cb);
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
}
try {
  for (const width of [1366, 1440]) {
    const page = await browser.newPage({
      viewport: { width, height: width === 1366 ? 768 : 900 },
    });
    page.setDefaultTimeout(10000);
    page.on("pageerror", (e) =>
      console.error("SYNTHETIC_PAGE_ERROR", e.message),
    );
    await page.addInitScript(() =>
      sessionStorage.setItem("stage1-access-token", "SYNTHETIC_ONLY"),
    );
    let reject = false,
      conflict = false,
      patches = 0,
      positionWrites = 0,
      conceptReject = false,
      ended = false,
      preflightStatus = 200,
      patchGate: Promise<void> | null = null,
      preflight: (() => Promise<void>) | null = null;
    await page.route("**/api/**", async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      let body: unknown = {};
      if (path === "/api/me")
        body = {
          role: "learner",
          sessionId: sid,
          protocolKey: "SBKB_INTEGRATION_V1",
          flowAvailable: true,
          runState: "RUNNING",
        };
      else if (path === "/api/experiment-client/claim")
        body = { clientId: id(10), ownership: "OWNED", deviceGeneration: 1 };
      else if (path === "/api/experiment-material")
        body = {
          sbInstructions: "MOCK SB",
          kbInstructions: "MOCK KB",
          integrationInstructions: "MOCK integration",
        };
      else if (path.endsWith("/flow"))
        body = {
          session: {
            id: sid,
            status: "IN_PROGRESS",
            protocolKey: map.sessionProtocolKey,
            groupActivitySeconds: 900,
          },
          serverNow: now,
          currentMapSubmitted: false,
          currentStage: {
            id: stage,
            stageType: "PRIOR_MAP",
            status: "IN_PROGRESS",
            startedAt: now,
            mapId: mid,
          },
          stages: [
            {
              id: stage,
              stageType: "PRIOR_MAP",
              status: "IN_PROGRESS",
              mapId: mid,
              orderIndex: 1,
            },
          ],
          nextStage: null,
        };
      else if (path === `/api/maps/${mid}`) {
        if (preflight) await preflight();
        if (preflightStatus !== 200)
          return route.fulfill({
            status: preflightStatus,
            json: {
              error:
                preflightStatus === 409
                  ? "experiment_client_stale"
                  : "unauthorized",
            },
          });
        body = map;
      } else if (path === "/api/experiment-status")
        body = { state: ended ? "ENDED" : "RUNNING" };
      else if (path.endsWith("/access")) body = { access: "ALLOWED" };
      else if (path.endsWith("/undo-redo"))
        body = {
          status: "AVAILABLE",
          canUndo: true,
          canRedo: true,
          sequenceNumber: patches,
        };
      else if (path.endsWith("/events"))
        body = { logSaved: true, eventId: id(99), sequenceNumber: "1" };
      else if (path === `/api/links/${lid}/position`) {
        positionWrites++;
        Object.assign(map.links[0],req.postDataJSON());
        body={id:lid,mapId:mid,labelPositionX:map.links[0].labelPositionX,labelPositionY:map.links[0].labelPositionY,updatedAt:now};
      } else if (path.endsWith("/reconnect")) {
        patches++;
        const payload=req.postDataJSON();
        assert.deepEqual(payload.expectedConnection,{sourceConceptId:map.links[0].sourceConceptId,targetConceptId:map.links[0].targetConceptId},"draft always sends original saved connection");
        if(conflict){
          map.links[0]={...map.links[0],sourceConceptId:id(5),targetConceptId:id(6)};
          return route.fulfill({status:409,json:{error:"link_connection_conflict",operationCommitted:false,message:"保存元の接続が変更されています。接続は未保存です。編集を取消し、最新の接続を確認してください。"}});
        }
        if (reject)
          return route.fulfill({
            status: 503,
            json: { message: "Synthetic reconnect failure" },
          });
        Object.assign(map.links[0], req.postDataJSON());
        body = { ...map.links[0], updatedAt: now };
        if (patchGate) await patchGate;
      } else if (
        req.method() === "DELETE" &&
        path === `/api/concepts/${id(6)}`
      ) {
        map.concepts = map.concepts.filter((c) => c.id !== id(6));
        map.links = [];
        body = { id: id(6) };
      } else if (path.endsWith("/concepts") && req.method() === "POST") {
        if (conceptReject)
          return route.fulfill({
            status: 503,
            json: { message: "Synthetic concept failure" },
          });
        body = {
          id: id(20 + map.concepts.length),
          mapId: mid,
          ...req.postDataJSON(),
          createdAt: now,
          updatedAt: now,
        };
        map.concepts.push(body as (typeof map.concepts)[number]);
        return route.fulfill({ status: 201, json: body });
      }
      return route.fulfill({ json: body });
    });
    await page.goto(vite.resolvedUrls!.local[0] + `maps/${mid}`);
    await page
      .locator(".concept-canvas")
      .waitFor()
      .catch(async (e) => {
        console.error((await page.locator("body").innerText()).slice(0, 1400));
        throw e;
      });
    const root = `[data-connector-id="${lid}"]`,
      region = page.getByRole("region", { name: "保存済みリンクの接続編集" });
    async function begin() {
      await page.locator(root + " .link-connector-label").dblclick();
      await region.waitFor();
    }
    async function cancel() {
      await page
        .getByRole("button", { name: "接続編集を取消", exact: true })
        .click();
      await page.locator(".is-reconnecting").waitFor({ state: "detached" });
    }
    // A real label drag preserves the position save and does not detach/select.
    for(const delta of [30,-30]){
      const label=page.locator(root+" .link-connector-label");await label.scrollIntoViewIfNeeded();
      const rect=await label.boundingBox();assert.ok(rect);
      await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();
      const moved=page.waitForResponse(r=>r.request().method()==="PATCH"&&new URL(r.url()).pathname===`/api/links/${lid}/position`);
      await page.mouse.move(rect.x+rect.width/2+delta,rect.y+rect.height/2,{steps:4});await page.mouse.up();assert.equal((await moved).status(),200);
      assert.equal(await page.locator(".is-reconnecting").count(),0);assert.equal(await page.locator(".map-editor-drawer").count(),0);
    }
    assert.equal(positionWrites,2);assert.equal(map.links[0].labelPositionX,450);
    // No timer advancement is allowed between a click and selection/panel visibility.
    const label = page.locator(root + " .link-connector-label");
    await label.scrollIntoViewIfNeeded();
    const beforeClick = await label.boundingBox();
    const canvasBefore = await page.locator(".concept-canvas").boundingBox();
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await label.click();
    assert.equal(await page.locator(root + ".is-selected").count(), 1);
    assert.equal(
      await page
        .getByRole("button", { name: "接続を編集", exact: true })
        .count(),
      1,
    );
    assert.equal(await page.locator(".is-reconnecting").count(), 0);
    assert.equal(patches, 0);
    assert.deepEqual(await label.boundingBox(), beforeClick);
    assert.deepEqual(
      await page.locator(".concept-canvas").boundingBox(),
      canvasBefore,
    );
    await page.clock.resume();
    await page
      .getByRole("button", { name: "Drawerを閉じる", exact: true })
      .click();
    await begin();
    assert.equal(await page.locator(root + " .is-connected").count(), 0);
    assert.equal(patches, 0);
    assert.ok(
      await page
        .getByRole("button", { name: "最終提出", exact: true })
        .isDisabled(),
    );
    assert.ok(
      await page
        .getByRole("button", { name: "元に戻す", exact: true })
        .isDisabled(),
    );
    await drag(page, "source", id(6));
    assert.equal(await page.locator(root + " .is-connected").count(), 1);
    assert.equal(patches, 0);
    // Node creation is independent of a saved-link connection draft.
    for (const failure of [true, false]) {
      conceptReject = failure;
      await page.getByRole("button", { name: "＋ 概念", exact: true }).click();
      await page.getByLabel("概念名", { exact: true }).fill("MOCK added");
      const response = page.waitForResponse(
        (r) => r.request().method() === "POST" && r.url().endsWith("/concepts"),
      );
      await page
        .getByRole("button", { name: "概念を追加", exact: true })
        .click();
      assert.equal((await response).status(), failure ? 503 : 201);
      if (failure) {
        await page
          .getByText("Synthetic concept failure", { exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "キャンセル", exact: true })
          .click();
      }
      assert.equal(await page.locator(".is-reconnecting").count(), 1);
      assert.equal(await page.locator(root + " .is-connected").count(), 1);
    }
    await cancel();
    assert.equal(patches, 0);
    await page.locator(root + " .link-connector-label").click();
    await page.getByRole("button", { name: "接続を編集", exact: true }).focus();
    await page.keyboard.press("Enter");
    await region.waitFor();
    await drag(page, "source", id(6));
    reject = true;
    await drag(page, "target", id(7));
    await page
      .getByText("Synthetic reconnect failure", { exact: true })
      .waitFor();
    assert.equal(patches, 1);
    assert.equal(await page.locator(".is-reconnecting").count(), 1);
    reject = false;
    await page
      .getByRole("button", { name: "接続の保存を再試行", exact: true })
      .click();
    await page.locator(".is-reconnecting").waitFor({ state: "detached" });
    assert.equal(patches, 2);
    assert.equal(map.links[0].id, lid);
    assert.equal(map.links[0].sourceConceptId, id(6));
    assert.equal(map.links[0].targetConceptId, id(7));
    assert.equal(map.links[0].labelPositionX, 450);
    assert.equal(map.links[0].labelPositionY, 180);
    await begin();
    await drag(page, "source", id(5));
    await page.reload();
    await page.locator(root).waitFor();
    assert.equal(await page.locator(".is-reconnecting").count(), 0);
    assert.equal(patches, 2);
    // A changed/deleted saved source stops editing and refreshes the visible map.
    const savedLink = { ...map.links[0] };
    await begin();
    map.links[0] = { ...savedLink, label: "MOCK changed elsewhere" };
    await drag(page, "source", id(5));
    await drag(page, "target", id(7));
    await page
      .getByText(
        "保存元のリンクが変更または削除されたため、接続編集を停止しました。再読込して確認してください。",
        { exact: true },
      )
      .waitFor();
    assert.equal(patches, 2);
    assert.equal(await page.locator(".is-reconnecting").count(), 0);
    map.links[0] = savedLink;
    await page.reload();
    await page.locator(root).waitFor();
    await begin();
    map.links = [];
    await drag(page, "source", id(5));
    await drag(page, "target", id(7));
    await page
      .getByText(
        "保存元のリンクが変更または削除されたため、接続編集を停止しました。再読込して確認してください。",
        { exact: true },
      )
      .waitFor();
    assert.equal(await page.locator(root).count(), 0);
    assert.equal(patches, 2);
    map.links = [savedLink];
    await page.reload();
    await page.locator(root).waitFor();
    // The actual line hit target supports double click without consuming a node click.
    const line = page.locator(".concept-edge-hit-target").first();
    await line.scrollIntoViewIfNeeded();
    const point = await line.evaluate((el) => {
      const path = el as SVGPathElement,
        p = path.getPointAtLength(path.getTotalLength() * 0.25),
        m = path.getScreenCTM()!;
      return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
    });
    await page.mouse.dblclick(point.x, point.y);
    await region.waitFor();
    await cancel();
    assert.equal(patches, 2);
    // A second saved link cannot replace the current unsaved draft.
    map.links.push({
      ...savedLink,
      id: id(33),
      label: "MOCK other",
      labelPositionX: 680,
      labelPositionY: 160,
    });
    await page.reload();
    await page.locator(root).waitFor();
    await begin();
    await page
      .locator(`[data-connector-id="${id(33)}"] .link-connector-label`)
      .dblclick();
    await page
      .getByText(
        "接続編集中のリンクを完成または取消してから、別の接続を編集してください。",
        { exact: true },
      )
      .waitFor();
    assert.equal(await page.locator(root + ".is-reconnecting").count(), 1);
    await cancel();
    map.links = [savedLink];
    await page.reload();
    await page.locator(root).waitFor();
    await begin();
    await drag(page, "source", id(5));
    await page
      .getByRole("link", { name: "← セッション画面へ戻る", exact: true })
      .click();
    await page.waitForURL("**/sessions/" + sid);
    assert.equal(await page.locator(".is-reconnecting").count(), 0);
    assert.equal(patches, 2);
    await page.goto(vite.resolvedUrls!.local[0] + `maps/${mid}`);
    await page.locator(root).waitFor();
    // A late preflight after the page becomes read-only must never send PATCH.
    await begin();
    let release = () => {};
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    preflight = () => blocked;
    await drag(page, "source", id(5));
    await drag(page, "target", id(7));
    await page.context().setOffline(true);
    await page.locator(".is-reconnecting").waitFor({ state: "detached" });
    release();
    preflight = null;
    await page.context().setOffline(false);
    assert.equal(patches, 2);
    await page.reload();
    await page.locator(root).waitFor();
    for (const code of [401, 409]) {
      await begin();
      preflightStatus = code;
      await drag(page, "source", id(5));
      await drag(page, "target", id(7));
      await page
        .getByText(
          "接続編集を停止しました。利用権限または保存元を確認できません。再読込して確認してください。",
          { exact: true },
        )
        .waitFor();
      assert.equal(await page.locator(".is-reconnecting").count(), 0);
      assert.equal(patches, 2);
      preflightStatus = 200;
      await page.reload();
      await page.locator(root).waitFor();
    }
    await begin();
    ended = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page
      .getByRole("heading", { name: "実施は終了しました", exact: true })
      .waitFor();
    assert.equal(await page.locator(".is-reconnecting").count(), 0);
    assert.equal(patches, 2);
    ended = false;
    // A late successful PATCH response cannot resurrect a link deleted locally meanwhile.
    await page.reload();
    await page.locator(root).waitFor();
    await begin();
    let finishPatch = () => {};
    patchGate = new Promise<void>((r) => {
      finishPatch = r;
    });
    const requestArrived = page.waitForRequest(
      (r) => r.method() === "PATCH" && r.url().endsWith("/reconnect"),
    );
    await drag(page, "source", id(5));
    await drag(page, "target", id(7));
    await requestArrived;
    const removedConcept = { ...map.concepts.find((c) => c.id === id(6))! };
    await page.locator(`[data-concept-id="${id(6)}"]`).focus();
    await page.keyboard.press("Enter");
    page.once("dialog", (d) => d.accept());
    await page
      .locator(".map-editor-drawer")
      .getByRole("button", { name: "削除", exact: true })
      .click();
    await page.locator(root).waitFor({ state: "detached" });
    const patchReply = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().endsWith("/reconnect"),
    );
    finishPatch();
    await patchReply;
    patchGate = null;
    assert.equal(await page.locator(root).count(), 0);
    assert.equal(map.links.length, 0);
    map.concepts.push(removedConcept);
    map.links = [savedLink];
    // A conditional PATCH conflict must retain the draft, forbid blind retry,
    // and fetch the actual saved connection only when explicitly cancelled.
    await page.reload(); await page.locator(root).waitFor();
    await begin(); await drag(page,"source",id(5));
    conflict=true;
    const conflictReply=page.waitForResponse(r=>r.request().method()==="PATCH"&&r.url().endsWith("/reconnect"));
    await drag(page,"target",id(7)); assert.equal((await conflictReply).status(),409);
    await region.getByRole("alert").waitFor();
    assert.match(await region.innerText(),/接続編集中・未保存/);
    assert.equal(await page.locator(".is-reconnecting").count(),1);
    assert.equal(await page.getByRole("button",{name:"接続の保存を再試行",exact:true}).count(),0);
    const conflictPatches=patches;
    await drag(page,"target",id(6));assert.equal(patches,conflictPatches);
    await cancel();assert.equal(patches,conflictPatches);
    assert.equal(await page.locator(".is-reconnecting").count(),0);
    conflict=false;
    await begin();await drag(page,"source",id(6));
    const freshReply=page.waitForResponse(r=>r.request().method()==="PATCH"&&r.url().endsWith("/reconnect"));
    await drag(page,"target",id(7));assert.equal((await freshReply).status(),200);
    await page.locator(".is-reconnecting").waitFor({state:"detached"});
    assert.equal(patches,conflictPatches+1);
    // Holding the same Map open across a binding change must not apply a
    // successful response from the old screen to the new editor.
    map.links = [{ ...savedLink, sourceConceptId: id(5), targetConceptId: id(6) }];
    await page.reload();
    await page.locator(root).waitFor();
    const savedEdge = page.locator(".concept-edge-hit-target");
    const savedLabel = `Link ${lid}: MOCK 0 → MOCK relation → MOCK 1`;
    assert.equal(await savedEdge.getAttribute("aria-label"), savedLabel);
    await begin();
    patchGate = new Promise<void>((resolve) => { finishPatch = resolve; });
    const isReconnect = (r: { method(): string; url(): string }) =>
      r.method() === "PATCH" && new URL(r.url()).pathname === `/api/links/${lid}/reconnect`;
    const oldRequest = page.waitForRequest(isReconnect);
    await drag(page, "source", id(5));
    await drag(page, "target", id(7));
    await oldRequest;
    await page.evaluate(async ({ sessionId, clientId }) => {
      const authModule = "/src/auth-client.ts";
      const auth = await import(authModule);
      const owner = auth.registerExperimentClientOwner(sessionId);
      auth.bindExperimentClient({
        secret: "SYNTHETIC_SCREEN",
        generation: 2,
        clientId,
      }, owner);
    }, { sessionId: sid, clientId: id(11) });
    await page.locator(".is-reconnecting").waitFor({ state: "detached" });
    const oldReply = page.waitForResponse((r) => isReconnect(r.request()));
    finishPatch();
    const response = await oldReply;
    assert.equal(response.status(), 200);
    await response.finished();
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    patchGate = null;
    assert.equal(map.links[0].targetConceptId, id(7), "fixture accepted the old write");
    assert.equal(await savedEdge.getAttribute("aria-label"), savedLabel);
    assert.equal(await page.getByText("接続を保存しました。", { exact: true }).count(), 0);

    map.links = [savedLink];
    for (const [type, protocol] of [
      ["KB", "SBKB_INTEGRATION_V1"],
      ["INTEGRATION", "SBKB_INTEGRATION_V1"],
      ["PRIOR", "STAGE1_4"],
    ]) {
      map.type = type;
      map.sessionProtocolKey = protocol;
      await page.reload();
      await page.locator(root).waitFor();
      await page.locator(root + " .link-connector-label").dblclick();
      assert.equal(await page.locator(".is-reconnecting").count(), 0);
      assert.equal(
        await page
          .getByRole("button", { name: "接続を編集", exact: true })
          .count(),
        0,
      );
    }
    map.type = "PRIOR";
    map.sessionProtocolKey = "SBKB_INTEGRATION_V1";
    await page.close();
    console.log(`PASS synthetic saved reconnect ${width}`);
  }
} finally {
  await browser.close();
  await vite.close();
}
