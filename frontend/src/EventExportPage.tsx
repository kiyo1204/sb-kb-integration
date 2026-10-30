import { useEffect, useState, type FormEvent } from "react";
import EventTimeline from "./EventTimeline";
import { apiFetch, downloadApiFile } from "./auth-client";
type Session = {
  id: string;
  participantCode: string | null;
  studyGroup: string | null;
  pseudonym?: string;
  status: string;
};
type Metadata = {
  exportId: string;
  snapshotAt: string;
  expiresAt: string;
  eventCount: number;
  payloadWarnings: number;
  boundaryWarnings: number;
  auditSaved: boolean;
  files: { name: string; rows: number | null; bytes: number }[];
};
const activityNames: Record<string, string> = {
  LESSON: "授業動画",
  PRIOR_MAP: "Scratch-Build",
  KB_MAP: "Kit-Build",
  PRE_ASSESSMENT: "事前評価",
  INTEGRATION_MAP: "統合マップ",
  SELF_STUDY: "自主学習",
  POST_ASSESSMENT: "事後評価",
  UNASSIGNED: "未所属",
};
const groupNames: Record<string, string> = {
  EXPERIMENTAL: "実験群",
  CONTROL: "統制群",
  UNASSIGNED: "群なし・未所属",
};
const eventNames: Record<string, string> = {
  SESSION_CREATE: "セッション作成",
  SESSION_START: "セッション開始",
  SESSION_COMPLETE: "セッション完了",
  SESSION_SETTINGS_CHANGE: "設定変更",
  STAGE_START: "活動開始",
  STAGE_COMPLETE: "活動完了",
  STAGE_DEADLINE: "期限到達",
  STAGE_PAUSE: "非表示・中断の観測",
  STAGE_RESUME: "復帰の観測",
  SCREEN_ENTER: "画面入場",
  SCREEN_LEAVE: "画面離脱",
  VIDEO_PLAY: "動画再生",
  VIDEO_PAUSE: "動画一時停止",
  VIDEO_SEEK: "動画シーク",
  VIDEO_COMPLETE: "動画終了",
  ADD_CONCEPT: "概念追加",
  EDIT_CONCEPT: "概念変更",
  MOVE_CONCEPT: "概念移動",
  DELETE_CONCEPT: "概念削除",
  MERGE_CONCEPT: "概念統合",
  IMPORT_KIT_CONCEPT: "キット概念取込み",
  ADD_LINK: "関係追加",
  MOVE_LINK: "Linkの位置移動",
  EDIT_LINK: "関係変更",
  DELETE_LINK: "関係削除",
  RECONNECT_LINK: "関係再接続",
  IMPORT_KIT_LINK: "キット関係取込み",
  UNDO: "元に戻す",
  REDO: "やり直す",
  MAP_SAVE: "マップ保存",
  MAP_KIT_ASSIGN: "キット割当",
  MAP_SUBMIT: "通常提出",
  MAP_AUTO_SUBMIT: "自動提出",
  FEEDBACK_CHECK: "一致確認",
  FEEDBACK_DISPLAY: "フィードバック表示",
  ASSESSMENT_EDIT: "回答編集",
  ASSESSMENT_SUBMIT: "回答提出",
  RESEARCH_ANALYSIS_VIEW: "分析閲覧",
  RESEARCH_ASSESSMENT_CHANGE: "評価設定変更",
  RESEARCH_EXPORT: "出力",
};
function CheckOptions({
  legend,
  options,
  selected,
  onChange,
  disabled,
}: {
  legend: string;
  options: Record<string, string>;
  selected: string[];
  onChange: (values: string[]) => void;
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>{legend}（未選択はすべて）</legend>
      <div className="event-export-options">
        {Object.entries(options).map(([value, label]) => (
          <label key={value}>
            <input
              type="checkbox"
              checked={selected.includes(value)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, value]
                    : selected.filter((x) => x !== value),
                )
              }
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
export default function EventExportPage({browse = false}: {browse?: boolean}) {
  const initial = new URLSearchParams(window.location.search).get("sessionId");
  const [sessions, setSessions] = useState<Session[]>([]),
    [sessionIds, setSessionIds] = useState<string[]>(initial ? [initial] : []),
    [learnerText, setLearnerText] = useState(""),
    [groups, setGroups] = useState<string[]>([]),
    [activities, setActivities] = useState<string[]>([]),
    [types, setTypes] = useState<string[]>([]),
    [outcomes, setOutcomes] = useState<string[]>([]),
    [catalog, setCatalog] = useState<string[]>([]),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<Metadata | null>(null);
  useEffect(() => {
    let active = true;
    Promise.all([
      apiFetch("/api/research/stage1/sessions").then(async (r) => {
        if (!r.ok) throw new Error();
        return r.json() as Promise<{ sessions: Session[] }>;
      }),
      apiFetch("/api/research/event-exports/catalog").then(async (r) => {
        if (!r.ok) throw new Error();
        return r.json() as Promise<{ eventTypes: string[] }>;
      }),
    ])
      .then(([s, c]) => {
        if (active) {
          setSessions(s.sessions);
          setCatalog(c.eventTypes);
        }
      })
      .catch(() => {
        if (active)
          setError(
            "出力条件を読み込めませんでした。研究者としてログインしているか確認してください。",
          );
      });
    return () => {
      active = false;
    };
  }, []);
  const instant = (s: string) =>
    s ? (s.length === 16 ? s + ":00" : s) + "+09:00" : null;
  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch(browse ? "/api/research/event-views" : "/api/research/event-exports", {
        method: "POST",
        signal: AbortSignal.timeout(150000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: {
            sessionIds,
            learnerIds: learnerText.split(/[\s,]+/).filter(Boolean),
            groups,
            activities,
            eventTypes: types,
            outcomes,
            from: instant(from),
            to: instant(to),
          },
        }),
      });
      const data = await r.json();
      if (!r.ok)
        throw new Error(data.message ?? "出力を作成できませんでした。");
      const previous = result;
      setResult(data);
      if (previous)
        void apiFetch("/api/research/event-exports/" + previous.exportId, {
          method: "DELETE",
        }).catch(() => undefined);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "出力を作成できませんでした。",
      );
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!result) return;
    setBusy(true);
    try {
      const r = await apiFetch(
        "/api/research/event-exports/" + result.exportId,
        { method: "DELETE" },
      );
      if (!r.ok) throw new Error();
      setResult(null);
    } catch {
      setError(
        "一時出力を削除できませんでした。有効期限後にも自動で削除されます。",
      );
    } finally {
      setBusy(false);
    }
  }
  function download(name: string) {
    if (!result) return;
    void downloadApiFile(
      "/api/research/event-exports/" + result.exportId + "/" + name,
    ).catch(() =>
      setError(
        "取得できませんでした。有効期限や接続を確認し、必要なら出力を作り直してください。",
      ),
    );
  }
  return (
    <main className={browse ? "page event-view-page" : "page"}>
      <section className="session-card">
        <p className="eyebrow">研究者用</p>
        <h1>{browse ? "研究イベントの時系列ログ" : "研究イベントの絞り込み出力"}</h1>
        <p>
          JSONと各CSVを同じスナップショットから生成します。学習中のセッションも含めて指定できます。
        </p>
        <a href="/">研究者トップへ戻る</a>
      </section>
      <form
        className="session-card event-export-form"
        onSubmit={(e) => void create(e)}
        aria-busy={busy}
      >
        <label>
          セッション（未選択はすべて）
          <select
            multiple
            size={6}
            value={sessionIds}
            disabled={busy}
            onChange={(e) =>
              setSessionIds(
                Array.from(e.target.selectedOptions, (x) => x.value),
              )
            }
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.pseudonym ?? "仮名未設定"} / {groupNames[s.studyGroup ?? "UNASSIGNED"]}
              </option>
            ))}
          </select>
        </label>
        <p>
          複数選択はCtrlキー（MacはCommandキー）を押しながらクリックしてください。
          <button
            type="button"
            className="session-secondary-button"
            disabled={busy}
            onClick={() => setSessionIds([])}
          >
            セッション選択を解除
          </button>
        </p>
        <label>
          仮名の研究用学習者ID（任意、空白またはカンマ区切り）
          <input
            value={learnerText}
            onChange={(e) => setLearnerText(e.target.value)}
            disabled={busy}
            placeholder="P-研究用ID"
          />
        </label>
        <p>
          仮名IDは管理画面で確認できる「P-」から始まるIDです。研究者が明示したセッション間だけで関連付けます。参加者コードから同一人物を推測しません。
        </p>
        <CheckOptions
          legend="群"
          options={groupNames}
          selected={groups}
          onChange={setGroups}
          disabled={busy}
        />
        <CheckOptions
          legend="活動"
          options={activityNames}
          selected={activities}
          onChange={setActivities}
          disabled={busy}
        />
        <CheckOptions legend="結果" options={{SUCCESS:"成功",FAILURE:"失敗",REJECTED:"拒否（旧Kit不一致を含む）",CANCELLED:"取消",UNKNOWN:"不明（旧記録等）"}} selected={outcomes} onChange={setOutcomes} disabled={busy}/>
        <details>
          <summary>操作種別（選択 {types.length}件、未選択はすべて）</summary>
          <CheckOptions
            legend="操作種別"
            options={Object.fromEntries(
              catalog.map((key) => [
                key,
                (eventNames[key] ?? key) + "（" + key + "）",
              ]),
            )}
            selected={types}
            onChange={setTypes}
            disabled={busy}
          />
        </details>
        <div className="event-export-period">
          <label>
            開始日時（日本時間 UTC+09:00、この時刻を含む）
            <input
              type="datetime-local"
              step="1"
              value={from}
              disabled={busy}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            終了日時（日本時間 UTC+09:00、この時刻を含まない）
            <input
              type="datetime-local"
              step="1"
              value={to}
              disabled={busy}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        <p>
          期間はサーバー保存時刻を基準とします。出力日時はUTC（Z）です。条件同士はすべて満たすものを抽出し、同じ条件内の選択肢はいずれか一致で抽出します。
        </p>
        <button
          className="session-primary-button"
          type="submit"
          disabled={busy || !catalog.length}
        >
          {busy ? "検索・出力を準備しています…" : browse ? "指定した条件で検索" : "指定した条件で出力を準備"}
        </button>
        <p>
          一時出力は15分間保持します。次の出力の作成成功時に前の一時出力を置き換えます。元の研究データは変更しません。
        </p>
      </form>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {result && browse && <EventTimeline key={result.exportId} exportId={result.exportId} eventNames={eventNames} activityNames={activityNames} groupNames={groupNames}/>}
      {result && (
        <section className="session-card" aria-label="生成済みの出力">
          <h2>生成済みの出力：{result.eventCount}イベント</h2>
          <p>
            取得時刻（UTC）：{result.snapshotAt}
            <br />
            有効期限（UTC）：{result.expiresAt}
          </p>
          {result.eventCount === 0 && (
            <p role="status">
              一致するイベントは0件です。CSVは列見出しのみで出力します。
            </p>
          )}
          {!result.auditSaved && (
            <p role="status">
              データ生成は成功しましたが、出力操作の監査記録の保存は確認できていません。
            </p>
          )}
          {result.payloadWarnings > 0 && (
            <p role="status">
              本文を出力できない記録が {result.payloadWarnings}
              件あります。JSONのpayload_statusを確認してください。
            </p>
          )}
          {result.boundaryWarnings > 0 && (
            <p role="status">
              旧・新履歴の境界に注意が必要な記録が {result.boundaryWarnings}
              件あります。既存の混在履歴で確認してください。
            </p>
          )}
          <button
            type="button"
            className="session-primary-button"
            onClick={() => download("bundle.zip")}
          >
            JSON・共通CSV・用途別CSVを一括取得（ZIP）
          </button>
          <details>
            <summary>個別のファイルを取得</summary>
            <div className="event-export-table">
              <table>
                <thead>
                  <tr>
                    <th>ファイル</th>
                    <th>イベント行数</th>
                    <th>サイズ</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {result.files
                    .filter((f) => f.name !== "bundle.zip")
                    .map((f) => (
                      <tr key={f.name}>
                        <td>{f.name}</td>
                        <td>{f.rows ?? "—"}</td>
                        <td>{Math.ceil(f.bytes / 1024)} KB</td>
                        <td>
                          <button
                            type="button"
                            onClick={() => download(f.name)}
                          >
                            取得
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
          <p>
            用途別CSVには同じイベントが重複して含まれる場合があります。各行のevent_idで共通CSVへ結合してください。未報告・未観測から欠損なしとは判断できません。
          </p>
          <button
            type="button"
            className="session-secondary-button"
            disabled={busy}
            onClick={() => void remove()}
          >
            一時出力を削除
          </button>
        </section>
      )}
    </main>
  );
}
