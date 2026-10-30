import {LearnerDeliveryStatus,ResearchDeliveryStatus} from "./DeliveryStatus";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, uiText } from "./auth-client";
import { sendObservedLearningEvent, useObservedLearningScreen, type ObservedLearningEvent } from "./learning-events";
import { LearnerAssessment, ResearchAssessment } from "./Assessment";
import { ReadOnlyMapSnapshot, type HistoricalMapSnapshot } from "./MapPage";

type StageType = "LESSON" | "PRIOR_MAP" | "KB_MAP" | "INTEGRATION_MAP" | "PRE_ASSESSMENT" | "POST_ASSESSMENT" | "SELF_STUDY";
type StageStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED";
type SessionStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
type StudyMap = { id: string; type: "PRIOR" | "KB" };
type StudyMapContent = { id: string; type: "PRIOR" | "KB"; status: string; sessionId: string; concepts: HistoricalMapSnapshot["concepts"]; links: HistoricalMapSnapshot["links"] };
type StudySnapshots = { prior: HistoricalMapSnapshot; kb: HistoricalMapSnapshot };

type SessionStage = {
  id: string;
  sessionId: string;
  stageType: StageType;
  orderIndex: number;
  status: StageStatus;
  startedAt: string | null;
  completedAt: string | null;
  mapId: string | null;
};

type SessionFlow = {
  session: {
    id: string;
    status: SessionStatus;
    startedAt: string | null;
    completedAt: string | null;
    protocolKey: string;
    lessonVideoUrl: string | null;
    researchKitDefinitionId: string | null;
    studyGroup: "EXPERIMENTAL" | "CONTROL" | null;
    groupActivitySeconds: number | null;
  };
  serverNow: string;
  currentMapSubmitted: boolean;
  currentIntegrationMapExists: boolean;
  currentMapAutoSubmittedAt: string | null;
  stages: SessionStage[];
  currentStage: SessionStage | null;
  nextStage: SessionStage | null;
};

const stageLabels: Record<StageType, string> = {
  LESSON: "STEP 1：授業動画",
  PRIOR_MAP: "STEP 2：Scratch-Build",
  KB_MAP: "STEP 3：Kit-Build",
  INTEGRATION_MAP: "STEP 4：統合",
  PRE_ASSESSMENT: "STEP 4：事前評価",
  SELF_STUDY: "STEP 5：自主学習",
  POST_ASSESSMENT: "STEP 6：事後評価",
};

const stageSlugs: Record<StageType, string> = {
  LESSON: "lesson",
  PRIOR_MAP: "prior",
  KB_MAP: "kb",
  INTEGRATION_MAP: "integration",
  PRE_ASSESSMENT: "pre-assessment",
  SELF_STUDY: "self-study",
  POST_ASSESSMENT: "post-assessment",
};

function messageFrom(payload: unknown) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return uiText(payload.message);
  }
  return "リクエストを完了できませんでした。セッションの状態を再読み込みしてください。";
}

async function requestJson<T>(path: string, method = "GET", body?: unknown) {
  const result = await apiFetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload: unknown = await result.json().catch(() => null);
  if (!result.ok) throw new Error(messageFrom(payload));
  return payload as T;
}

export default function SessionFlowPage({
  sessionId,
  requestedStageSlug,
  isLearner = false,
}: {
  sessionId: string;
  requestedStageSlug?: string;
  isLearner?: boolean;
}) {
  return (
    <SessionDashboard
      key={sessionId}
      sessionId={sessionId}
      requestedStageSlug={requestedStageSlug}
      isLearner={isLearner}
    />
  );
}

function SessionDashboard({
  sessionId,
  requestedStageSlug,
  isLearner,
}: {
  sessionId: string;
  requestedStageSlug?: string;
  isLearner: boolean;
}) {
  const [flow, setFlow] = useState<SessionFlow | null>(null);
  const [serverOffset, setServerOffset] = useState(0);
  const [clock, setClock] = useState(() => performance.now());
  const [studyMaps, setStudyMaps] = useState<Array<{ id: string; type: string }>>([]);
  const [studySnapshots, setStudySnapshots] = useState<StudySnapshots | null>(null);
  const [studyStatus, setStudyStatus] = useState<"loading" | "ready" | "error">("loading");
  const [studyRetry, setStudyRetry] = useState(0);
  const integrationSubmitted = flow?.currentMapSubmitted ?? false;
  const [confirmedVideoViewed, setConfirmedVideoViewed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activityLogWarning, setActivityLogWarning] = useState(false);
  const noteActivityLogFailure = useCallback(() => setActivityLogWarning(true), []);
  const currentStageId = flow?.currentStage?.id;
  const currentStageStatus = flow?.currentStage?.status;
  const currentStageType = flow?.currentStage?.stageType;
  useObservedLearningScreen(sessionId, currentStageId, undefined, isLearner && currentStageStatus === "IN_PROGRESS", noteActivityLogFailure);
  const studyExpired = flow?.session.protocolKey === "STAGE1_6" && currentStageType === "SELF_STUDY" && !!flow.currentStage?.startedAt && flow.session.groupActivitySeconds !== null && clock + serverOffset >= Date.parse(flow.currentStage.startedAt) + flow.session.groupActivitySeconds * 1000;
  const integrationExpired = flow?.session.protocolKey === "STAGE1_6" && flow.session.studyGroup === "EXPERIMENTAL" && currentStageType === "INTEGRATION_MAP" && currentStageStatus === "IN_PROGRESS" && !!flow.currentStage?.startedAt && flow.session.groupActivitySeconds !== null && clock + serverOffset >= Date.parse(flow.currentStage.startedAt) + flow.session.groupActivitySeconds * 1000;

  const reload = useCallback(async () => {
    const requestedAt = performance.now();
    const nextFlow = await requestJson<SessionFlow>(
      `/api/sessions/${sessionId}/flow`,
    );
    if (!["STAGE1_4", "STAGE1_6"].includes(nextFlow.session.protocolKey)) {
      throw new Error("このセッションは活動 1の学習フローではありません。");
    }
    setServerOffset(Date.parse(nextFlow.serverNow) - requestedAt);
    setClock(performance.now());
    setFlow(nextFlow);
  }, [sessionId]);

  useEffect(() => {
    let active = true;
    const requestedAt = performance.now();
    requestJson<SessionFlow>(`/api/sessions/${sessionId}/flow`)
      .then((nextFlow) => {
        if (!active) return;
        if (!["STAGE1_4", "STAGE1_6"].includes(nextFlow.session.protocolKey)) {
          throw new Error("このセッションは活動 1の学習フローではありません。");
        }
        setServerOffset(Date.parse(nextFlow.serverNow) - requestedAt);
        setClock(performance.now());
        setFlow(nextFlow);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "セッションの状態を読み込めませんでした。",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  useEffect(() => {
    const id = window.setInterval(() => setClock(performance.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const stage = flow?.currentStage;
    if (flow?.session.protocolKey !== "STAGE1_6" || !stage?.startedAt || stage.status !== "IN_PROGRESS" || !["SELF_STUDY", "INTEGRATION_MAP"].includes(stage.stageType) || flow.session.groupActivitySeconds === null) return;
    const deadline = Date.parse(stage.startedAt) + flow.session.groupActivitySeconds * 1000 - serverOffset;
    const timer = window.setTimeout(() => {
      setClock(performance.now());
      if (stage.stageType === "SELF_STUDY" && isLearner) setStudySnapshots(null);
    }, Math.max(0, deadline - performance.now()));
    return () => window.clearTimeout(timer);
  }, [flow, serverOffset, isLearner]);

  useEffect(() => {
    if (flow?.session.protocolKey !== "STAGE1_6" || flow.session.studyGroup !== "CONTROL" || flow.session.status !== "IN_PROGRESS" || currentStageType !== "SELF_STUDY" || currentStageStatus !== "IN_PROGRESS" || (isLearner && studyExpired)) return;
    let active = true;
    let checking = false;
    const controller = new AbortController();
    async function refreshStudyMaps() {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      try {
        const response = await apiFetch(`/api/sessions/${sessionId}/self-study-maps`, { signal: controller.signal });
        if (!active) return;
        if (response.status === 409 || response.status === 404) {
          setStudyMaps([]);
          setStudySnapshots(null);
          setStudyStatus("error");
          await reload();
          return;
        }
        if (!response.ok) throw new Error("self-study map fetch failed");
        const data = (await response.json()) as { maps: StudyMap[] };
        if (!isLearner) {
          if (active) setStudyMaps(data.maps);
          return;
        }
        const prior = data.maps.filter(map => map.type === "PRIOR");
        const kb = data.maps.filter(map => map.type === "KB");
        if (data.maps.length !== 2 || prior.length !== 1 || kb.length !== 1) throw new Error("invalid study maps");
        const responses = await Promise.all([prior[0], kb[0]].map(map => apiFetch(`/api/maps/${encodeURIComponent(map.id)}`, { signal: controller.signal })));
        if (!active) return;
        if (responses.some(result => result.status === 404 || result.status === 409)) {
          setStudySnapshots(null);
          setStudyStatus("error");
          await reload();
          return;
        }
        if (responses.some(result => !result.ok)) throw new Error("study map content fetch failed");
        const maps = await Promise.all(responses.map(result => result.json() as Promise<StudyMapContent>));
        if (maps.some((map, index) => map.id !== [prior[0].id, kb[0].id][index] || map.type !== ["PRIOR", "KB"][index] || map.sessionId !== sessionId || map.status !== "SUBMITTED" || !Array.isArray(map.concepts) || !Array.isArray(map.links))) throw new Error("invalid study map content");
        if (active) {
          const snapshot = (map: StudyMapContent): HistoricalMapSnapshot => ({ mapId: map.id, mapType: map.type, concepts: map.concepts, links: map.links });
          setStudySnapshots({ prior: snapshot(maps[0]), kb: snapshot(maps[1]) });
          setStudyStatus("ready");
        }
      } catch {
        if (active) {
          setStudyMaps([]);
          setStudySnapshots(null);
          setStudyStatus("error");
        }
      } finally {
        checking = false;
      }
    }
    void refreshStudyMaps();
    const interval = isLearner ? window.setInterval(() => void refreshStudyMaps(), 5000) : undefined;
    const recheck = () => void refreshStudyMaps();
    if (isLearner) {
      window.addEventListener("focus", recheck);
      document.addEventListener("visibilitychange", recheck);
    }
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
      if (isLearner) setStudySnapshots(null);
    };
  }, [currentStageId, currentStageStatus, currentStageType, flow?.session.protocolKey, flow?.session.studyGroup, flow?.session.status, isLearner, reload, sessionId, studyRetry, studyExpired]);

  useEffect(() => {
    if (!integrationExpired || !flow?.currentIntegrationMapExists || flow.currentMapSubmitted) return;
    let active = true;
    const refresh = () => void reload().then(() => {
      if (active) setError(current => current === "自動提出の状態を確認できません。接続を確認してください。" ? null : current);
    }).catch(() => { if (active) setError("自動提出の状態を確認できません。接続を確認してください。"); });
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [integrationExpired, flow?.currentIntegrationMapExists, flow?.currentMapSubmitted, reload]);

  async function completeTimed() {
    if (!flow?.currentStage || busy) return;
    setBusy(true);
    setError(null);
    try {
      const completion = await requestJson<{ logSaved?: boolean }>(`/api/session-stages/${flow.currentStage.id}/complete`, "POST", {});
      if (completion.logSaved === false) noteActivityLogFailure();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "活動を完了できませんでした。");
    } finally { setBusy(false); }
  }

  async function startSession() {
    setBusy(true);
    setError(null);
    try {
      const started = await requestJson<{ logSaved?: boolean }>(`/api/sessions/${sessionId}/start`, "POST", {});
      if (started.logSaved === false) noteActivityLogFailure();
      await reload();
    } catch (startError) {
      setError(
        startError instanceof Error
          ? startError.message
          : "セッションを開始できませんでした。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function openCurrentStage() {
    if (!flow?.currentStage || busy) return;
    const stage = flow.currentStage;
    setBusy(true);
    setError(null);
    try {
      const started = await requestJson<{ logSaved?: boolean }>(`/api/session-stages/${stage.id}/start`, "POST", {});
      if (started.logSaved === false) noteActivityLogFailure();
      if (["LESSON", "SELF_STUDY", "PRE_ASSESSMENT", "POST_ASSESSMENT"].includes(stage.stageType)) {
        await reload();
        return;
      }
      if (isLearner && stage.stageType === "INTEGRATION_MAP") {
        const map = await requestJson<{ id: string; kitDefinitionId: string }>(
          `/api/session-stages/${stage.id}/integration-map`, "POST",
        );
        const currentMap = await requestJson<{ kitDefinitionId: string | null }>(
          `/api/maps/${map.id}`,
        );
        if (!currentMap.kitDefinitionId) {
          await requestJson(`/api/maps/${map.id}/kit-definition`, "PATCH", {
            kitDefinitionId: map.kitDefinitionId,
          });
        }
        window.location.assign(`/maps/${map.id}`);
        return;
      }
      if (stage.mapId) {
        window.location.assign(`/maps/${stage.mapId}`);
        return;
      }

      let map: { id: string };
      if (stage.stageType === "PRIOR_MAP") {
        map = await requestJson(`/api/session-stages/${stage.id}/prior-map`, "POST");
      } else if (stage.stageType === "KB_MAP") {
        const kitId = flow.session.researchKitDefinitionId;
        if (!kitId) throw new Error("このセッションにKitが割り当てられていません。");
        map = await requestJson(`/api/kits/${kitId}/kb-map`, "POST", {
          sessionStageId: stage.id,
        });
      } else {
        const priorStage = flow.stages.find((item) => item.stageType === "PRIOR_MAP");
        const kbStage = flow.stages.find((item) => item.stageType === "KB_MAP");
        if (!priorStage?.mapId || !kbStage?.mapId) {
          throw new Error("Scratch-BuildまたはKit-Build マップが見つかりません。");
        }
        const kbMap = await requestJson<{ kitDefinitionId: string | null }>(
          `/api/maps/${kbStage.mapId}`,
        );
        if (!kbMap.kitDefinitionId) {
          throw new Error("Kit-Build マップにKitDefinitionが設定されていません。");
        }
        map = await requestJson(`/api/maps/${priorStage.mapId}/integration`, "POST", {
          sessionStageId: stage.id,
        });
        await requestJson(`/api/maps/${map.id}/kit-definition`, "PATCH", {
          kitDefinitionId: kbMap.kitDefinitionId,
        });
      }
      window.location.assign(`/maps/${map.id}`);
    } catch (openError) {
      setError(
        openError instanceof Error
          ? openError.message
          : "活動を開始できませんでした。",
      );
      await reload().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function completeLesson() {
    const stage = flow?.currentStage;
    if (!stage || stage.stageType !== "LESSON" || busy) return;
    if (!confirmedVideoViewed) {
      setError("動画を視聴したことを確認してから進んでください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const completion = await requestJson<{ logSaved?: boolean }>(`/api/session-stages/${stage.id}/complete`, "POST", {});
      if (completion.logSaved === false) noteActivityLogFailure();
      await reload();
    } catch (completeError) {
      setError(
        completeError instanceof Error
          ? completeError.message
          : "授業動画活動を完了できませんでした。",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className={`page session-page${isLearner ? " is-learner" : ""}`}>
        <p role="status">セッションを読み込んでいます…</p>
      </main>
    );
  }
  if (!flow) {
    return (
      <main className={`page session-page${isLearner ? " is-learner" : ""}`}>
        <section className="session-card" role="alert">
          <h1>セッションを開けません</h1>
          <p>{error ?? "セッションが見つかりません。"}</p>
          <a className="back-link" href="/">トップへ戻る</a>
        </section>
      </main>
    );
  }

  const requestedStage = flow.stages.find(
    (stage) => stageSlugs[stage.stageType] === requestedStageSlug,
  );
  const requestedStageBlocked =
    requestedStageSlug !== undefined &&
    requestedStage !== undefined &&
    requestedStage.status !== "COMPLETED" &&
    requestedStage.id !== flow.currentStage?.id;
  const current = flow.currentStage;
  const label = (stage: SessionStage) => {
    if (isLearner && (stage.stageType === "PRE_ASSESSMENT" || stage.stageType === "POST_ASSESSMENT")) return "評価問題";
    return flow.session.protocolKey === "STAGE1_6"
      ? `STEP ${stage.orderIndex + 1}：${stage.stageType === "INTEGRATION_MAP" ? "統合マップ" : stageLabels[stage.stageType].replace(/^STEP \d+：/, "")}`
      : stageLabels[stage.stageType];
  };
  const timed = flow.session.protocolKey === "STAGE1_6" && (current?.stageType === "SELF_STUDY" || current?.stageType === "INTEGRATION_MAP");
  const remaining = timed && current?.startedAt && flow.session.groupActivitySeconds !== null
    ? Math.max(0, Math.ceil((Date.parse(current.startedAt) + flow.session.groupActivitySeconds * 1000 - (clock + serverOffset)) / 1000)) : null;

  return (
    <main className={`page session-page${isLearner ? " is-learner" : ""}${isLearner && timed && current?.stageType === "SELF_STUDY" && current.status === "IN_PROGRESS" && flow.session.studyGroup === "CONTROL" ? " is-study-comparison" : ""}`}>
      <section className="session-card" aria-labelledby="session-title">
        <h1 id="session-title">学習・再構成フロー</h1>
        {!isLearner && (
          <p className="session-id">セッション ID: {flow.session.id} <a href={`/research/event-exports?sessionId=${sessionId}`}>研究イベントを絞り込み出力</a></p>
        )}

        {flow.session.status === "NOT_STARTED" && (
          <div className="session-current-panel">
            <h2>セッションを開始してください</h2>
            <p>開始後、最初の活動から順番に進みます。</p>
            {isLearner && <p><a className="session-secondary-button" href="/tutorial">操作の練習</a></p>}
            <button className="session-primary-button" type="button" disabled={busy} onClick={() => void startSession()}>
              {busy ? "開始中…" : "セッションを開始"}
            </button>
          </div>
        )}

        {flow.session.status === "IN_PROGRESS" && current && (
          <div className="session-current-panel">
            <p className="session-current-label">現在の活動</p>
            <h2>{label(current)}</h2>
            {isLearner && current.status === "PENDING" && <p>{current.stageType === "LESSON" ? "開始後に動画を視聴し、視聴したことを確認してください。" : current.stageType === "SELF_STUDY" ? "開始すると提出済みの2枚のマップを確認できます。" : current.stageType === "PRE_ASSESSMENT" || current.stageType === "POST_ASSESSMENT" ? "開始して、表示される問題に回答してください。" : "開始してマップを操作してください。"}</p>}
            {!isLearner && flow.nextStage && (
              <p className="session-next-label">
                次の活動: {label(flow.nextStage)}
              </p>
            )}
            {(!(current.stageType === "PRE_ASSESSMENT" || current.stageType === "POST_ASSESSMENT") || current.status === "PENDING") && !(isLearner && current.stageType === "INTEGRATION_MAP" && (integrationSubmitted || (timed && current.status === "IN_PROGRESS" && remaining === 0))) && !(isLearner && current.status === "IN_PROGRESS" && (current.stageType === "LESSON" || current.stageType === "SELF_STUDY")) && <button
              className="session-primary-button"
              type="button"
              disabled={busy}
              onClick={() => void openCurrentStage()}
            >
              {busy
                ? "準備中…"
                : current.status === "IN_PROGRESS"
                  ? "続ける"
                  : "開始する"}
            </button>}
            {(current.stageType === "PRE_ASSESSMENT" || current.stageType === "POST_ASSESSMENT") && current.status === "IN_PROGRESS" && <LearnerAssessment sessionId={sessionId} key={current.id} stageId={current.id} onSubmitted={async (logSaved) => { if (!logSaved) noteActivityLogFailure(); await reload(); }} />}
            {timed && current.status === "IN_PROGRESS" && <div className="session-timed-activity">
              <p className="session-timer">残り時間: {remaining === null ? "取得中" : `${Math.floor(remaining / 60)}分${remaining % 60}秒`}</p>
              {current.stageType === "SELF_STUDY" && flow.session.studyGroup === "CONTROL" && isLearner && remaining === 0 && <p role="status">時間が終了しました。</p>}
              {current.stageType === "SELF_STUDY" && flow.session.studyGroup === "CONTROL" && (!isLearner || (remaining !== null && remaining > 0)) && <div className="session-study-maps"><p>提出済みのマップを読み取り専用で確認してください。各マップは拡大・縮小やスクロールができます。</p>
                {isLearner ? <>
                  {studyStatus === "loading" && <p role="status">2枚のマップを読み込んでいます…</p>}
                  {studyStatus === "error" && <div className="session-study-error" role="alert"><p>2枚のマップを表示できませんでした。接続を確認し、もう一度お試しください。解決しない場合は研究者に連絡してください。</p><button type="button" className="session-secondary-button" onClick={() => { setStudyStatus("loading"); setStudyRetry(value => value + 1); }}>再読み込み</button></div>}
                  {studyStatus === "ready" && studySnapshots && <div className="session-study-compare"><ReadOnlyMapSnapshot key={studySnapshots.prior.mapId} snapshot={studySnapshots.prior} title="Scratch-Build（自分が提出したマップ）" allowZoom /><ReadOnlyMapSnapshot key={studySnapshots.kb.mapId} snapshot={studySnapshots.kb} title="Kit-Build（キットを使ったマップ）" allowZoom /></div>}
                </> : <div>{studyMaps.map((map) => <a key={map.id} className="session-secondary-button" href={`/maps/${map.id}`}>{map.type === "PRIOR" ? "Scratch-Build" : "Kit-Build"}</a>)}</div>}
              </div>}
              {current.stageType === "INTEGRATION_MAP" && <p>{integrationSubmitted ? "統合マップは提出済みです。" : remaining === 0 ? flow.currentIntegrationMapExists ? "統合マップの自動提出を確認しています。処理が続く場合は研究者に連絡してください。" : "時間が終了しました。" : "時間内は統合マップを編集できます。時間終了時に自動提出されます。"}</p>}
              {!isLearner && current.stageType === "INTEGRATION_MAP" && flow.currentMapAutoSubmittedAt && <p>自動提出日時: {new Date(flow.currentMapAutoSubmittedAt).toLocaleString()}</p>}
              {current.stageType === "INTEGRATION_MAP" && remaining === 0 && !integrationSubmitted && !flow.currentIntegrationMapExists && <p className="session-error" role="alert">提出する統合マップがありません。研究者に連絡してください。</p>}
              <button type="button" className={isLearner ? "session-primary-button" : "session-secondary-button"} disabled={busy || remaining !== 0 || (current.stageType === "INTEGRATION_MAP" && !integrationSubmitted)} onClick={() => void completeTimed()}>次へ</button>
            </div>}
            {current.stageType === "LESSON" && current.status === "IN_PROGRESS" && (
              <>
                <Stage1Video
                  url={flow.session.lessonVideoUrl}
                  stageId={current.id}
                  confirmed={confirmedVideoViewed}
                  onConfirm={setConfirmedVideoViewed}
                  showHeading={!isLearner}
                  onEvent={(event) => {
                    if (!isLearner) return;
                    void sendObservedLearningEvent(sessionId, event).then((saved) => {
                      if (!saved) noteActivityLogFailure();
                    });
                  }}
                />
                <button
                  className={isLearner ? "session-primary-button" : "session-secondary-button"}
                  type="button"
                  disabled={busy || !confirmedVideoViewed}
                  onClick={() => void completeLesson()}
                >
                  {busy ? "処理中…" : "視聴を終えて次へ"}
                </button>
              </>
            )}
          </div>
        )}

        {flow.session.status === "IN_PROGRESS" && !current && (
          <div className="session-current-panel"><h2>全活動が完了しています</h2></div>
        )}
        {!isLearner && ["STAGE1_4", "STAGE1_6"].includes(flow.session.protocolKey) && flow.session.status === "COMPLETED" && (
          <p>
            <a className="back-link" href={`/research/stage1/${flow.session.id}/analysis`}>
              研究者用分析画面を開く
            </a>
          </p>
        )}
        {flow.session.status === "COMPLETED" && (
          <div className="session-completed-panel" role="status">
            <h2>セッション完了</h2>
            {!isLearner && flow.session.completedAt && (
              <p>
                完了日時: {new Date(flow.session.completedAt).toLocaleString()}
              </p>
            )}
          </div>
        )}
        {requestedStageBlocked && (
          <div className="session-error" role="alert">
            <strong>この活動にはまだ進めません。</strong>
            <p>{current ? `現在は「${label(current)}」です。先に完了してください。` : "セッションを開始して、順番に進めてください。"}</p>
          </div>
        )}
        {isLearner?<LearnerDeliveryStatus sessionId={sessionId}/>:<ResearchDeliveryStatus sessionId={sessionId}/>}
        {error && <p className="session-error" role="alert">{error}</p>}
        {activityLogWarning && <p className="session-error" role="status">一部の操作記録の保存を確認できていません。送信状態を確認してください。</p>}

        {!isLearner && <section className="session-stage-list" aria-label="活動一覧">
          <h2>活動一覧</h2>
          <ol>
            {flow.stages.map((stage) => {
              const state =
                stage.status === "COMPLETED"
                  ? "completed"
                  : stage.id === current?.id
                    ? "current"
                    : "future";
              return (
                <li
                  className={[
                    "session-stage-row",
                    state === "completed" ? "is-completed" : "",
                    state === "current" ? "is-current" : "",
                    state === "future" ? "is-future" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={stage.id}
                  aria-current={
                    state === "current" ? "step" : undefined
                  }
                >
                  <span>{label(stage)}</span>
                  <span
                    className={`session-stage-status is-${state}`}
                  >
                    {state === "completed"
                      ? "完了済み"
                      : state === "current"
                        ? "現在"
                        : "未完了"}
                  </span>
                  {!isLearner && stage.status === "COMPLETED" && stage.mapId && (
                    <a href={`/maps/${stage.mapId}`}>閲覧</a>
                  )}
                </li>
              );
            })}
          </ol>
        </section>}
        {!isLearner && flow.session.protocolKey === "STAGE1_6" && <ResearchAssessment sessionId={sessionId} />}
        {!isLearner && (
          <a className="back-link" href="/">
            トップへ戻る
          </a>
        )}
      </section>
    </main>
  );
}

function Stage1Video({
  url,
  stageId,
  confirmed,
  onConfirm,
  showHeading,
  onEvent,
}: {
  url: string | null;
  stageId: string;
  confirmed: boolean;
  onConfirm: (value: boolean) => void;
  showHeading: boolean;
  onEvent: (event: Extract<ObservedLearningEvent, { targetType: "VIDEO" }>) => void;
}) {
  const lastPosition = useRef(0);
  const seekFrom = useRef<number | null>(null);
  if (!url) return <p role="alert">授業動画が設定されていません。</p>;
  const youtube = url.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})(?:[&#?].*)?$/,
  );
  const isMediaFile = /\.(?:mp4|webm|ogg)(?:\?.*)?$/i.test(url);
  return (
    <div className="stage1-video-section">
      {showHeading && <h3>STEP 1：授業動画</h3>}
      <p>指定された動画を視聴し、終了後に確認欄を選択してください。</p>
      {youtube ? (
        <iframe title="授業動画" className="stage1-video-player" src={`https://www.youtube-nocookie.com/embed/${youtube[1]}`} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
      ) : isMediaFile ? (
        <video
          className="stage1-video-player"
          controls
          preload="metadata"
          src={url}
          onPlay={() => onEvent({ eventType: "VIDEO_PLAY", targetType: "VIDEO", stageId })}
          onPause={(event) => {
            if (!event.currentTarget.ended) onEvent({ eventType: "VIDEO_PAUSE", targetType: "VIDEO", stageId });
          }}
          onTimeUpdate={(event) => {
            if (seekFrom.current === null) lastPosition.current = event.currentTarget.currentTime;
          }}
          onSeeking={() => {
            if (seekFrom.current === null) seekFrom.current = lastPosition.current;
          }}
          onSeeked={(event) => {
            const fromSeconds = seekFrom.current;
            const toSeconds = event.currentTarget.currentTime;
            seekFrom.current = null;
            lastPosition.current = toSeconds;
            if (fromSeconds !== null && Math.abs(toSeconds - fromSeconds) >= 0.25) {
              onEvent({ eventType: "VIDEO_SEEK", targetType: "VIDEO", stageId, details: { fromSeconds, toSeconds } });
            }
          }}
          onEnded={(event) => {
            lastPosition.current = event.currentTarget.currentTime;
            onEvent({ eventType: "VIDEO_COMPLETE", targetType: "VIDEO", stageId });
          }}
        />
      ) : (
        <a href={url} target="_blank" rel="noopener noreferrer">授業動画を開く（別タブ）</a>
      )}
      <label className="stage1-confirm-video">
        <input type="checkbox" checked={confirmed} onChange={(event) => onConfirm(event.target.checked)} />
        動画を視聴しました
      </label>
      <p className="stage1-verification-note">視聴確認は自己申告です。視聴時間の客観的な計測ではありません。</p>
    </div>
  );
}
