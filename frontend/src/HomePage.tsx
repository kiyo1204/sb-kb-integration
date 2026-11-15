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
  onAccessCodeSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
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
  const [isSubmittingAccessCode, setIsSubmittingAccessCode] = useState(false);

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

  async function submitAccessCode(event: FormEvent<HTMLFormElement>) {
    setIsSubmittingAccessCode(true);
    try {
      await onAccessCodeSubmit(event);
    } finally {
      setIsSubmittingAccessCode(false);
    }
  }

  return (
    <div
      className={`home-page${accessMode === "signed-out" ? " is-signed-out" : ""}${accessMode === "researcher" ? " is-researcher" : ""}`}
    >
      <header className="home-header">
        <div className="home-header-inner">
          <div className="home-brand-lockup">
            <p className="home-brand">研究用学習システム</p>
          </div>
        </div>
      </header>

      <main className="home-main">
        {accessMode === "researcher" ? (
          <section className="home-page-heading home-researcher-page-heading">
            <h1>研究者トップ</h1>
            <p>教材と実施セッションを管理します。</p>
          </section>
        ) : (
        <div className={`home-top-grid is-single${accessMode === "signed-out" ? " is-entry" : ""}`}>
          <section
            className="home-card home-entry-card"
            aria-labelledby="home-entry-heading"
          >
            {accessMode === "signed-out" ? (
              <>
                <p className="home-card-kicker">参加者・研究者</p>
                <h2 id="home-entry-heading">アクセスコードを入力</h2>
                <p className="home-card-description">
                  研究者コードまたは学習者コードを入力してください。学習者コードは割り当てられたSession専用です。
                </p>
                <form
                  className="home-access-form"
                  onSubmit={(event) => void submitAccessCode(event)}
                  aria-busy={isSubmittingAccessCode}
                >
                  <label htmlFor="home-access-code">アクセスコード</label>
                  <div className="home-access-control">
                    <input
                      id="home-access-code"
                      type="password"
                      autoComplete="off"
                      placeholder="アクセスコードを入力"
                      value={accessCode}
                      onChange={(event) =>
                        onAccessCodeChange(event.target.value)
                      }
                      minLength={32}
                      required
                    />
                    <button
                      className="home-primary-button"
                      type="submit"
                      disabled={isSubmittingAccessCode}
                    >
                      {isSubmittingAccessCode ? "確認中…" : "続行"}
                    </button>
                  </div>
                  {isSubmittingAccessCode && (
                    <p className="home-access-submit-status" role="status">
                      コードを確認しています…
                    </p>
                  )}
                  {accessError && (
                    <p className="home-action-error" role="alert">
                      {accessError}
                    </p>
                  )}
                </form>
                <p className="home-access-note">
                  研究者コードは学習者に共有しないでください。
                </p>
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
        </div>
        )}

        {accessMode === "signed-out" && (
          <section className="home-card home-practice-card" aria-labelledby="home-practice-heading">
            <div>
              <h2 id="home-practice-heading">コードなしで練習する</h2>
              <p>アクセスコードなしで、SB・KBの操作を練習できます。</p>
            </div>
            <a className="home-secondary-button" href="/tutorial">
              操作の練習へ <span aria-hidden="true">→</span>
            </a>
          </section>
        )}

        {accessMode === "researcher" && (
          <>
            <section
              className="home-research-workflow"
              aria-label="教材準備と実施管理"
            >
              <div className="home-research-primary-grid">
                <article className="home-card home-workflow-card">
                  <p className="home-card-kicker">教材準備</p>
                  <h2>教材を管理</h2>
                  <p className="home-card-description">
                    教材系列・版の編集と完成登録を行います。
                  </p>
                  <ul className="home-workflow-features">
                    <li>教材の設定・編集</li>
                    <li>完成チェックと教材テスト</li>
                  </ul>
                  <a className="home-primary-button" href="/research/materials">
                    教材管理を開く <span aria-hidden="true">→</span>
                  </a>
                </article>
                <article className="home-card home-workflow-card">
                  <p className="home-card-kicker">実施・参加者管理</p>
                  <h2>実施を管理</h2>
                  <p className="home-card-description">
                    実施の作成・一覧と、参加者登録・状態確認へ進みます。
                  </p>
                  <ul className="home-workflow-features">
                    <li>実施の作成・一覧</li>
                    <li>参加者の登録と進行状況の確認</li>
                  </ul>
                  <a className="home-primary-button" href="/research/experiment-runs">
                    実施一覧を開く <span aria-hidden="true">→</span>
                  </a>
                </article>
              </div>
              <div className="home-section-heading home-research-secondary-heading">
                <h2>結果確認とシステム状態</h2>
                <p>既存Session一覧、接続状況、その他の研究者機能を確認します。</p>
              </div>
              <div className="home-research-secondary-grid">
                <article className="home-card home-workflow-card">
                  <p className="home-card-kicker">結果確認</p>
                  <h2>参加Sessionを確認</h2>
                  <p className="home-card-description">
                    下の一覧からSessionを選び、利用可能な活動状態・分析・出力を確認します。
                  </p>
                  <a className="home-secondary-button" href="#research-sessions-heading">
                    参加Session一覧へ <span aria-hidden="true">↓</span>
                  </a>
                </article>
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
              </div>
              <nav
                className="home-researcher-utilities"
                aria-label="その他の研究者機能"
              >
                <span>その他の研究者機能</span>
                <div className="home-researcher-utility-links">
                  <a className="home-secondary-link" href="/research/stage1/new">
                    従来形式のSessionを作成
                  </a>
                  <a className="home-secondary-link" href="/research/data-management">
                    研究データ・保存期限・明示削除
                  </a>
                  <a className="home-secondary-link" href="/research/events">
                    研究イベントの時系列ログ
                  </a>
                  <a className="home-secondary-link" href="/research/event-exports">
                    研究イベントを絞り込み出力
                  </a>
                  <a className="home-secondary-link" href="/research/goal-maps">
                    ゴールマップを作成・管理
                  </a>
                </div>
              </nav>
            </section>
            <ResearchSessions />
          </>
        )}

        {accessMode === "researcher" && (
          <footer className="home-development-note">
            学習者には参加Session専用コードを渡してください。研究者コードは共有しないでください。
          </footer>
        )}
        {accessMode === "signed-out" && (
          <footer className="home-development-note">
            学習者にはセッション専用コードを渡してください。研究者コードは共有しないでください。
          </footer>
        )}

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

const stageNames: Record<string, string> = { SURVEY:"アンケート", LESSON: "授業動画", PRIOR_MAP: "Scratch-Build", KB_MAP: "Kit-Build", INTEGRATION_MAP: "統合マップ", PRE_ASSESSMENT: "事前評価", SELF_STUDY: "自主学習", POST_ASSESSMENT: "事後評価" };

function ResearchSessions() {
  const [sessions, setSessions] = useState<ResearchSession[] | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [deleting,setDeleting]=useState<string|null>(null);
  const [cleanupMessage,setCleanupMessage]=useState("");
  async function cleanup(session:ResearchSession) {
    if(!window.confirm(`未開始セッション ${session.participantCode || "参加者コードなし"}\nID: ${session.id}\nこのセッションの設定・設問・未使用の初期マップを削除します。共有Goal Map・教師用Kitは残ります。開始や学習者データがある場合は削除しません。続行しますか？`)) return;
    setDeleting(session.id);setCleanupMessage("");
    try {
      const response=await apiFetch("/api/research/data-management/cleanup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:session.id,confirm:"DELETE_UNSTARTED"})});
      const result=await response.json();
      if(!response.ok) {setCleanupMessage(result.error==="confirmed_deletion_required"?"開始済み、または記録があるため簡易削除できません。確認付きデータ削除を使用してください。":"削除は確定していません。一覧を更新して再確認してください。");return;}
      setSessions(current=>current?.filter(item=>item.id!==session.id)??null);
      setCleanupMessage("未開始セッションを削除しました。");
    } catch {setCleanupMessage("削除結果を確認できません。一覧を更新して再確認してください。");}
    finally {setDeleting(null);}
  }
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
    <div className="home-card-heading-row"><div><h2 id="research-sessions-heading">参加Sessionと結果</h2><p>新しいSessionから表示します。新protocolの「開く」は分析・出力へ、旧形式はSession画面へ進みます。</p></div>
      <button type="button" className="home-refresh-button" onClick={() => setReload(value => value + 1)}>更新</button></div>
    {cleanupMessage && <p role="status">{cleanupMessage} <a href="/research/data-management">確認付きデータ削除</a></p>}
    {error && <p className="home-action-error" role="alert">一覧を取得できませんでした。接続を確認して更新してください。</p>}
    {!sessions && !error && <p className="home-list-state" role="status">参加Sessionを読み込んでいます…</p>}
    {sessions?.length === 0 && <p className="home-list-state" role="status">参加Sessionはまだありません。</p>}
    {sessions && sessions.length > 0 && <div className="research-session-table-wrap"><table className="research-session-table">
      <thead><tr><th scope="col">参加者コード</th><th scope="col">フロー</th><th scope="col">群</th><th scope="col">状態</th><th scope="col">現在の活動</th><th scope="col">開始日時</th><th scope="col">完了日時</th><th scope="col">操作</th></tr></thead>
      <tbody>{sessions.map(session => <tr key={session.id}>
        <td>{session.participantCode || "—"}</td><td>{session.protocolKey==="SBKB_INTEGRATION_V1"?"SB/KB統合（アンケートなし）":session.protocolKey==="STAGE1_5"?"5活動（群なし）":session.protocolKey==="STAGE1_6"?"6活動（群別）":"4活動（旧形式）"}</td><td>{session.studyGroup === "EXPERIMENTAL" ? "実験群" : session.studyGroup === "CONTROL" ? "統制群" : "—"}</td>
        <td>{session.status === "NOT_STARTED" ? "未開始" : session.status === "IN_PROGRESS" ? "進行中" : "完了"}</td>
        <td>{session.status === "IN_PROGRESS" && session.currentStageType ? `STEP ${(session.currentStageOrder ?? 0) + 1}：${stageNames[session.currentStageType] ?? session.currentStageType}` : "—"}</td>
        <td>{session.startedAt ? formatDate(session.startedAt) : "—"}</td><td>{session.completedAt ? formatDate(session.completedAt) : "—"}</td>
        <td><div className="research-session-actions"><a className="home-secondary-button" href={session.protocolKey==="SBKB_INTEGRATION_V1"?`/research/stage1/${session.id}/analysis`:`/sessions/${session.id}`} aria-label={`${session.participantCode || "参加者コードなし"}のセッションを開く`}>開く</a>{session.protocolKey==="SBKB_INTEGRATION_V1"?<span>実施・参加者管理の対象</span>:session.status==="NOT_STARTED"?<button className="home-secondary-button" type="button" disabled={deleting!==null} onClick={()=>void cleanup(session)} aria-label={`${session.participantCode || "参加者コードなし"}の未開始セッションを削除`}>未開始セッションを削除</button>:<a href="/research/data-management">確認付きデータ削除</a>}</div></td>
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
