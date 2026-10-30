import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "msedge",
  headless: true,
});
const session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  map = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
try {
  const page = await browser.newPage();
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "stage1-access-token",
      "mock-only-ui-contract-token-1234567890123456",
    ),
  );
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me")
      return route.fulfill({ json: { role: "researcher" } });
    if (path.endsWith("/analysis"))
      return route.fulfill({
        json: {
          session: {
            id: session,
            participantCode: "P-MOCK",
            protocolKey: "STAGE1_4",
          },
          maps: [
            {
              id: map,
              type: "PRIOR",
              status: "SUBMITTED",
              researchRole: "learner_map",
              concepts: [],
              links: [],
              historyReplayStatus: "AVAILABLE",
            },
          ],
          operations: [],
          operationCounts: {},
          features: {},
          propositionEvaluations: [],
          reflectionNotes: [],
          limitations: [],
        },
      });
    if (path.endsWith("/history"))
      return route.fulfill({
        json: {
          status: "UNAVAILABLE",
          reason: "模擬検証：初期スナップショットがありません。",
          mapId: map,
          mapType: "PRIOR",
          sequenceNumber: 0,
          operation: null,
          beforeState: null,
          afterState: null,
        },
      });
    if (path.endsWith("/delivery-status"))
      return route.fulfill({
        json: {
          clientReported: [],
          serverVerified: [],
          missingIsUnknown: true,
        },
      });
    return route.fulfill({ status: 404, json: { error: "mock_not_found" } });
  });
  await page.goto(
    vite.resolvedUrls!.local[0] + "research/stage1/" + session + "/analysis",
  );
  await page
    .getByText("模擬検証：初期スナップショットがありません。", { exact: false })
    .waitFor();
  assert.equal(
    await page.getByText("選択操作の直前", { exact: true }).count(),
    0,
  );
  await page
    .getByText("ブラウザーからの状態報告はありません。欠損の有無は不明です。", {
      exact: true,
    })
    .waitFor();
  console.log(
    "Researcher UI contract fixture: unavailable replay reason and unreported delivery are visible; no invented comparison: PASS",
  );
  // Render the real learner component with mock HTTP data; no research database is used.
  const stage = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    question = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await page.unroute("**/api/**");
  let saves = 0;
  await page.route("**/api/**", (route) => {
    if (
      new URL(route.request().url()).pathname ===
      `/api/session-stages/${stage}/assessment`
    )
      return route.fulfill({
        json: {
          questions: [
            {
              id: question,
              prompt: "MOCK 操作確認問題",
              displayOrder: 1,
              answer: "",
            },
          ],
        },
      });
    if (route.request().method() === "POST") saves++;
    return route.fulfill({ status: 200, json: {} });
  });
  await page.evaluate(
    async ({ session, stage }) => {
      const assessment = await import("/src/Assessment.tsx");
      const React = await import("/node_modules/.vite/deps/react.js");
      const ReactDOM =
        await import("/node_modules/.vite/deps/react-dom_client.js");
      document.body.innerHTML = '<div id="assessment-audit-root"></div>';
      ReactDOM.default
        .createRoot(document.getElementById("assessment-audit-root")!)
        .render(
          React.default.createElement(assessment.LearnerAssessment, {
            sessionId: session,
            stageId: stage,
            onSubmitted: Promise.resolve.bind(Promise),
          }),
        );
    },
    { session, stage },
  );
  await page.getByLabel("問題 1：MOCK 操作確認問題").fill("MOCK 未保存回答");
  assert.equal(
    await page.evaluate(() =>
      Object.keys(localStorage).some((k) =>
        k.startsWith("stage1-assessment-draft-v2:"),
      ),
    ),
    true,
  );
  await page
    .getByLabel("問題 1：MOCK 操作確認問題")
    .fill("Bearer example-credential-not-to-cache");
  await page
    .getByText(
      "ブラウザーに一時保存できません。入力内容は画面内にあります。保存状態を確認してください。",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.evaluate(() =>
      Object.values(localStorage).some((v) =>
        v.includes("example-credential-not-to-cache"),
      ),
    ),
    false,
  );
  await page.evaluate(async (id) => {
    const drafts = await import("/src/assessment-drafts.ts");
    const identity = await import("/src/client-identity.ts");
    drafts.discardAssessmentDrafts(identity.requestDigest(id));
  }, session);
  await page
    .getByRole("alert")
    .filter({ hasText: "このセッションの研究データは削除されています。" })
    .waitFor();
  assert.equal(
    await page.locator("#assessment-audit-root textarea").count(),
    0,
  );
  assert.equal(await page.locator("#assessment-audit-root button").count(), 0);
  assert.equal(
    await page.evaluate(() =>
      Object.keys(localStorage).some((k) =>
        k.startsWith("stage1-assessment-draft-v2:"),
      ),
    ),
    false,
  );
  assert.equal(saves, 0);
  console.log(
    "Learner assessment: scoped draft, unsafe input not cached, deletion clears visible answer and controls: PASS",
  );
  await page.route(
    "**/api/research/event-views/mock-feedback?offset=0",
    (route) =>
      route.fulfill({
        json: {
          events: [
            {
              event_id: "mock-feedback",
              schema_version:6, feedback_match:false,
              server_timestamp: "2026-01-01T00:00:00.000Z",
              client_timestamp: null,
              session_id: null,
              learner_id: "P-MOCK",
              study_group: null,
              activity: "KIT_BUILD",
              event_type: "FEEDBACK_CHECK",
              actor_type: "LEARNER",
              outcome: "SUCCESS",
              payload_status: "VALID",
              boundary_status: "NOT_APPLICABLE",
              before_quality: "NOT_APPLICABLE",
              after_quality: "NOT_APPLICABLE",
              reason_code: null,
              target_id: null,
              related_event_id: null,
            },
          ].flatMap(event=>[
            event,
            {...event,event_id:"mock-feedback-match",feedback_match:true},
            {...event,event_id:"mock-feedback-rejected",outcome:"REJECTED",feedback_match:null,reason_code:"VALIDATION"},
            {...event,event_id:"mock-feedback-failed",outcome:"FAILURE",feedback_match:null,reason_code:"SERVER"},
            {...event,event_id:"mock-feedback-legacy",schema_version:1,outcome:"REJECTED",feedback_match:null},
          ]),
          next: null,
        },
      }),
  );
  await page.evaluate(async () => {
    const Timeline = await import("/src/EventTimeline.tsx");
    const React = await import("/node_modules/.vite/deps/react.js");
    const ReactDOM =
      await import("/node_modules/.vite/deps/react-dom_client.js");
    const host = document.createElement("div");
    document.body.append(host);
    ReactDOM.default
      .createRoot(host)
      .render(
        React.default.createElement(Timeline.default, {
          exportId: "mock-feedback",
          eventNames: { FEEDBACK_CHECK: "一致確認" },
          activityNames: { KIT_BUILD: "Kit-Build" },
          groupNames: {},
        }),
      );
  });
  await page
    .getByRole("cell", { name: "不一致（確認完了）", exact: true })
    .waitFor();
  for(const name of ["一致（確認完了）","拒否","失敗","不一致（旧形式・確認完了）"])await page.getByRole("cell",{name,exact:true}).waitFor();
  console.log(
    "Timeline FEEDBACK_CHECK v1/v6 mismatch, match, rejection and failure is visibly distinguished from a failed check: PASS",
  );
} finally {
  await browser.close();
  await vite.close();
}
