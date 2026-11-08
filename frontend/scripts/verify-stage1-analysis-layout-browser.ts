import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? "msedge", headless: true });
const sid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
const mapId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02";
const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03";
const start = "2026-01-01T01:00:00.000Z";
const stages = (types: string[]) => types.map((stageType, orderIndex) => ({
  id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(orderIndex + 10).padStart(12, "0")}`,
  stageType, orderIndex, status: "COMPLETED", startedAt: new Date(Date.parse(start) + orderIndex * 3_600_000).toISOString(),
  completedAt: new Date(Date.parse(start) + (orderIndex * 3_600_000) + 1_200_000).toISOString(),
}));
const before = {
  mapId, mapType: "PRIOR" as const,
  concepts: [
    { id: "c1", mapId, label: "水", positionX: 100, positionY: 100, mergedIntoConceptId: null },
    { id: "c2", mapId, label: "蒸発", positionX: 450, positionY: 100, mergedIntoConceptId: null },
    { id: "c3", mapId, label: "雲", positionX: 780, positionY: 100, mergedIntoConceptId: null },
    { id: "c5", mapId, label: "一時概念", positionX: 100, positionY: 360, mergedIntoConceptId: null },
  ],
  links: [
    { id: "l1", mapId, sourceConceptId: "c1", targetConceptId: "c2", label: "変化する", labelPositionX: 275, labelPositionY: 140 },
    { id: "l2", mapId, sourceConceptId: "c2", targetConceptId: "c3", label: "移動", labelPositionX: 600, labelPositionY: 140 },
  ],
};
const after = {
  ...before,
  concepts: [...before.concepts.filter(item => item.id !== "c5").map(item => item.id === "c2" ? { ...item, positionX: 480 } : item), { id: "c4", mapId, label: "雨", positionX: 450, positionY: 360, mergedIntoConceptId: null }],
  links: [
    { ...before.links[0]!, label: "加熱される", labelPositionX: 295, labelPositionY: 175 },
    { id: "l3", mapId, sourceConceptId: "c3", targetConceptId: "c4", label: "降る", labelPositionX: 600, labelPositionY: 250 },
  ],
};
let safetyFailure: { status: number; code: string; target: string } | null = null;
let protocol = "STAGE1_5";
let emptyHistory = false;
let noSnapshot = false;
let replayUnavailable = false;
let featureMode = "AVAILABLE";
const featureFixture=()=>{
  const available={status:"AVAILABLE",reason:null,activeConcepts:3,hiddenMergeSources:0,links:2};
  const missing={status:"UNAVAILABLE",reason:featureMode,activeConcepts:null,hiddenMergeSources:null,links:null};
  return {featureVersion:"stage1-5-descriptive-v1",protocolKey:"STAGE1_5",sessionId:sid,mapId,sampledAt:start,start:{...(featureMode==="INITIAL_SNAPSHOT_MISSING_OR_INVALID"?missing:available),capturedAt:start},completion:{...(featureMode==="AVAILABLE"?{...available,activeConcepts:2,hiddenMergeSources:2,links:3}:missing),submittedAt:featureMode==="NOT_SUBMITTED"?null:start,eventId:featureMode==="AVAILABLE"?operationId:null,eventType:featureMode==="AVAILABLE"?"MAP_SUBMIT":null},delta:featureMode==="AVAILABLE"?{...available,activeConcepts:-1,hiddenMergeSources:2,links:1}:missing,operationResults:{scope:"SAVED_AT_READ",total:8,rows:["SUCCESS","FAILURE","REJECTED","CANCELLED","UNKNOWN"].map(outcome=>({historySource:"EVENT",actorType:outcome==="SUCCESS"?"SYSTEM":"LEARNER",outcome,count:outcome==="SUCCESS"?3:1})).concat([{historySource:"LEGACY",actorType:"UNRECORDED",outcome:"UNRECORDED",count:1}])}};
};

try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
  const page = await context.newPage();
  await page.addInitScript(() => sessionStorage.setItem("stage1-access-token", "mock-ui-only-long-enough-1234567890"));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (safetyFailure && path.endsWith(safetyFailure.target)) return route.fulfill({ status: safetyFailure.status, json: { error: safetyFailure.code } });
    if (path === "/api/me") return route.fulfill({ json: { role: "researcher" } });
    if(path.endsWith("/descriptive-features"))return protocol==="STAGE1_5"?route.fulfill({json:featureFixture()}):route.fulfill({status:409,json:{error:"wrong_protocol"}});
    if(path.endsWith("/descriptive-features.csv"))return route.fulfill({headers:{"Content-Type":"text/csv","Content-Disposition":"attachment; filename=mock-five-flow.csv"},body:"featureVersion,protocolKey,aggregationPoint,activeConcepts,hiddenMergeSources,links\r\nstage1-5-descriptive-v1,STAGE1_5,completion,2,2,3\r\n"});
    if (path.endsWith("/delivery-status")) return route.fulfill({ json: { clientReported: [], serverVerified: [], missingIsUnknown: true } });
    if (path === `/api/research/stage1/sessions/${sid}/analysis`) {
      const five = protocol === "STAGE1_5";
      return route.fulfill({ json: {
        session: { id: sid, participantCode: "MOCK-01", protocolKey: protocol, studyGroup: five ? null : "EXPERIMENTAL", groupActivitySeconds: five ? null : 3600 },
        stages: stages(five ? ["LESSON", "PRIOR_MAP", "KB_MAP", "INTEGRATION_MAP", "SURVEY"] : ["LESSON", "PRIOR_MAP", "KB_MAP", "INTEGRATION_MAP"]),
        maps: [{ id: mapId, type: "PRIOR", status: "SUBMITTED", researchRole: "learner_map", concepts: before.concepts.map(({id,label})=>({id,label})), links: before.links.map(({id,sourceConceptId,targetConceptId,label})=>({id,sourceConceptId,targetConceptId,label})), historyReplayStatus: "AVAILABLE" }],
        operations: emptyHistory ? [] : [{ id: operationId, mapId, mapType: "PRIOR", researchRole: "learner_map", operationType: "EDIT_LINK", targetId: "l1", targetType: "LINK", sequenceNumber: "1", relatedOperationLogId: null, relatedEventId: "event-related", historySource: "EVENT", eventId: operationId, eventType: "EDIT_LINK", actorType: "LEARNER", outcome: noSnapshot ? "REJECTED" : "SUCCESS", serverTimestamp: start, elapsedMs: 5000, before: noSnapshot ? null : { links: [before.links[0]] }, after: noSnapshot ? null : { links: [after.links[0]] } }],
        operationCounts: emptyHistory ? {} : { EDIT_LINK: 1 }, features: {}, propositionEvaluations: [], reflectionNotes: [], limitations: [],
        ...(five ? { survey: { questions: [
          { id: "q1", kind: "TEXT", prompt: "自由記述の設問", required: true, displayOrder: 0, config: {} },
          { id: "q2", kind: "CHOICE", prompt: "選択式の設問", required: true, displayOrder: 1, config: { options: ["はい", "いいえ"] } },
          { id: "q3", kind: "RATING", prompt: "段階評価の設問", required: false, displayOrder: 2, config: { min: 1, max: 5, minLabel: "低い", maxLabel: "高い" } },
        ], answers: [
          { stageId: "survey-stage", questionId: "q1", answer: "自由記述の回答", updatedAt: start },
          { stageId: "survey-stage", questionId: "q2", answer: "はい", updatedAt: start },
          { stageId: "survey-stage", questionId: "q3", answer: 4, updatedAt: start },
        ], events: [] } } : {}),
      } });
    }
    if (path === `/api/research/stage1/sessions/${sid}/maps/${mapId}/history`) {
      const sequence = new URL(route.request().url()).searchParams.get("sequenceNumber");
      if (sequence === "1" && replayUnavailable) return route.fulfill({ json: { status: "PARTIAL", reason: null, mapId, mapType: "PRIOR", sequenceNumber: 1, operation: null, beforeState: null, afterState: null } });
      if (sequence === "1" && noSnapshot) return route.fulfill({ json: { status: "REPLAYABLE", reason: null, mapId, mapType: "PRIOR", sequenceNumber: 1, operation: { id: operationId, before: null, after: null }, beforeState: before, afterState: before } });
      if (sequence === "1" && !emptyHistory) return route.fulfill({ json: { status: "REPLAYABLE", reason: null, mapId, mapType: "PRIOR", sequenceNumber: 1, operation: null, beforeState: before, afterState: after } });
      if (sequence === "0") return route.fulfill({ json: { status: "REPLAYABLE", reason: null, mapId, mapType: "PRIOR", sequenceNumber: 0, operation: null, beforeState: before, afterState: before } });
      return route.fulfill({ json: { status: "PARTIAL", reason: "mock snapshot unavailable", mapId, mapType: "PRIOR", sequenceNumber: 1, operation: null, beforeState: null, afterState: null } });
    }
    return route.fulfill({ json: {} });
  });
  const url = vite.resolvedUrls!.local[0]!;
  await page.goto(`${url}research/stage1/${sid}/analysis`);
  const featurePanel=page.getByRole("region",{name:"新5活動の記述的特徴量"});
  await featurePanel.waitFor();
  assert.match(await featurePanel.innerText(),/stage1-5-descriptive-v1/);
  assert.deepEqual(await featurePanel.locator('[data-feature-point="completion"] td').allTextContents(),["2","2","3","算出済み"]);
  assert.deepEqual(await featurePanel.locator('[data-feature-point="delta"] td').allTextContents(),["-1","2","1","算出済み"]);
  for(const outcome of ["SUCCESS","FAILURE","REJECTED","CANCELLED","UNKNOWN","UNRECORDED"])assert.ok((await featurePanel.innerText()).includes(outcome));
  const featureDownload=page.waitForEvent("download");await featurePanel.getByRole("button",{name:"新5活動の特徴量CSVを出力"}).click();
  const featureStream=await (await featureDownload).createReadStream();let downloadedFeatures="";for await(const chunk of featureStream)downloadedFeatures+=chunk.toString();assert.match(downloadedFeatures,/stage1-5-descriptive-v1,STAGE1_5,completion,2,2,3/);
  await page.getByRole("heading", { name: "活動概要" }).waitFor();
  assert.equal(await page.getByText("群：", { exact: false }).count(), 0, "5 activity protocol with null group must omit group summary");
  assert.ok((await page.locator(".activity-overview").innerText()).includes("アンケート"));
  assert.ok((await page.locator(".activity-overview").innerText()).includes("実際の学習時間を示すものではありません"));
  await page.getByRole("heading", { name: "アンケート回答" }).waitFor();
  for (const text of ["自由記述の設問", "自由記述の回答", "はい", "段階評価の設問", "4"]) assert.ok((await page.locator(".survey-analysis").innerText()).includes(text));
  assert.equal(await page.locator(".map-history-compare, .map-diff-list").count(), 0, "sequence 0 without a selected operation must not show an empty comparison");
  await page.locator(".operation-history summary").first().click();
  await page.locator(".map-diff-list").filter({ hasText: "＋ 追加" }).waitFor();
  await page.locator(".map-history-compare").waitFor();
  const diff = await page.locator(".map-diff-list").innerText();
  assert.match(diff, /＋ 追加/); assert.match(diff, /− 削除/); assert.match(diff, /↔ 変更/);
  assert.match(diff, /加熱される/); assert.match(diff, /降る/); assert.match(diff, /移動/);
  assert.equal(await page.getByText("状態記録なし", { exact: true }).count(), 0);
  assert.ok(await page.locator(".history-change-tag").filter({ hasText: "＋ 追加" }).count() >= 1, "concept additions have a visible map marker");
  const linkMarkers = await page.locator(".history-change-marker").allTextContents();
  assert.ok(linkMarkers.some(text => text.includes("↔ 変更")), `changed links have a visible map marker; got ${JSON.stringify(linkMarkers)}`);
  for (const [kind, color, line, dash] of [
    ["added", "rgb(54, 131, 85)", "solid", "none"],
    ["removed", "rgb(169, 79, 79)", "dashed", "6px, 4px"],
    ["modified", "rgb(101, 113, 162)", "double", "2px, 3px"],
  ]) {
    const node = page.locator(`.concept-node.is-history-${kind}`).first();
    await node.waitFor();
    assert.ok(!(await node.getAttribute("class"))!.includes("is-history-changed"), "typed differences must not inherit the legacy highlight class");
    assert.deepEqual(await node.evaluate(element => { const css = getComputedStyle(element); return [css.borderTopColor, css.borderTopStyle]; }), [color, line]);
    const edge = page.locator(`g.is-history-${kind} .concept-edge-path`).first();
    await edge.waitFor();
    assert.deepEqual(await edge.evaluate(element => { const css = getComputedStyle(element); return [css.stroke, css.strokeDasharray]; }), [color, dash]);
    const connector = page.locator(`.link-connector.is-history-${kind} .link-connector-label`).first();
    assert.deepEqual(await connector.evaluate(element => { const css = getComputedStyle(element); return [css.outlineColor, css.outlineStyle]; }), [color, line]);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: process.env.ANALYSIS_SCREENSHOT ?? "analysis-layout-mobile.png", fullPage: true });

  noSnapshot = true;
  await page.goto(`${url}research/stage1/${sid}/analysis`);
  await page.locator(".operation-history summary").first().click();
  await page.getByText("状態記録なし：選択した操作の変更前後を復元できません。", { exact: true }).waitFor();
  assert.equal(await page.locator(".map-history-compare").count(), 0, "missing snapshots must not render fabricated map differences");
  assert.equal(await page.locator(".map-diff-list").count(), 0, "reconstructed history is not evidence of event snapshots");
  replayUnavailable = true;
  await page.goto(`${url}research/stage1/${sid}/analysis`);
  await page.locator(".operation-history summary").first().click();
  await page.getByText("状態記録なし：選択した操作の変更前後を復元できません。", { exact: true }).waitFor();
  assert.equal(await page.locator(".map-history-compare").count(), 0);

  emptyHistory = true;
  protocol = "STAGE1_6";
  await page.goto(`${url}research/stage1/${sid}/analysis`);
  await page.getByText("このマップの操作履歴はありません。", { exact: true }).waitFor();
  const oldText = await page.locator(".activity-overview").innerText();
  assert.match(oldText, /群：EXPERIMENTAL/);
  assert.match(oldText, /記録時刻の差/);
  assert.equal(await page.getByRole("region",{name:"新5活動の記述的特徴量"}).count(),0);
  protocol = "STAGE1_4";
  await page.goto(`${url}research/stage1/${sid}/analysis`);
  await page.getByText("フロー：4活動（旧形式）",{exact:true}).waitFor();
  assert.match(await page.locator(".stage1-analysis-heading").innerText(), /4活動（旧形式）/);
  assert.equal(await page.getByRole("region",{name:"新5活動の記述的特徴量"}).count(),0);
  protocol="STAGE1_5";
  for(const mode of ["NOT_SUBMITTED","INITIAL_SNAPSHOT_MISSING_OR_INVALID","HISTORY_INCONSISTENT"]){featureMode=mode;await page.goto(`${url}research/stage1/${sid}/analysis`);await featurePanel.waitFor();const row=featurePanel.locator('[data-feature-point="completion"]');assert.deepEqual((await row.locator("td").allTextContents()).slice(0,3),["算出不可","算出不可","算出不可"]);if(mode==="NOT_SUBMITTED")assert.match(await row.innerText(),/未提出/);}
  // Fixed safety messages survive API, save and download error paths; no file starts.
  protocol = "STAGE1_4";
  let downloads = 0;
  page.on("download", () => downloads++);
  for (const [status, code, message] of [
    [422, "safety_budget_exceeded", "安全確認の処理量上限を超えました。"],
    [503, "safety_lookup_unavailable", "安全確認を行えませんでした。"],
  ] as const) {
    safetyFailure = { status, code, target: "/analysis" };
    await page.goto(`${url}research/stage1/${sid}/analysis`);
    await page.getByText(message, { exact: false }).waitFor();
    safetyFailure = null;
    await page.goto(`${url}research/stage1/${sid}/analysis`);
    await page.getByRole("heading", { name: "活動概要" }).waitFor();
    safetyFailure = { status, code, target: "/reflections" };
    await page.getByLabel("記録者・報告者コード").fill("R-test");
    await page.getByLabel("振り返りの記録").fill("テスト専用の通常文章");
    await page.getByRole("button", { name: "メモを保存", exact: true }).click();
    await page.getByText(message, { exact: false }).waitFor();
    assert.equal(await page.getByLabel("振り返りの記録").inputValue(), "テスト専用の通常文章");
    safetyFailure = { status, code, target: "/reflections.csv" };
    const failedCsv = page.waitForResponse(r => r.url().endsWith("/reflections.csv") && r.status() === status);
    await page.getByRole("button", { name: "振り返りCSV", exact: true }).click();
    await failedCsv;
    await page.getByText(message, { exact: false }).waitFor();
    assert.equal(downloads, 0, "failed CSV must not download JSON as a file");
  }
  console.log("Mock API browser: 5/6/4 activity summaries, no-group vs retained historical group, empty operation history, no-snapshot label with no fabricated diff, change/add/delete link rendering, TEXT/CHOICE/RATING survey answers, responsive layout: PASS");
  await context.close();
} finally {
  await browser.close();
  await vite.close();
}
