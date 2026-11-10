import { useEffect, useRef, useState } from "react";
import { apiFetch, uiText } from "./auth-client";
import "./materials.css";

type Body = {
  title: string;
  researcherDescription: string;
  videoRef: string;
  sbInstructions: string;
  kbInstructions: string;
  integrationInstructions: string;
  kitId: string | null;
  seedConceptItemIds: string[];
  integrationSeconds: number | null;
};
type Version = {
  testStatus?: "COMPLETED" | "IN_PROGRESS" | "NOT_TESTED";
  id: string;
  seriesId: string;
  version: number;
  editRevision: number;
  state: "DRAFT" | "PUBLISHED";
  foundationVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  body: Body;
};
type Summary = Pick<
  Version,
  | "id"
  | "seriesId"
  | "version"
  | "state"
  | "foundationVersionId"
  | "updatedAt"
  | "completedAt"
> & { title: string };
type Asset = {
  kitId: string;
  kitName: string;
  goalMapId: string;
  goalTitle: string;
  available: boolean;
  frozen: boolean;
  concepts: Array<{ id: string; label: string }>;
};
type Field = keyof Body;
type Issue = { field: Field; message: string };
type Check = { ready: boolean; editRevision: number; issues: Issue[] };
type Section =
  "basic" | "video" | "sb" | "kb" | "integration" | "kit" | "seeds" | "test";
const sections: Array<[Section, string]> = [
  ["basic", "基本情報"],
  ["video", "動画"],
  ["sb", "SB 課題説明"],
  ["kb", "KB 課題説明"],
  ["integration", "統合 課題説明"],
  ["kit", "ゴールマップ・Kit"],
  ["seeds", "初期概念"],
  ["test", "テスト実行"],
];
const fields: Array<[Field, string, Section, string]> = [
  ["title", "教材名", "basic", "material-title"],
  ["videoRef", "動画", "video", "material-video"],
  ["sbInstructions", "SB 課題説明", "sb", "material-sb"],
  ["kbInstructions", "KB 課題説明", "kb", "material-kb"],
  [
    "integrationInstructions",
    "統合 課題説明",
    "integration",
    "material-integration",
  ],
  ["kitId", "ゴールマップ・Kit", "kit", "material-kit"],
  ["seedConceptItemIds", "初期概念", "seeds", "material-seeds"],
  ["integrationSeconds", "統合制限時間", "integration", "material-time"],
];
function localIssues(b: Body, assets: Asset[], rawTime: string): Issue[] {
  const issues: Issue[] = [];
  for (const [field, label] of fields.slice(0, 5))
    if (!(b[field] as string).trim())
      issues.push({ field, message: `${label}を設定してください。` });
  if (b.videoRef && !/^(https?:\/\/|\/(?!\/))/.test(b.videoRef.trim()))
    issues.push({
      field: "videoRef",
      message: "HTTP(S) URLまたは公開ファイルの絶対パスを指定してください。",
    });
  const asset = assets.find((a) => a.kitId === b.kitId);
  if (!asset?.available)
    issues.push({
      field: "kitId",
      message: "利用可能なGoal Map／Kitを選んでください。",
    });
  if (
    !b.seedConceptItemIds.length ||
    b.seedConceptItemIds.some((id) => !asset?.concepts.some((c) => c.id === id))
  )
    issues.push({
      field: "seedConceptItemIds",
      message: "選択したKitからSB初期概念を1件以上選んでください。",
    });
  if (
    !rawTime ||
    !Number.isInteger(Number(rawTime)) ||
    Number(rawTime) <= 0 ||
    Number(rawTime) > 2147483647
  )
    issues.push({
      field: "integrationSeconds",
      message: "統合制限時間を整数秒で設定してください。",
    });
  return issues;
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch("/api/research/materials" + path, init);
  const body = await r.json().catch(() => null);
  if (!r.ok)
    throw new Error(
      uiText(
        body?.message ??
          "教材の処理を完了できませんでした。接続を確認して再試行してください。",
      ),
    );
  return body as T;
}
function useWrite() {
  // Same in-page retry after an uncertain response keeps its original key.
  const keys = useRef(new Map<string, string>());
  return <T,>(path: string, method: string, body: unknown) => {
    const signature = JSON.stringify([path, method, body]);
    let key = keys.current.get(signature);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(signature, key);
    }
    return api<T>(path, {
      method,
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
  };
}
function Header({ editing = false }: { editing?: boolean }) {
  return (
    <header className="materials-header">
      <h1>教材管理{editing ? " / 教材を編集" : " / 教材一覧"}</h1>
      <span>研究者画面 / {editing ? "R04" : "R03"}</span>
    </header>
  );
}
function VersionNote() {
  return (
    <aside className="material-note">
      <strong>完成登録後の変更について</strong>
      <p>
        完成済み教材を変更する場合は、新しいバージョンを作成します。
        <br />
        実施で固定された教材版には影響しません。
      </p>
    </aside>
  );
}
function date(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function MaterialsPage({ versionId }: { versionId?: string }) {
  return versionId ? (
    <MaterialEditor key={versionId} versionId={versionId} />
  ) : (
    <MaterialList />
  );
}
function MaterialList() {
  const [versions, setVersions] = useState<Summary[] | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const write = useWrite();
  useEffect(() => {
    let active = true;
    api<{ versions: Summary[] }>("")
      .then((d) => {
        if (active) setVersions(d.versions);
      })
      .catch(() => {
        if (active)
          setError("教材一覧を取得できませんでした。再読み込みしてください。");
      });
    return () => {
      active = false;
    };
  }, []);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      const v = await write<{ id: string }>("", "POST", {});
      window.location.assign(`/research/materials/${v.id}`);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "下書きを作成できませんでした。",
      );
      setBusy(false);
    }
  }
  const series = [...new Set(versions?.map((v) => v.seriesId))];
  return (
    <main className="materials-page">
      <Header />
      <div className="materials-content">
        <div className="material-summary">
          <div>
            <h2>教材一覧</h2>
            <p>教材系列ごとに、下書きと完成済み版を確認できます。</p>
          </div>
          <button
            className="session-primary-button"
            disabled={busy}
            onClick={() => void create()}
          >
            教材の下書きを作成
          </button>
        </div>
        {error && (
          <p className="session-error" role="alert">
            {error}
          </p>
        )}
        {!versions && !error && <p role="status">教材を読み込んでいます…</p>}
        {versions?.length === 0 && (
          <section className="material-panel">
            <h2>教材はまだありません</h2>
            <p>
              下書きを作成し、教材内容を設定してください。未設定の項目があっても保存できます。
            </p>
          </section>
        )}
        {series.map((id) => {
          const rows = versions!
            .filter((v) => v.seriesId === id)
            .sort((a, b) => b.version - a.version);
          return (
            <section className="material-panel material-series" key={id}>
              <h2>{rows[0].title || "名称未設定の教材"}</h2>
              <div className="material-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>版</th>
                      <th>教材名</th>
                      <th>状態</th>
                      <th>更新日時（JST）</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((v) => (
                      <tr key={v.id}>
                        <td>バージョン {v.version}</td>
                        <td>{v.title || "未設定"}</td>
                        <td>
                          <span
                            className={`material-badge ${v.state === "PUBLISHED" ? "is-complete" : ""}`}
                          >
                            {v.state === "PUBLISHED"
                              ? "完成済み・固定"
                              : "下書き"}
                          </span>
                        </td>
                        <td>{date(v.updatedAt)}</td>
                        <td>
                          <a
                            className="home-secondary-button"
                            href={`/research/materials/${v.id}`}
                          >
                            {v.state === "PUBLISHED"
                              ? "完成版を確認"
                              : "下書きを編集"}
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
        <p className="material-footer">
          <a href="/">研究者トップへ</a> ·{" "}
          <a href="/research/goal-maps">ゴールマップ管理</a>
        </p>
        <p className="material-muted">
          開発・模擬データ用です。実研究データの運用には別途確認が必要です。
        </p>
      </div>
    </main>
  );
}
function MaterialEditor({ versionId }: { versionId: string }) {
  const [version, setVersion] = useState<Version | null>(null),
    [assets, setAssets] = useState<Asset[]>([]),
    [assetsError, setAssetsError] = useState(false);
  const [active, setActive] = useState<Section>("basic"),
    [dirty, setDirty] = useState(false),
    [rawTime, setRawTime] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [check, setCheck] = useState<Check | null>(null);
  const focusTarget = useRef<string | null>(null),
    write = useWrite();
  useEffect(() => {
    let mounted = true;
    api<Version>(`/${versionId}`)
      .then((v) => {
        if (mounted) {
          setVersion(v);
          setRawTime(
            v.body.integrationSeconds === null
              ? ""
              : String(v.body.integrationSeconds),
          );
        }
      })
      .catch(() => {
        if (mounted)
          setError("教材を取得できませんでした。再読み込みしてください。");
      });
    api<{ assets: Asset[] }>("/assets")
      .then((d) => {
        if (mounted) setAssets(d.assets);
      })
      .catch(() => {
        if (mounted) setAssetsError(true);
      });
    return () => {
      mounted = false;
    };
  }, [versionId]);
  useEffect(() => {
    if (focusTarget.current) {
      document.getElementById(focusTarget.current)?.focus();
      focusTarget.current = null;
    }
  }, [active]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function change<K extends Field>(key: K, value: Body[K]) {
    setVersion((v) => (v ? { ...v, body: { ...v.body, [key]: value } } : v));
    setDirty(true);
    setCheck(null);
    setNotice(null);
  }
  function jump(field: Field) {
    const entry = fields.find((x) => x[0] === field);
    if (!entry) return;
    focusTarget.current = entry[3];
    if (active === entry[2]) {
      document.getElementById(entry[3])?.focus();
      focusTarget.current = null;
    } else setActive(entry[2]);
  }
  async function save(): Promise<Version> {
    if (!version) throw new Error("教材がありません。");
    if (
      rawTime !== "" &&
      (!Number.isInteger(Number(rawTime)) ||
        Number(rawTime) <= 0 ||
        Number(rawTime) > 2147483647)
    )
      throw new Error(
        "統合制限時間は1〜2,147,483,647の整数秒で入力してください。未設定の下書きは空欄で保存できます。",
      );
    if (!dirty) return version;
    const body: Body = {
      ...version.body,
      title: version.body.title.trim(),
      researcherDescription: version.body.researcherDescription.trim(),
      videoRef: version.body.videoRef.trim(),
      sbInstructions: version.body.sbInstructions.trim(),
      kbInstructions: version.body.kbInstructions.trim(),
      integrationInstructions: version.body.integrationInstructions.trim(),
    };
    const metadata = await write<Omit<Version, "body">>(
      `/${versionId}`,
      "PUT",
      { expectedRevision: version.editRevision, body },
    );
    const updated = { ...metadata, body };
    setVersion(updated);
    setDirty(false);
    return updated;
  }
  async function perform(action: "save" | "check" | "publish" | "next") {
    if (!version || busy) return;
    if (
      action === "publish" &&
      !window.confirm(
        "テスト実行は未実施です（今回の画面では利用できません）。未実施でも完成登録できます。\n完成後はこの版と参照資材を変更・削除できません。完成登録しますか？",
      )
    )
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === "next") {
        const next = await write<{ id: string }>(
          `/${versionId}/next-draft`,
          "POST",
          {},
        );
        window.location.assign(`/research/materials/${next.id}`);
        return;
      }
      const current = await save();
      if (action === "check") {
        const result = await api<Check>(`/${versionId}/check`, {
          method: "POST",
        });
        setCheck(result);
        setNotice(
          result.ready
            ? "完成条件を確認しました。テスト未実施でも確認後に完成登録できます。"
            : "不足項目があります。完成チェックの項目から編集欄へ移動してください。",
        );
      } else if (action === "publish") {
        const metadata = await write<Omit<Version, "body">>(
          `/${versionId}/publish`,
          "POST",
          { expectedRevision: current.editRevision },
        );
        setVersion({ ...metadata, body: current.body });
        setDirty(false);
        setCheck(null);
        setNotice("完成登録しました。この版と資材は固定されています。");
      } else {
        setCheck(null);
        setNotice("下書きを保存しました。");
      }
    } catch (e) {
      setError(
        e instanceof Error ? uiText(e.message) : "操作を完了できませんでした。",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!version)
    return (
      <main className="materials-page">
        <Header editing />
        <div className="materials-content">
          {error ? (
            <p role="alert" className="session-error">
              {error}
            </p>
          ) : (
            <p role="status">教材を読み込んでいます…</p>
          )}
          <a href="/research/materials">教材一覧へ</a>
        </div>
      </main>
    );
  const b = version.body,
    readOnly = version.state === "PUBLISHED",
    selected = assets.find((a) => a.kitId === b.kitId);
  const issues =
    check && !dirty ? check.issues : localIssues(b, assets, rawTime);
  const canPublish =
    !assetsError &&
    check?.ready &&
    check.editRevision === version.editRevision &&
    !dirty &&
    localIssues(b, assets, rawTime).length === 0;
  function instructions(
    key: "sbInstructions" | "kbInstructions" | "integrationInstructions",
    id: string,
    label: string,
  ) {
    return (
      <label htmlFor={id}>
        {label} *
        <textarea
          id={id}
          maxLength={10000}
          value={b[key]}
          disabled={readOnly || busy}
          onChange={(e) => change(key, e.target.value)}
        />
      </label>
    );
  }
  return (
    <main className="materials-page">
      <Header editing />
      <div className="materials-content">
        <section className="material-summary">
          <div>
            <h2>教材名：{b.title || "未設定"}</h2>
            {readOnly && (
              <p>
                テスト状態：
                {version.testStatus === "COMPLETED"
                  ? "テスト実施済み"
                  : version.testStatus === "IN_PROGRESS"
                    ? "テストデータあり"
                    : "テスト未実施"}
              </p>
            )}
            <p>
              {readOnly ? "完成済み・固定" : "下書き"} / バージョン{" "}
              {version.version}
              {dirty
                ? " · 未保存の変更あり"
                : ` · 保存済み ${date(version.updatedAt)} JST`}
            </p>
          </div>
          <div className="material-actions">
            {readOnly ? (
              <a
                className="session-secondary-button"
                href={`/research/materials/${version.id}/test`}
              >
                テスト実行・記録
              </a>
            ) : (
              <button disabled aria-describedby="material-test-info">
                テスト実行
              </button>
            )}
            {readOnly ? (
              <button
                className="session-primary-button"
                disabled={busy}
                onClick={() => void perform("next")}
              >
                次版の下書きを作成
              </button>
            ) : (
              <>
                <button disabled={busy} onClick={() => void perform("save")}>
                  下書き保存
                </button>
                <button
                  className="session-primary-button"
                  disabled={busy}
                  onClick={() => void perform("check")}
                >
                  完成チェック
                </button>
              </>
            )}
          </div>
        </section>
        <div className="material-feedback" aria-live="polite">
          {error && (
            <p className="session-error" role="alert">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {assetsError && (
            <p role="alert">
              資材を取得できませんでした。入力を控えて再読み込みしてください。完成登録はできません。
            </p>
          )}
        </div>
        <div className="material-editor-grid">
          <nav
            className="material-panel material-nav"
            aria-label="教材の編集項目"
          >
            {sections.map(([id, label]) => (
              <button
                key={id}
                aria-current={active === id ? "page" : undefined}
                onClick={() => setActive(id)}
              >
                {label}
              </button>
            ))}
            <a href="/research/materials">教材一覧へ戻る</a>
          </nav>
          <section
            className="material-panel material-main"
            aria-labelledby="material-section-title"
          >
            <h2 id="material-section-title">
              {sections.find((x) => x[0] === active)![1]}
            </h2>
            {active === "basic" && (
              <>
                <p className="material-muted">
                  教材の名前と研究者向け説明を設定してください。
                </p>
                <label htmlFor="material-title">
                  教材名 *
                  <input
                    id="material-title"
                    maxLength={120}
                    value={b.title}
                    disabled={readOnly || busy}
                    onChange={(e) => change("title", e.target.value)}
                  />
                </label>
                <label htmlFor="material-description">
                  教材説明（研究者向け）
                  <textarea
                    id="material-description"
                    maxLength={10000}
                    value={b.researcherDescription}
                    disabled={readOnly || busy}
                    onChange={(e) =>
                      change("researcherDescription", e.target.value)
                    }
                  />
                </label>
                <VersionNote />
              </>
            )}
            {active === "video" && (
              <>
                <label htmlFor="material-video">
                  動画参照 *
                  <input
                    id="material-video"
                    maxLength={2048}
                    value={b.videoRef}
                    disabled={readOnly || busy}
                    onChange={(e) => change("videoRef", e.target.value)}
                  />
                </label>
                <p className="material-note">
                  HTTP(S)
                  URLまたは公開ファイルの絶対パスを設定します。URLを固定しても、リンク先の動画内容や公開状態の不変性は保証されません。
                </p>
              </>
            )}
            {active === "sb" &&
              instructions("sbInstructions", "material-sb", "SB 課題説明")}
            {active === "kb" &&
              instructions("kbInstructions", "material-kb", "KB 課題説明")}
            {active === "integration" && (
              <>
                {instructions(
                  "integrationInstructions",
                  "material-integration",
                  "統合 課題説明",
                )}
                <label htmlFor="material-time">
                  統合マップ制限時間（秒） *
                  <input
                    id="material-time"
                    type="number"
                    min="1"
                    max="2147483647"
                    step="1"
                    value={rawTime}
                    disabled={readOnly || busy}
                    onChange={(e) => {
                      const value = e.target.value;
                      setRawTime(value);
                      change(
                        "integrationSeconds",
                        value &&
                          Number.isInteger(Number(value)) &&
                          Number(value) > 0 &&
                          Number(value) <= 2147483647
                          ? Number(value)
                          : null,
                      );
                    }}
                  />
                </label>
                <p className="material-muted">
                  完成教材版に固定する値です。初期値・推奨時間は設定していません。保存形式は1〜2,147,483,647の整数秒です。未設定でも下書き保存できます。
                </p>
              </>
            )}
            {active === "kit" && (
              <>
                <label htmlFor="material-kit">
                  ゴールマップ／Kit *
                  <select
                    id="material-kit"
                    value={b.kitId ?? ""}
                    disabled={readOnly || busy || assetsError}
                    onChange={(e) => {
                      change("kitId", e.target.value || null);
                      change("seedConceptItemIds", []);
                    }}
                  >
                    <option value="">選択してください</option>
                    {assets.map((a) => (
                      <option
                        key={a.kitId}
                        value={a.kitId}
                        disabled={!a.available}
                      >
                        {a.goalTitle} / {a.kitName}
                        {a.available ? "" : "（要確認）"}
                      </option>
                    ))}
                  </select>
                </label>
                {selected && (
                  <p>
                    {selected.frozen ? "固定済み資材" : "未固定の資材"} ·{" "}
                    <a
                      href={`/maps/${selected.goalMapId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      ゴールマップを開く
                    </a>
                  </p>
                )}
                <p>
                  完成登録時にGoal
                  Map／Kitと部品を固定します。完成後に内容を変える場合は別のGoal
                  Map／Kitを選んでください。
                </p>
                <p>
                  <a
                    href="/research/goal-maps"
                    target="_blank"
                    rel="noreferrer"
                  >
                    ゴールマップの作成・Kit登録へ
                  </a>
                  （別タブ）
                </p>
                <p className="material-muted">
                  既存のJSON取込みは別IDの資材を作成します。固定済み資材を上書きしません。
                </p>
              </>
            )}
            {active === "seeds" && (
              <>
                <p>
                  選択したKitから、SBに初期配置する概念を選びます。1件以上が完成条件です。リンクは初期配置しません。
                </p>
                <fieldset
                  id="material-seeds"
                  tabIndex={-1}
                  disabled={readOnly || busy}
                >
                  <legend>SB初期概念 *</legend>
                  {selected?.concepts.map((c) => (
                    <label className="material-seed" key={c.id}>
                      <input
                        type="checkbox"
                        checked={b.seedConceptItemIds.includes(c.id)}
                        onChange={(e) =>
                          change(
                            "seedConceptItemIds",
                            e.target.checked
                              ? [...b.seedConceptItemIds, c.id]
                              : b.seedConceptItemIds.filter(
                                  (id) => id !== c.id,
                                ),
                          )
                        }
                      />
                      {c.label}
                    </label>
                  ))}
                  {!selected && (
                    <p>先にゴールマップ／Kitを選択してください。</p>
                  )}
                </fieldset>
                <p>選択数：{b.seedConceptItemIds.length}</p>
              </>
            )}
            {active === "test" && (
              <>
                <p>
                  テスト実行は完成済み教材版を対象とします。研究データと分離してMap・履歴を保存します。
                </p>
                {readOnly && (
                  <a href={`/research/materials/${version.id}/test`}>
                    テスト実行・記録を開く
                  </a>
                )}
                <p>
                  テストを実行しなくても、完成チェックと確認を経て完成登録できます。
                </p>
              </>
            )}
            <p
              id="material-test-info"
              className="material-muted material-test-info"
            >
              完成版のテストは専用画面で実行します。通常の実施や参加者Sessionは作成しません。
            </p>
          </section>
          <aside className="material-panel material-checklist">
            <h2>完成チェック</h2>
            <ul>
              {fields.map(([field, label]) => {
                const missing = issues.some((i) => i.field === field);
                return (
                  <li
                    key={field}
                    className={missing ? "is-missing" : "is-present"}
                  >
                    <button onClick={() => jump(field)}>
                      <span aria-hidden="true">{missing ? "○" : "✓"}</span>
                      <span>
                        {label}
                        <small>{missing ? "未設定・要確認" : "設定済み"}</small>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {check?.issues.length ? (
              <details className="material-issue-details">
                <summary>
                  不足項目の詳しい案内（{check.issues.length}件）
                </summary>
                <ul className="material-issues">
                  {check.issues.map((i, n) => (
                    <li key={n}>
                      <button onClick={() => jump(i.field)}>{i.message}</button>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {readOnly ? (
              <p className="material-note">
                完成済み・固定
                <br />
                変更は次版の下書きで行います。
              </p>
            ) : (
              <>
                <p className={canPublish ? "" : "material-muted"}>
                  {canPublish
                    ? "完成登録できます。"
                    : issues.length
                      ? "不足項目があるため完成登録不可"
                      : "完成チェックを行ってください。"}
                </p>
                <button
                  className="session-primary-button material-complete"
                  disabled={!canPublish || busy}
                  onClick={() => void perform("publish")}
                >
                  完成登録
                </button>
              </>
            )}
          </aside>
        </div>
        <p className="material-footer">
          <a href="/research/materials">教材一覧へ戻る</a>
        </p>
      </div>
    </main>
  );
}
