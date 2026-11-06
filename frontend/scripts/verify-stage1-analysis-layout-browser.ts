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
  ],
  links: [
    { id: "l1", mapId, sourceConceptId: "c1", targetConceptId: "c2", label: "変化する", labelPositionX: 275, labelPositionY: 140 },
    { id: "l2", mapId, sourceConceptId: "c2", targetConceptId: "c3", label: "移動", labelPositionX: 600, labelPositionY: 140 },
  ],
};
const after = {
  ...before,
  concepts: [...before.concepts, { id: "c4", mapId, label: "雨", positionX: 450, positionY: 360, mergedIntoConceptId: null }],
  links: [
    { ...before.links[0]!, label: "加熱される", labelPositionX: 295, labelPositionY: 175 },
    { id: "l3", mapId, sourceConceptId: "c3", targetConceptId: "c4", label: "降る", labelPositionX: 600, labelPositionY: 250 },
  ],
};
let protocol = "STAGE1_5";
let emptyHistory = false;
let noSnapshot = false;
let replayUnavailable = false;

try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
  const page = await context.newPage();
  await page.addInitScript(() => sessionStorage.setItem("stage1-access-token", "mock-ui-only-long-enough-1234567890"));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: { role: "researcher" } });
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
  await page.getByRole("heading", { name: "活動概要" }).waitFor();
  assert.equal(await page.getByText("群：", { exact: false }).count(), 0, "5 activity protocol with null group must omit group summary");
  assert.ok((await page.locator(".activity-overview").innerText()).includes("アンケート"));
  assert.ok((await page.locator(".activity-overview").innerText()).includes("実際の学習時間を示すものではありません"));
  await page.getByRole("heading", { name: "アンケート回答" }).waitFor();
  for (const text of ["自由記述の設問", "自由記述の回答", "はい", "段階評価の設問", "4"]) assert.ok((await page.locator(".survey-analysis").innerText()).includes(text));
  await page.locator(".operation-history summary").first().click();
  await page.getByText("変更点", { exact: true }).waitFor();
  const diff = await page.locator(".map-diff-list").innerText();
  assert.match(diff, /＋ 追加/); assert.match(diff, /− 削除/); assert.match(diff, /↔ 変更/);
  assert.match(diff, /加熱される/); assert.match(diff, /降る/); assert.match(diff, /移動/);
  assert.equal(await page.getByText("状態記録なし", { exact: true }).count(), 0);
  assert.ok(await page.locator(".history-change-tag").filter({ hasText: "＋ 追加" }).count() >= 1, "concept additions have a visible map marker");
  const linkMarkers = await page.locator(".history-change-marker").allTextContents();
  assert.ok(linkMarkers.some(text => text.includes("↔ 変更")), `changed links have a visible map marker; got ${JSON.stringify(linkMarkers)}`);
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
  protocol = "STAGE1_4";
  await page.goto(`${url}research/stage1/${sid}/analysis`);
  assert.match(await page.locator(".stage1-analysis-heading").innerText(), /4活動（旧形式）/);
  console.log("Mock API browser: 5/6/4 activity summaries, no-group vs retained historical group, empty operation history, no-snapshot label with no fabricated diff, change/add/delete link rendering, TEXT/CHOICE/RATING survey answers, responsive layout: PASS");
  await context.close();
} finally {
  await browser.close();
  await vite.close();
}
