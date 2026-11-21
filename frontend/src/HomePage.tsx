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
                <p>実施ごとの結果と接続状況を確認します。</p>
              </div>
              <div className="home-research-secondary-grid">
                <article className="home-card home-workflow-card">
                  <p className="home-card-kicker">結果確認</p>
                  <h2>実施の結果を確認</h2>
                  <p className="home-card-description">
                    実施詳細から参加者の進行状況、保存Map・履歴と研究用出力を確認します。
                  </p>
                  <a className="home-secondary-button" href="/research/experiment-runs">
                    実施一覧へ <span aria-hidden="true">→</span>
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
                <section className="home-researcher-utility-group">
                  <h3>教材準備の補助</h3>
                  <p>教材準備に使うゴールマップとKitを管理します。</p>
                  <a className="home-secondary-link" href="/research/goal-maps">
                    ゴールマップ・Kitを管理
                  </a>
                </section>

              </nav>
            </section>
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
