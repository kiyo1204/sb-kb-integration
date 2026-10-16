import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./auth-client";

type StageType = "LESSON" | "PRIOR_MAP" | "KB_MAP" | "INTEGRATION_MAP";
type StageStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED";
type SessionStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";

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
  };
  stages: SessionStage[];
  currentStage: SessionStage | null;
  nextStage: SessionStage | null;
};

const stageLabels: Record<StageType, string> = {
  LESSON: "STEP 1：授業動画",
  PRIOR_MAP: "STEP 2：Scratch-Build",
  KB_MAP: "STEP 3：Kit-Build",
  INTEGRATION_MAP: "STEP 4：統合",
};

const stageSlugs: Record<StageType, string> = {
  LESSON: "lesson",
  PRIOR_MAP: "prior",
  KB_MAP: "kb",
  INTEGRATION_MAP: "integration",
};

function messageFrom(payload: unknown) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }
  return "リクエストを完了できませんでした。Sessionの状態を再読み込みしてください。";
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
}: {
  sessionId: string;
  requestedStageSlug?: string;
}) {
  return (
    <SessionDashboard
      key={sessionId}
      sessionId={sessionId}
      requestedStageSlug={requestedStageSlug}
    />
  );
}

function SessionDashboard({
  sessionId,
  requestedStageSlug,
}: {
  sessionId: string;
  requestedStageSlug?: string;
}) {
  const [flow, setFlow] = useState<SessionFlow | null>(null);
  const [confirmedVideoViewed, setConfirmedVideoViewed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const nextFlow = await requestJson<SessionFlow>(
      `/api/sessions/${sessionId}/flow`,
    );
    if (nextFlow.session.protocolKey !== "STAGE1_4") {
      throw new Error("このSessionはStage 1の学習フローではありません。");
    }
    setFlow(nextFlow);
  }, [sessionId]);

  useEffect(() => {
    let active = true;
    requestJson<SessionFlow>(`/api/sessions/${sessionId}/flow`)
      .then((nextFlow) => {
        if (!active) return;
        if (nextFlow.session.protocolKey !== "STAGE1_4") {
          throw new Error("このSessionはStage 1の学習フローではありません。");
        }
        setFlow(nextFlow);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Sessionの状態を読み込めませんでした。",
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

  async function startSession() {
    setBusy(true);
    setError(null);
    try {
      await requestJson(`/api/sessions/${sessionId}/start`, "POST", {});
      await reload();
    } catch (startError) {
      setError(
        startError instanceof Error
          ? startError.message
          : "Sessionを開始できませんでした。",
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
      await requestJson(`/api/session-stages/${stage.id}/start`, "POST", {});
      if (stage.stageType === "LESSON") {
        await reload();
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
        if (!kitId) throw new Error("このSessionにKitが割り当てられていません。");
        map = await requestJson(`/api/kits/${kitId}/kb-map`, "POST", {
          sessionStageId: stage.id,
        });
      } else {
        const priorStage = flow.stages.find((item) => item.stageType === "PRIOR_MAP");
        const kbStage = flow.stages.find((item) => item.stageType === "KB_MAP");
        if (!priorStage?.mapId || !kbStage?.mapId) {
          throw new Error("Scratch-BuildまたはKit-Build Mapが見つかりません。");
        }
        const kbMap = await requestJson<{ kitDefinitionId: string | null }>(
          `/api/maps/${kbStage.mapId}`,
        );
        if (!kbMap.kitDefinitionId) {
          throw new Error("Kit-Build MapにKitDefinitionが設定されていません。");
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
          : "Stageを開始できませんでした。",
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
      await requestJson(`/api/session-stages/${stage.id}/complete`, "POST", {});
      await reload();
    } catch (completeError) {
      setError(
        completeError instanceof Error
          ? completeError.message
          : "授業動画Stageを完了できませんでした。",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="page session-page">
        <p role="status">Sessionを読み込んでいます…</p>
      </main>
    );
  }
  if (!flow) {
    return (
      <main className="page session-page">
        <section className="session-card" role="alert">
          <h1>Sessionを開けません</h1>
          <p>{error ?? "Sessionが見つかりません。"}</p>
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

  return (
    <main className="page session-page">
      <section className="session-card" aria-labelledby="session-title">
        <h1 id="session-title">学習・再構成フロー</h1>
        <p className="session-id">Session ID: {flow.session.id}</p>

        {flow.session.status === "NOT_STARTED" && (
          <div className="session-current-panel">
            <h2>Sessionを開始してください</h2>
            <p>開始後、最初の活動から順番に進みます。</p>
            <button className="session-primary-button" type="button" disabled={busy} onClick={() => void startSession()}>
              {busy ? "開始中…" : "Sessionを開始"}
            </button>
          </div>
        )}

        {flow.session.status === "IN_PROGRESS" && current && (
          <div className="session-current-panel">
            <p className="session-current-label">現在の活動</p>
            <h2>{stageLabels[current.stageType]}</h2>
            {flow.nextStage && <p className="session-next-label">次の活動: {stageLabels[flow.nextStage.stageType]}</p>}
            <button className="session-primary-button" type="button" disabled={busy} onClick={() => void openCurrentStage()}>
              {busy ? "準備中…" : current.status === "IN_PROGRESS" ? "続ける" : "開始する"}
            </button>
            {current.stageType === "LESSON" && current.status === "IN_PROGRESS" && (
              <>
                <Stage1Video
                  url={flow.session.lessonVideoUrl}
                  confirmed={confirmedVideoViewed}
                  onConfirm={setConfirmedVideoViewed}
                />
                <button className="session-secondary-button" type="button" disabled={busy || !confirmedVideoViewed} onClick={() => void completeLesson()}>
                  {busy ? "処理中…" : "視聴を終えて次へ"}
                </button>
              </>
            )}
          </div>
        )}

        {flow.session.status === "IN_PROGRESS" && !current && (
          <div className="session-current-panel"><h2>全活動が完了しています</h2></div>
        )}
        {flow.session.status === "COMPLETED" && (
          <p><a className="back-link" href={`/research/stage1/${flow.session.id}/analysis`}>STEP 5：研究者用分析画面を開く</a></p>
        )}
        {flow.session.status === "COMPLETED" && (
          <div className="session-completed-panel" role="status">
            <h2>Session完了</h2>
            {flow.session.completedAt && <p>完了日時: {new Date(flow.session.completedAt).toLocaleString()}</p>}
          </div>
        )}
        {requestedStageBlocked && (
          <div className="session-error" role="alert">
            <strong>この活動にはまだ進めません。</strong>
            <p>{current ? `現在は「${stageLabels[current.stageType]}」です。先に完了してください。` : "Sessionを開始して、順番に進めてください。"}</p>
          </div>
        )}
        {error && <p className="session-error" role="alert">{error}</p>}

        <section className="session-stage-list" aria-label="活動一覧">
          <h2>活動一覧</h2>
          <ol>
            {flow.stages.map((stage) => (
              <li
                className={[
                  "home-session-row",
                  stage.id === current?.id ? "is-current" : "",
                  stage.status === "COMPLETED" ? "is-completed" : "",
                ].filter(Boolean).join(" ")}
                key={stage.id}
              >
                <span>{stageLabels[stage.stageType]}</span>
                <span>{stage.status === "COMPLETED" ? "完了" : stage.id === current?.id ? "現在" : "未完了"}</span>
                {stage.status === "COMPLETED" && stage.mapId && <a href={`/maps/${stage.mapId}`}>閲覧</a>}
              </li>
            ))}
          </ol>
        </section>
        <a className="back-link" href="/">トップへ戻る</a>
      </section>
    </main>
  );
}

function Stage1Video({
  url,
  confirmed,
  onConfirm,
}: {
  url: string | null;
  confirmed: boolean;
  onConfirm: (value: boolean) => void;
}) {
  if (!url) return <p role="alert">授業動画が設定されていません。</p>;
  const youtube = url.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})(?:[&#?].*)?$/,
  );
  const isMediaFile = /\.(?:mp4|webm|ogg)(?:\?.*)?$/i.test(url);
  return (
    <div className="stage1-video-section">
      <h3>STEP 1：授業動画</h3>
      <p>指定された動画を視聴し、終了後に確認欄を選択してください。</p>
      {youtube ? (
        <iframe title="授業動画" className="stage1-video-player" src={`https://www.youtube-nocookie.com/embed/${youtube[1]}`} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
      ) : isMediaFile ? (
        <video className="stage1-video-player" controls preload="metadata" src={url} />
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
