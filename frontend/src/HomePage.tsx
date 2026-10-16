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
            <p className="home-brand-caption">
              Stage 1 · 再構成過程分析
            </p>
          </div>
          <span className="home-environment">Stage 1</span>
        </div>
      </header>

      <main className="home-main">
        <div className="home-page-heading">
          <p className="home-card-kicker">STAGE 1 </p>
          <h1>学習フロー</h1>
        </div>

        <section className="home-flow" aria-label="学習者の4つの活動">
          <ol className="home-flow-list">
            <FlowStep
              number="1" 
              title="授業動画" 
              detail="授業内容を視聴" 
            />
            <FlowStep
              number="2"
              title="スクラッチビルド"
              detail="既有知識の表出"
            />
            <FlowStep 
              number="3" 
              title="キットビルド" 
              detail="授業内容の理解" 
            />
            <FlowStep
              number="4"
              title="統合"
              detail="自分のマップと統合"
            />
          </ol>
        </section>

        <div className="home-top-grid">
          <section
            className="home-card home-entry-card"
            aria-labelledby="home-entry-heading"
          >
            {accessMode === "signed-out" ? (
              <>
                <p className="home-card-kicker">参加者・研究者</p>
                <h2 id="home-entry-heading">アクセスコードで開始</h2>
                <p className="home-card-description">
                  研究者から受け取ったコードを入力してください。学習者コードは割り当てられたSession専用です。
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
                <p className="home-access-note">
                  研究者コードは学習者に共有しないでください。
                </p>
              </>
            ) : accessMode === "researcher" ? (
              <>
                <p className="home-card-kicker">研究者</p>
                <h2 id="home-entry-heading">研究Session</h2>
                <p className="home-card-description">
                  Sessionを作成して学習者コードを発行します。分析とデータExportは学習者の作業完了後に行います。
                </p>
                <a className="home-primary-button" href="/research/stage1/new">
                  Stage 1 Sessionを作成
                  <span aria-hidden="true">→</span>
                </a>
                <a className="home-secondary-link" href="/research/goal-maps">
                  Goal Mapを作成・管理
                  <span aria-hidden="true">→</span>
                </a>
              </>
            ) : accessMode === "learner" ? (
              <>
                <p className="home-card-kicker">学習者</p>
                <h2 id="home-entry-heading">学習を再開</h2>
                <p className="home-card-description">
                  割り当てられたSessionを続けます。
                </p>
                {learnerSessionHref && (
                  <a className="home-primary-button" href={learnerSessionHref}>
                    Sessionを開く <span aria-hidden="true">→</span>
                  </a>
                )}
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

        <footer className="home-development-note">
          学習者にはSession専用コードを渡してください。研究者コードは共有しないでください。
        </footer>
      </main>
    </div>
  );
}

function FlowStep({
  number,
  title,
  detail,
}: {
  number: string;
  title: string;
  detail: string;
}) {
  return (
    <li className="home-flow-step">
      <span className="home-flow-number" aria-hidden="true">
        {number}
      </span>
      <div>
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
    </li>
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
