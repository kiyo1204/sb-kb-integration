import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiFetch, uiText } from "./auth-client";
import "./materials.css";
import "./experiment-runs.css";
type Completed = {
  id: string;
  version: number;
  title: string;
  materialVersionId: string;
  integrationSeconds: number;
};
type Run = {
  id: string;
  name: string;
  catalogVersionId: string;
  materialVersionId: string;
  materialTitle: string;
  materialVersion: number;
  integrationSeconds: number;
  plannedParticipants: number;
  registeredSessions: number;
  state: string;
  createdAt: string;
};
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch("/api/research/experiment-runs" + path, init).catch(
    () => {
      throw new Error(
        "通信のため保存状態を確認できません。同じ内容で再試行するか、実施一覧を確認してください。",
      );
    },
  );
  const data = await r.json().catch(() => null);
  if (!r.ok)
    throw new Error(
      uiText(
        data?.message ??
          "実施の処理を完了できませんでした。接続を確認してください。",
      ),
    );
  return data as T;
}
function Header({ create }: { create: boolean }) {
  return (
    <header className="materials-header">
      <h1>実施管理 / {create ? "実施を作成" : "実施一覧"}</h1>
      <span>研究者画面 / {create ? "R06" : "R07"}</span>
    </header>
  );
}
const date = (value: string) =>
  new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
export default function ExperimentRunsPage({
  create = false,
}: {
  create?: boolean;
}) {
  return create ? <CreateRun /> : <RunList />;
}
function CreateRun() {
  const [materials, setMaterials] = useState<Completed[] | null>(null),
    [name, setName] = useState(""),
    [versionId, setVersionId] = useState(""),
    [planned, setPlanned] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>()),
    submitted = useRef(false);
  useEffect(() => {
    let mounted = true;
    request<{ versions: Completed[] }>("/material-versions")
      .then((d) => {
        if (mounted) setMaterials(d.versions);
      })
      .catch(() => {
        if (mounted)
          setError(
            "完成教材版を取得できませんでした。再読み込みしてください。",
          );
      });
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    if (!name && !versionId && !planned) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (!submitted.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [name, versionId, planned]);
  const count = Number(planned),
    validCount =
      planned !== "" &&
      Number.isInteger(count) &&
      count >= 0 &&
      count <= 2147483647;
  const selected = materials?.find((m) => m.id === versionId);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !selected || !name.trim() || !validCount) return;
    setBusy(true);
    setError(null);
    const body = {
        name: name.trim(),
        catalogVersionId: versionId,
        plannedParticipants: count,
      },
      signature = JSON.stringify(body);
    let key = keys.current.get(signature);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(signature, key);
    }
    try {
      const run = await request<Run>("", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: signature,
      });
      submitted.current = true;
      window.location.assign(
        `/research/experiment-runs?created=${encodeURIComponent(run.id)}`,
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "実施を作成できませんでした。",
      );
      setBusy(false);
    }
  }
  return (
    <main className="materials-page">
      <Header create />
      <div className="materials-content">
        <div className="material-summary">
          <div>
            <h2>実施を作成</h2>
            <p>完成教材版を固定し、準備中の実施を保存します。</p>
          </div>
          <a href="/research/experiment-runs">実施一覧へ</a>
        </div>
        {error && (
          <p role="alert" className="session-error">
            {error}
          </p>
        )}
        <div className="run-create-grid">
          <section className="material-panel material-main">
            <h2>実施の設定</h2>
            {materials === null && !error && (
              <p role="status">完成教材版を読み込んでいます…</p>
            )}
            {materials?.length === 0 && (
              <p role="status">
                完成教材版がありません。
                <a href="/research/materials">教材管理で完成登録</a>
                してから実施を作成してください。
              </p>
            )}
            <form onSubmit={(e) => void submit(e)}>
              <label htmlFor="run-name">
                実施名 *
                <input
                  id="run-name"
                  maxLength={120}
                  required
                  value={name}
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label htmlFor="run-material">
                完成教材版 *
                <select
                  id="run-material"
                  required
                  value={versionId}
                  disabled={busy || !materials?.length}
                  onChange={(e) => setVersionId(e.target.value)}
                >
                  <option value="">選択してください</option>
                  {materials?.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title} / バージョン {m.version}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="run-planned">
                予定人数 *
                <input
                  id="run-planned"
                  type="number"
                  min="0"
                  step="1"
                  required
                  value={planned}
                  disabled={busy}
                  onChange={(e) => setPlanned(e.target.value)}
                  aria-describedby="run-planned-help"
                />
              </label>
              <p id="run-planned-help" className="material-muted">
                計画値として記録します。0も保存でき、登録人数の上限には使いません。登録済み参加者Session数とは別に扱います。
              </p>
              {planned !== "" && !validCount && (
                <p role="alert" className="session-error">
                  非負の整数を入力してください。保存形式は32bit整数（0〜2,147,483,647）です。参加者登録の上限ではありません。
                </p>
              )}
              <button
                className="session-primary-button run-submit"
                disabled={busy || !selected || !name.trim() || !validCount}
                type="submit"
              >
                {busy ? "保存中…" : "準備中の実施を作成"}
              </button>
            </form>
          </section>
          <aside
            className="material-panel material-main run-fixed-summary"
            aria-label="固定する教材版"
          >
            <h2>固定する教材版</h2>
            {selected ? (
              <>
                <dl>
                  <dt>教材</dt>
                  <dd>{selected.title}</dd>
                  <dt>版</dt>
                  <dd>バージョン {selected.version}</dd>
                  <dt>統合マップ制限時間</dt>
                  <dd>{selected.integrationSeconds}秒</dd>
                </dl>
                <a
                  href={`/research/materials/${selected.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  完成教材版を確認（別タブ）
                </a>
              </>
            ) : (
              <p>完成教材版を選択してください。</p>
            )}
            <div className="material-note">
              <strong>作成時点で固定します</strong>
              <p>
                後から教材に新しい版を作っても、この実施の教材版と制限時間は変わりません。
              </p>
            </div>
            <p className="material-muted">
              この作成画面では参加者Sessionを作りません。作成後の実施詳細から参加者登録・コード管理ができます。学習者フローと開始・終了は未公開です。
            </p>
          </aside>
        </div>
        <p className="material-footer">
          <a href="/research/experiment-runs">実施一覧へ戻る</a> ·{" "}
          <a href="/research/materials">教材管理へ</a>
        </p>
      </div>
    </main>
  );
}
function RunList() {
  const [runs, setRuns] = useState<Run[] | null>(null),
    [error, setError] = useState<string | null>(null),
    [reload, setReload] = useState(0),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let mounted = true;
    request<{ runs: Run[] }>("")
      .then((d) => {
        if (mounted) {
          setRuns(d.runs);
          setLoading(false);
        }
      })
      .catch(() => {
        if (mounted) {
          setError(
            "実施一覧を更新できませんでした。表示がある場合は前回取得時の内容です。再度更新してください。",
          );
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [reload]);
  const created = new URLSearchParams(window.location.search).get("created"),
    saved = runs?.find((r) => r.id === created);
  return (
    <main className="materials-page">
      <Header create={false} />
      <div className="materials-content">
        <div className="material-summary">
          <div>
            <h2>実施一覧</h2>
            <p>教材版を固定した実施を確認できます。</p>
          </div>
          <div className="material-actions">
            <button
              disabled={loading}
              onClick={() => {
                setLoading(true);
                setError(null);
                setReload((n) => n + 1);
              }}
            >
              一覧を更新
            </button>
            <a
              className="session-primary-button"
              href="/research/experiment-runs/new"
            >
              実施を作成
            </a>
          </div>
        </div>
        {saved && (
          <p role="status" className="run-created-note">
            「{saved.name}」は準備中で保存されています。登録済み参加者Sessionは
            {saved.registeredSessions}件です。
          </p>
        )}
        {error && (
          <p className="session-error" role="alert">
            {error}
          </p>
        )}
        {loading && <p role="status">実施一覧を読み込んでいます…</p>}
        <section className="material-panel material-series">
          <h2>登録された実施</h2>
          <p className="material-muted">
            登録済み数は所属するSessionの数です。予定人数・人物数とは異なります。実施詳細から参加者登録・コード管理ができます。学習者フローと開始・終了は未公開です。
          </p>
          {runs?.length === 0 && !loading ? (
            <p>
              実施はまだありません。完成教材版を選んで実施を作成してください。
            </p>
          ) : (
            runs && (
              <div
                className="material-table-scroll"
                tabIndex={0}
                aria-label="実施一覧の表"
              >
                <table className="runs-table">
                  <thead>
                    <tr>
                      <th>実施名</th>
                      <th>使用教材版</th>
                      <th>予定人数</th>
                      <th>
                        登録済み参加者
                        <br />
                        Session数
                      </th>
                      <th>状態</th>
                      <th>作成日時（JST）</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr
                        key={r.id}
                        className={r.id === created ? "is-new-run" : ""}
                      >
                        <td>{r.name}</td>
                        <td>
                          <a href={`/research/materials/${r.catalogVersionId}`}>
                            {r.materialTitle} / バージョン {r.materialVersion}
                          </a>
                          <small className="run-duration">
                            統合制限時間：{r.integrationSeconds}秒
                          </small>
                        </td>
                        <td>{r.plannedParticipants}</td>
                        <td>{r.registeredSessions}</td>
                        <td>
                          <span className="material-badge">
                            {r.state === "PREPARING"
                              ? "準備中"
                              : r.state === "RUNNING" ? "実施中（模擬）" : r.state === "ENDED" ? "終了" : "未対応の状態"}
                          </span>
                        </td>
                        <td>{date(r.createdAt)}</td>
                        <td><a href={`/research/experiment-runs/${r.id}`}>実施詳細</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </section>
        <p className="material-footer">
          <a href="/">研究者トップへ</a> ·{" "}
          <a href="/research/materials">教材管理へ</a>
        </p>
        <p className="material-muted">
          開発・模擬データ用です。実研究データの運用には別途確認が必要です。
        </p>
      </div>
    </main>
  );
}
