import { useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "./auth-client";

type ApiConnectivity = "checking" | "connected" | "unreachable" | "error";
type DatabaseConnectivity = "checking" | "connected" | "error" | "unknown";

type HealthState = {
  api: ApiConnectivity;
  database: DatabaseConnectivity;
  checkedAt: string | null;
};

type HomePageProps = {
  accessCode: string;
  accessError: string | null;
  accessMode: "signed-out" | "checking" | "researcher" | "learner";
  learnerSessionHref?: string;
  onAccessCodeChange: (value: string) => void;
  onAccessCodeSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function HomePage({
  accessCode,
  accessError,
  accessMode,
  learnerSessionHref,
  onAccessCodeChange,
  onAccessCodeSubmit,
}: HomePageProps) {
  const [health, setHealth] = useState<HealthState>({
    api: "checking",
    database: "checking",
    checkedAt: null,
  });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/api/health", { signal: controller.signal })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        const hasDatabaseStatus =
          typeof payload === "object" &&
          payload !== null &&
          "database" in payload &&
          typeof payload.database === "boolean";
        const database: DatabaseConnectivity = hasDatabaseStatus
          ? payload.database
            ? "connected"
            : "error"
          : "unknown";
        if (!controller.signal.aborted) {
          setHealth({
            api: hasDatabaseStatus
              ? "connected"
              : response.ok
                ? "error"
                : "unreachable",
            database,
            checkedAt: new Date().toISOString(),
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHealth({
            api: "unreachable",
            database: "unknown",
            checkedAt: new Date().toISOString(),
          });
        }
      });
    return () => controller.abort();
  }, [refreshKey]);

  return (
    <div className="home-page">
      <header className="home-header">
        <div className="home-header-inner">
          <div className="home-brand-lockup">
            <p className="home-brand">研究用学習システム</p>
          </div>
        </div>
      </header>

      <main className="home-main">
        <div className={`home-top-grid${accessMode !== "researcher" ? " is-single" : ""}`}>
          <section
            className="home-card home-entry-card"
            aria-labelledby="home-entry-heading"
          >
            {accessMode === "signed-out" ? (
              <>
                <p className="home-card-kicker">参加者・研究者</p>
                <h2 id="home-entry-heading">アクセスコードで開始</h2>
                <p className="home-card-description">
                  研究者から受け取ったコードを入力してください。学習者コードは割り当てられたセッション専用です。
                </p>
                <form
                  className="home-access-form"
                  onSubmit={onAccessCodeSubmit}
                >
                  <label htmlFor="home-access-code">アクセスコード</label>
                  <div className="home-access-control">
                    <input
                      id="home-access-code"
                      type="password"
                      autoComplete="off"
                      value={accessCode}
                      onChange={(event) =>
                        onAccessCodeChange(event.target.value)
                      }
                      minLength={32}
                      required
                    />
                    <button className="home-primary-button" type="submit">
                      続行
                    </button>
                  </div>
                  {accessError && (
                    <p className="home-action-error" role="alert">
                      {accessError}
                    </p>
                  )}
                </form>
                <p><a className="home-secondary-link" href="/tutorial">操作の練習</a></p>
                <p className="home-access-note">
                  研究者コードは学習者に共有しないでください。
                </p>
              </>
            ) : accessMode === "researcher" ? (
              <>
                <h2 id="home-entry-heading">研究セッション</h2>
                <p className="home-card-description">
                  セッションを作成して学習者コードを発行します。分析とデータ出力は学習者の作業完了後に行います。
                </p>
                <a className="home-primary-button" href="/research/stage1/new">
                  セッションを作成
                  <span aria-hidden="true">→</span>
                </a>
                <a className="home-secondary-link" href="/research/goal-maps">
                  ゴールマップを作成・管理
                  <span aria-hidden="true">→</span>
                </a>
              </>
            ) : accessMode === "learner" ? (
              <>
                <p className="home-card-kicker">学習者</p>
                <h2 id="home-entry-heading">学習を再開</h2>
                <p className="home-card-description">
                  割り当てられたセッションを続けます。
                </p>
                {learnerSessionHref && (
                  <a className="home-primary-button" href={learnerSessionHref}>
                    セッションを開く <span aria-hidden="true">→</span>
                  </a>
                )}
                <p><a className="home-secondary-link" href="/tutorial">操作の練習</a></p>
              </>
            ) : (
              <>
                <p className="home-card-kicker">アクセス確認</p>
                <h2 id="home-entry-heading">ログイン状態を確認しています</h2>
                <p className="home-card-description" role="status">
                  しばらくお待ちください。
                </p>
              </>
            )}
          </section>

          {accessMode === "researcher" && (
            <section
              className="home-card home-system-card"
              aria-labelledby="system-status-heading"
            >
              <div className="home-card-heading-row">
                <div>
                  <h2 id="system-status-heading">システム状態</h2>
                  <p>MVPの接続状況</p>
                </div>
                <button
                  className="home-refresh-button"
                  type="button"
                  disabled={health.api === "checking"}
                  onClick={() => {
                    setHealth({
                      api: "checking",
                      database: "checking",
                      checkedAt: null,
                    });
                    setRefreshKey((current) => current + 1);
                  }}
                >
                  再確認
                </button>
              </div>
              <div className="home-system-rows" aria-live="polite">
                <StatusRow
                  label="API"
                  detail="Backend API / health check"
                  state={health.api}
                />
                <StatusRow
                  label="SQL"
                  detail="PostgreSQL database"
                  state={health.database}
                />
              </div>
              <div className="home-last-check">
                <span>最終確認</span>
                <time dateTime={health.checkedAt ?? undefined}>
                  {health.checkedAt ? formatDate(health.checkedAt) : "確認中"}
                </time>
              </div>
            </section>
          )}
        </div>

        {accessMode === "researcher" && <ResearchSessions />}

        {accessMode !== "learner" && <footer className="home-development-note">学習者にはセッション専用コードを渡してください。研究者コードは共有しないでください。</footer>}

      </main>
    </div>
  );
}

type ResearchSession = {
  id: string; participantCode: string | null; studyGroup: "EXPERIMENTAL" | "CONTROL" | null;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED"; protocolKey: string;
  currentStageType: string | null; currentStageOrder: number | null;
  startedAt: string | null; completedAt: string | null;
};

const stageNames: Record<string, string> = { LESSON: "授業動画", PRIOR_MAP: "Scratch-Build", KB_MAP: "Kit-Build", INTEGRATION_MAP: "統合マップ", PRE_ASSESSMENT: "事前評価", SELF_STUDY: "自主学習", POST_ASSESSMENT: "事後評価" };

function ResearchSessions() {
  const [sessions, setSessions] = useState<ResearchSession[] | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/api/research/stage1/sessions", { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("session list failed");
      return await response.json() as { sessions: ResearchSession[] };
    }).then(result => { if (!controller.signal.aborted) { setSessions(result.sessions); setError(false); } })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [reload]);
  return <section className="home-card research-session-list" aria-labelledby="research-sessions-heading">
    <div className="home-card-heading-row"><div><h2 id="research-sessions-heading">セッション一覧</h2><p>新しいセッションから表示します。</p></div>
      <button type="button" className="home-refresh-button" onClick={() => setReload(value => value + 1)}>更新</button></div>
    {error && <p className="home-action-error" role="alert">一覧を取得できませんでした。接続を確認して更新してください。</p>}
    {!sessions && !error && <p role="status">セッションを読み込んでいます…</p>}
    {sessions?.length === 0 && <p>セッションはまだありません。</p>}
    {sessions && sessions.length > 0 && <div className="research-session-table-wrap"><table className="research-session-table">
      <thead><tr><th scope="col">参加者コード</th><th scope="col">群</th><th scope="col">状態</th><th scope="col">現在の活動</th><th scope="col">開始日時</th><th scope="col">完了日時</th><th scope="col">操作</th></tr></thead>
      <tbody>{sessions.map(session => <tr key={session.id}>
        <td>{session.participantCode || "—"}</td><td>{session.studyGroup === "EXPERIMENTAL" ? "実験群" : session.studyGroup === "CONTROL" ? "統制群" : "—"}</td>
        <td>{session.status === "NOT_STARTED" ? "未開始" : session.status === "IN_PROGRESS" ? "進行中" : "完了"}</td>
        <td>{session.status === "IN_PROGRESS" && session.currentStageType ? `STEP ${(session.currentStageOrder ?? 0) + 1}：${stageNames[session.currentStageType] ?? session.currentStageType}` : "—"}</td>
        <td>{session.startedAt ? formatDate(session.startedAt) : "—"}</td><td>{session.completedAt ? formatDate(session.completedAt) : "—"}</td>
        <td><a className="home-secondary-button" href={`/sessions/${session.id}`} aria-label={`${session.participantCode || "参加者コードなし"}のセッションを開く`}>開く</a></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}

function StatusRow({
  label,
  detail,
  state,
}: {
  label: string;
  detail: string;
  state: ApiConnectivity | DatabaseConnectivity;
}) {
  return (
    <div className="home-status-row">
      <div>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <span
        className={`home-status-value${state === "connected" ? " is-connected" : ""}`}
      >
        <span className="home-status-dot" aria-hidden="true" />
        {healthStatusText(state)}
      </span>
    </div>
  );
}

function healthStatusText(state: ApiConnectivity | DatabaseConnectivity) {
  switch (state) {
    case "checking":
      return "確認中";
    case "connected":
      return "接続済み";
    case "unreachable":
      return "未接続";
    case "error":
      return "エラー";
    case "unknown":
      return "確認できません";
  }
}
