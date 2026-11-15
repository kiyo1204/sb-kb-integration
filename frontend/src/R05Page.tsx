import { newClientId, SecureRandomUnavailableError } from "./client-identity";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, getAccessToken } from "./auth-client";
import { ConceptCanvas } from "./MapPage";
import "./materials.css";
import "./r05.css";
type C = {
  id: string;
  mapId: string;
  label: string;
  positionX: number;
  positionY: number;
  mergedIntoConceptId: string | null;
  provenance: { sourceConceptId: string; relationType: string }[];
};
type L = {
  id: string;
  mapId: string;
  label: string;
  sourceConceptId: string;
  targetConceptId: string;
  labelPositionX?: number;
  labelPositionY?: number;
  provenance: { sourceLinkId: string; relationType: string }[];
};
type Snapshot = {
  mapId: string;
  mapType: "PRIOR" | "KB" | "INTEGRATION";
  concepts: C[];
  links: L[];
};
type MapRow = {
  id: string;
  map_kind: string;
  state: Snapshot;
  submitted_at: string | null;
};
type View = {
  audit?: {
    action: string;
    http_status: number;
    outcome: string;
    reason_code: string;
    recorded_at: string;
  }[];
  material: {
    body: {
      title: string;
      videoRef: string;
      sbInstructions: string;
      kbInstructions: string;
      integrationInstructions: string;
      integrationSeconds: number;
      seedConceptItemIds: string[];
    };
    concepts: { id: string; sourceId: string; label: string }[];
    links: { id: string; sourceId: string; label: string }[];
  };
  run: null | {
    id: string;
    phase: string;
    revision: number;
    integrationStartedAt: string | null;
    lastCheck: string | null;
  };
  acceptance: null | { submission_kind: string; accepted_at: string };
  data: null | {
    maps: MapRow[];
    history: {
      id: string;
      test_map_id: string;
      recorded_at: string;
      operation: { operationType: string; before: Snapshot; after: Snapshot };
    }[];
  };
};
class R05HttpError extends Error {
  constructor(
    readonly status: number,
    code: string,
  ) {
    const messages: Record<string, string> = {
      kb_current_match_required:
        "最新の保存状態で一致を確認してから提出してください。",
      execution_not_owned:
        "この画面ではテストを操作できません。記録の確認と削除ができます。",
      execution_closed: "このテストの操作は終了しています。",
      revision_conflict:
        "別の要求で状態が更新されました。最新状態を確認してください。",
      protected_concept: "初期概念の名称変更・削除はできません。",
      kit_parts_only: "KBでは固定Kitの部品を使ってください。",
      kit_label_locked: "KB部品の名称は変更できません。",
      kit_part_used: "この部品は使用済みです。",
      invalid_label: "名称と文字数を確認してください。",
      undo_redo_unavailable: "元に戻す・やり直す対象の操作がありません。",
      confirmation_changed:
        "削除対象が更新されています。最新の対象件数を確認してください。",
      test_already_exists_or_completed:
        "テストデータまたは完了記録があります。未完了の場合は対象データを削除してから新しく開始してください。",
      safety_budget_exceeded:
        "安全確認の上限に達しました。入力や表示範囲を小さくしてください。",
      safety_lookup_unavailable:
        "安全確認を完了できません。時間をおいて再確認してください。",
    };
    super(
      messages[code] ??
        "操作を完了できません。最新のテスト状態を確認してください。",
    );
  }
}
type PendingOperation = {
  id: string;
  action: string;
  data: Record<string, unknown>;
  executionId: string;
  expectedRevision: number;
  key: string;
};
const operationNames: Record<string, string> = {
  LESSON_COMPLETE: "授業確認を完了",
  ADD_CONCEPT: "概念を追加",
  EDIT_CONCEPT: "概念を変更",
  DELETE_CONCEPT: "概念を削除・Merge解除",
  MOVE_CONCEPT: "概念を移動",
  ADD_LINK: "リンクを追加",
  EDIT_LINK: "リンクを変更",
  DELETE_LINK: "リンクを削除",
  MOVE_LINK: "リンクラベルを移動",
  RECONNECT_LINK: "リンクを再接続",
  IMPORT_KIT_CONCEPT: "Kit概念を配置",
  IMPORT_KIT_LINK: "Kitリンクを接続",
  MERGE_CONCEPT: "概念をMerge",
  UNDO: "元に戻す",
  REDO: "やり直す",
  CHECK: "KB一致を確認",
  SUBMIT: "提出",
  AUTO_SUBMIT: "期限時自動提出",
  MAP_SUBMIT: "提出",
  MAP_AUTO_SUBMIT: "期限時自動提出",
  INTERRUPT: "中断",
};
export default function R05Page({ versionId }: { versionId: string }) {
  const [view, setView] = useState<View | null>(null),
    [active, setActive] = useState(false),
    [busy, setBusy] = useState(false),
    [startUnconfirmed, setStartUnconfirmed] = useState(false),
    [pendingDelete, setPendingDelete] = useState<{
      id: string;
      key: string;
      confirmation: string;
    } | null>(null),
    [retry, setRetry] = useState<PendingOperation | null>(null),
    [online, setOnline] = useState(navigator.onLine),
    [error, setError] = useState(""),
    [feedback, setFeedback] = useState<{
      matched: boolean;
      concepts: { matched: number; total: number };
      relations: { matched: number; total: number };
    } | null>(null),
    [viewed, setViewed] = useState(false),
    [selection, setSelection] = useState("CURRENT"),
    [historyState, setHistoryState] = useState<Snapshot | null>(null),
    [label, setLabel] = useState(""),
    [source, setSource] = useState(""),
    [target, setTarget] = useState(""),
    [part, setPart] = useState("");
  const proof = useRef(""),
    startKey = useRef(""),
    latest = useRef({ view, active, busy, retry });
  useEffect(() => {
    latest.current = { view, active, busy, retry };
  }, [view, active, busy, retry]);
  const base = "/api/research/materials/" + versionId + "/r05";
  const request = useCallback(
    async (path: string, init?: RequestInit) => {
      const r = await apiFetch(base + path, init);
      const d = await r.json();
      if (!r.ok)
        throw new R05HttpError(
          r.status,
          typeof d.error === "string" && /^[a-z_]+$/.test(d.error)
            ? d.error
            : "r05_unavailable",
        );
      return d;
    },
    [base],
  );
  const load = useCallback(async () => {
    const d = (await request("")) as View;
    setView(d);
    return d;
  }, [request]);
  useEffect(() => {
    let alive = true;
    void request("")
      .then((d) => {
        if (alive) setView(d);
      })
      .catch(() => {
        if (alive)
          setError(
            "テスト状態を読み込めません。研究者コードと教材版を確認してください。",
          );
      });
    return () => {
      alive = false;
    };
  }, [request]);
  const operate = useCallback(
    async (
      action: string,
      data: Record<string, unknown> = {},
      replay?: PendingOperation,
    ) => {
      const current = latest.current;
      if (!current.view?.run || !current.active || current.busy)
        throw new Error("execution_not_owned");
      if (current.retry && !replay) throw new Error("operation_result_pending");
      let command: PendingOperation | undefined;
      setBusy(true);
      setError("");
      try {
        command = replay ?? {
          id: current.view.run.id,
          action,
          data,
          executionId: proof.current,
          expectedRevision: current.view.run.revision,
          key: newClientId(),
        };
        const result = await request("/" + command.id + "/operations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": command.key,
          },
          body: JSON.stringify({
            action: command.action,
            data: command.data,
            executionId: command.executionId,
            expectedRevision: command.expectedRevision,
          }),
        });
        if (["ADD_CONCEPT", "ADD_LINK", "MERGE_CONCEPT"].includes(action))
          setLabel("");
        if (action === "CHECK") setFeedback(result.outcome);
        else if (!["MOVE_CONCEPT", "MOVE_LINK", "TICK"].includes(action))
          setFeedback(null);
        await load();
        setRetry(null);
        setHistoryState(null);
        return result;
      } catch (e) {
        setRetry(
          !command || (e instanceof R05HttpError && e.status < 500)
            ? null
            : command,
        );
        setError(
          e instanceof R05HttpError || e instanceof SecureRandomUnavailableError
            ? e.message
            : "操作結果を確認できません。同じ要求で結果を再確認してください。",
        );
        await load().catch(() => undefined);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [request, load],
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      const c = latest.current,
        r = c.view?.run;
      if (
        c.active &&
        !c.busy &&
        !c.retry &&
        r?.phase === "INTEGRATION" &&
        r.integrationStartedAt &&
        Date.now() >=
          Date.parse(r.integrationStartedAt) +
            c.view!.material.body.integrationSeconds * 1000 &&
        navigator.onLine
      )
        void operate("TICK").catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [operate]);
  useEffect(() => {
    const interrupt = () => {
      const c = latest.current,
        r = c.view?.run;
      if (!c.active || !r || ["COMPLETE", "INTERRUPTED"].includes(r.phase))
        return;
      try {
        void fetch(base + "/" + r.id + "/operations", {
          method: "POST",
          keepalive: true,
          headers: {
            Authorization: "Bearer " + getAccessToken(),
            "Content-Type": "application/json",
            "Idempotency-Key": newClientId(),
          },
          body: JSON.stringify({
            action: "INTERRUPT",
            executionId: proof.current,
            expectedRevision: r.revision,
          }),
        }).catch(() => undefined);
      } catch (e) {
        if (e instanceof SecureRandomUnavailableError) setError(e.message);
      }
    };
    window.addEventListener("pagehide", interrupt);
    return () => window.removeEventListener("pagehide", interrupt);
  }, [base]);
  async function start() {
    setStartUnconfirmed(true);
    setBusy(true);
    setError("");
    try {
      if (!proof.current) proof.current = newClientId();
      if (!startKey.current) startKey.current = newClientId();
      await request("", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": startKey.current,
        },
        body: JSON.stringify({ executionId: proof.current }),
      });
      setActive(true);
      setStartUnconfirmed(false);
      await load();
    } catch (e) {
      if (e instanceof SecureRandomUnavailableError) setStartUnconfirmed(false);
      setError(
        e instanceof SecureRandomUnavailableError
          ? e.message
          : "開始を確認できません。同じ開始ボタンで結果を再確認できます。",
      );
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!view?.run && !pendingDelete) return;
    setBusy(true);
    setError("");
    let command = pendingDelete;
    try {
      if (!command) {
        const id = view!.run!.id;
        const preview = await request("/" + id + "/deletion-preview");
        if (
          !confirm(
            `テスト ${id} のMap ${preview.mapCount}件・履歴 ${preview.historyCount}件を削除します。テスト実施済み記録と研究データは保持します。よろしいですか？`,
          )
        )
          return;
        command = {
          id,
          key: newClientId(),
          confirmation: preview.confirmation,
        };
      }
      await request("/" + command.id, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": command.key,
        },
        body: JSON.stringify({
          confirmed: true,
          confirmation: command.confirmation,
        }),
      });
      setPendingDelete(null);
      setRetry(null);
      setActive(false);
      setStartUnconfirmed(false);
      proof.current = "";
      startKey.current = "";
      setSelection("CURRENT");
      setHistoryState(null);
      await load();
    } catch (e) {
      if (command)
        setPendingDelete(
          e instanceof R05HttpError && e.status < 500 ? null : command,
        );
      setError(
        e instanceof SecureRandomUnavailableError
          ? e.message
          : "削除結果を確認できません。最新状態を確認し、同じ要求で結果を再確認してください。",
      );
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  const perform = (action: string, data: Record<string, unknown> = {}) =>
    void operate(action, data).catch(() => undefined);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const run = view?.run,
    maps = view?.data?.maps ?? [],
    map =
      selection === "CURRENT"
        ? (maps.find((m) => m.map_kind === run?.phase) ??
          maps.find((m) => m.map_kind === "INTEGRATION") ??
          maps.find((m) => m.map_kind === "KB") ??
          maps.find((m) => m.map_kind === "SB"))
        : maps.find((m) => m.id === selection),
    state = historyState ?? map?.state,
    readonly =
      busy ||
      !online ||
      !!retry ||
      !active ||
      !!historyState ||
      selection !== "CURRENT" ||
      !map ||
      !!map.submitted_at ||
      !["SB", "KB", "INTEGRATION"].includes(run?.phase ?? "");
  const concepts =
    state?.concepts.filter((c) => c.mergedIntoConceptId === null) ?? [];
  const options = concepts.map((c) => (
    <option key={c.id} value={c.id}>
      {c.label} ({c.id.slice(0, 4)})
    </option>
  ));
  return (
    <main className="materials-page r05-page">
      <header className="materials-header">
        <h1>R05：教材テスト実行</h1>
        <a href={"/research/materials/" + versionId}>教材へ戻る</a>
      </header>
      <div className="materials-content">
        <p className="session-card r05-intro">
          研究者専用のテストです。Map・履歴は研究データと分離して保存します。参加者の実施・コードは作成しません。中断・画面を閉じた後の再開はできません。
        </p>
        {error && (
          <p className="r05-feedback r05-feedback-error" role="alert">
            {error}
          </p>
        )}
        {busy && (
          <p className="r05-feedback" role="status" aria-live="polite">
            処理中です。応答を確認しています。
          </p>
        )}
        {pendingDelete && (
          <button disabled={busy || !online} onClick={() => void remove()}>
            削除結果を再確認
          </button>
        )}
        {retry && (
          <button
            disabled={busy || !online}
            onClick={() =>
              void operate(retry.action, retry.data, retry).catch(
                () => undefined,
              )
            }
          >
            結果未確認の操作を再確認
          </button>
        )}
        {!online && (
          <p className="r05-feedback" role="status">
            オフラインです。接続が戻るまで操作・提出はできません。
          </p>
        )}
        {!view ? (
          error ? (
            <section className="session-card r05-load-error">
              <h2>テスト状態を表示できません</h2>
              <p role="status">
                接続と研究者コードを確認し、状態を再取得してください。
              </p>
              <button
                disabled={busy || !online}
                onClick={() => {
                  void load()
                    .then(() => setError(""))
                    .catch(() =>
                      setError(
                        "テスト状態を読み込めません。研究者コードと教材版を確認してください。",
                      ),
                    );
                }}
              >
                状態を再取得
              </button>
            </section>
          ) : (
            <p className="r05-feedback" role="status">
              読み込み中…
            </p>
          )
        ) : (
          <>
            <section className="session-card r05-status-card">
              <div className="r05-status-heading">
                <div>
                  <p className="r05-section-kicker">教材版</p>
                  <h2>{view.material.body.title}</h2>
                </div>
                <p
                  role="status"
                  className={`r05-run-status${view.acceptance ? " is-complete" : run ? " is-active" : " is-empty"}`}
                >
                  {view.acceptance
                    ? "テスト実施済み（" +
                      (view.acceptance.submission_kind === "AUTOMATIC"
                        ? "期限時自動提出"
                        : "手動提出") +
                      "）"
                    : run
                      ? "テスト状態：" +
                        ({
                          LESSON: "授業確認",
                          SB: "SB作成",
                          KB: "KB再構成",
                          INTEGRATION: "統合マップ作成",
                          COMPLETE: "提出受理・完了",
                          INTERRUPTED: "中断",
                        }[run.phase] ?? "確認中")
                      : "テスト未実施"}
                </p>
              </div>
              <div className="r05-primary-actions">
                {!view.acceptance && (!run || startUnconfirmed) && (
                  <button disabled={busy} onClick={() => void start()}>
                    {startUnconfirmed ? "開始結果を再確認" : "テストを開始"}
                  </button>
                )}
              </div>
              {run && !active && !view.acceptance && (
                <p className="r05-completion-note">
                  この画面では中断したテストを再開できません。Map・履歴の確認と削除ができます。削除完了後に新しいテストを開始できます。
                </p>
              )}
              {run && (
                <div className="r05-secondary-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void load().catch(() =>
                        setError("状態を確認できません。"),
                      )
                    }
                  >
                    状態を更新
                  </button>
                  <button
                    disabled={busy || !!pendingDelete}
                    onClick={() => void remove()}
                  >
                    テストデータを削除
                  </button>
                  {active &&
                    !["COMPLETE", "INTERRUPTED"].includes(run.phase) && (
                      <button
                        disabled={busy}
                        onClick={() => perform("INTERRUPT")}
                      >
                        テストを中断
                      </button>
                    )}
                </div>
              )}
              {view.acceptance && (
                <p className="r05-completion-note">
                  完了記録はテストデータ削除後も保持します。完了済み教材版の再テストはできません。
                </p>
              )}
            </section>
            {active && run?.phase === "LESSON" && (
              <section className="session-card r05-lesson-section">
                <h2>授業・動画</h2>
                <video
                  controls
                  src={view.material.body.videoRef}
                  style={{ maxWidth: "100%" }}
                />
                <p>動画参照の固定は、URL先の内容不変を保証しません。</p>
                <label>
                  <input
                    type="checkbox"
                    checked={viewed}
                    onChange={(e) => setViewed(e.target.checked)}
                  />
                  視聴・内容の確認を終えました
                </label>
                <button
                  disabled={!viewed || busy}
                  onClick={() => perform("LESSON_COMPLETE", { viewed: true })}
                >
                  SBへ進む
                </button>
              </section>
            )}
            {run && (
              <section className="session-card r05-map-picker">
                <h2>Map・履歴の確認</h2>
                <p>活動Mapの保存状態と、記録された操作履歴を確認できます。</p>
                <label>
                  表示するMap
                  <select
                    value={selection}
                    onChange={(e) => {
                      setSelection(e.target.value);
                      setHistoryState(null);
                    }}
                  >
                    <option value="CURRENT">現在の活動</option>
                    {maps.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.map_kind}
                      </option>
                    ))}
                  </select>
                </label>
              </section>
            )}
            {map && state && (
              <section className="session-card r05-map-workspace">
                <div className="r05-map-heading">
                  <h2>{map.map_kind}</h2>
                  <p
                    className={`r05-map-submit-state${map.submitted_at ? " is-submitted" : " is-draft"}`}
                    role="status"
                  >
                    <strong>{map.submitted_at ? "提出済み" : "未提出"}</strong>
                    <span>選択中Map本体の現在の状態</span>
                    {map.submitted_at && (
                      <time dateTime={map.submitted_at}>
                        提出時刻：{new Date(map.submitted_at).toLocaleString()}
                      </time>
                    )}
                  </p>
                </div>
                {historyState && (
                  <p className="r05-history-view-note" role="status">
                    履歴の状態を表示中です。上の提出状態は選択中Map本体の現在の記録です。
                  </p>
                )}
                <details>
                  <summary>固定教材版の課題説明</summary>
                  <p style={{ whiteSpace: "pre-wrap" }}>
                    {map.map_kind === "SB"
                      ? view.material.body.sbInstructions
                      : map.map_kind === "KB"
                        ? view.material.body.kbInstructions
                        : view.material.body.integrationInstructions}
                  </p>
                </details>
                {run?.phase === "INTEGRATION" && (
                  <p>
                    制限時間：{view.material.body.integrationSeconds}秒／開始：
                    {run.integrationStartedAt}
                  </p>
                )}
                {!readonly && (
                  <div className="assessment-actions">
                    <button onClick={() => perform("UNDO")}>元に戻す</button>
                    <button onClick={() => perform("REDO")}>やり直す</button>
                    <label>
                      概念・リンク名
                      <input
                        aria-label="概念・リンク名"
                        value={label}
                        maxLength={512}
                        onChange={(e) => setLabel(e.target.value)}
                      />
                    </label>
                    {run?.phase !== "KB" && (
                      <button
                        disabled={!label.trim()}
                        onClick={() =>
                          perform("ADD_CONCEPT", {
                            label,
                            x:
                              Math.max(0, ...concepts.map((c) => c.positionX)) +
                              250,
                            y: 100,
                          })
                        }
                      >
                        概念を追加
                      </button>
                    )}
                    <label>
                      始点
                      <select
                        aria-label="始点"
                        value={source}
                        onChange={(e) => setSource(e.target.value)}
                      >
                        <option value="">選択</option>
                        {options}
                      </select>
                    </label>
                    <label>
                      終点
                      <select
                        aria-label="終点"
                        value={target}
                        onChange={(e) => setTarget(e.target.value)}
                      >
                        <option value="">選択</option>
                        {options}
                      </select>
                    </label>
                    {run?.phase !== "KB" && (
                      <button
                        disabled={!source || !target || !label.trim()}
                        onClick={() =>
                          perform("ADD_LINK", {
                            sourceId: source,
                            targetId: target,
                            label,
                          })
                        }
                      >
                        リンクを追加
                      </button>
                    )}
                    {run?.phase === "INTEGRATION" && (
                      <button
                        disabled={
                          !source ||
                          !target ||
                          source === target ||
                          !label.trim()
                        }
                        onClick={() =>
                          perform("MERGE_CONCEPT", {
                            sourceId: source,
                            targetId: target,
                            label,
                          })
                        }
                      >
                        選択した概念をMerge
                      </button>
                    )}
                    {run?.phase !== "SB" && (
                      <>
                        <label>
                          Kit関係部品
                          <select
                            aria-label="Kit関係部品"
                            value={part}
                            onChange={(e) => setPart(e.target.value)}
                          >
                            <option value="">選択</option>
                            {view.material.links.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          disabled={!part || !source || !target}
                          onClick={() =>
                            perform("IMPORT_KIT_LINK", {
                              partId: part,
                              sourceId: source,
                              targetId: target,
                            })
                          }
                        >
                          関係部品を接続
                        </button>
                      </>
                    )}
                  </div>
                )}
                {!readonly && run?.phase !== "SB" && (
                  <div className="kit-palette">
                    <h3>Kit概念部品</h3>
                    {view.material.concepts.map((p) => (
                      <button
                        key={p.id}
                        disabled={concepts.some((c) =>
                          c.provenance.some(
                            (x) => x.sourceConceptId === p.sourceId,
                          ),
                        )}
                        onClick={() =>
                          perform("IMPORT_KIT_CONCEPT", {
                            partId: p.id,
                            x:
                              Math.max(0, ...concepts.map((c) => c.positionX)) +
                              250,
                            y: 150,
                          })
                        }
                      >
                        {p.label} を配置
                      </button>
                    ))}
                  </div>
                )}
                <ConceptCanvas
                  mapId={state.mapId}
                  mapType={state.mapType}
                  allowMergeRelease={state.mapType === "INTEGRATION"}
                  concepts={concepts.map((c) => ({
                    ...c,
                    createdAt: "",
                    updatedAt: "",
                    isMergeResult: c.provenance.some(
                      (p) => p.relationType === "MERGED_FROM",
                    ),
                    isSeed:
                      map.map_kind === "SB" &&
                      c.provenance.some((p) =>
                        view.material.concepts.some(
                          (x) =>
                            view.material.body.seedConceptItemIds.includes(
                              x.id,
                            ) && x.sourceId === p.sourceConceptId,
                        ),
                      ),
                  }))}
                  links={state.links}
                  kitDefinitionName={null}
                  kitConcepts={[]}
                  kitLinks={[]}
                  readOnly={readonly}
                  canEditConceptStructure={map.map_kind !== "KB"}
                  canEditLinkLabel={map.map_kind !== "KB"}
                  positionSaving={busy}
                  positionFeedback={null}
                  onLabelSave={async (id, label) => {
                    await operate("EDIT_CONCEPT", { id, label });
                  }}
                  onConceptDelete={async (id) => {
                    await operate("DELETE_CONCEPT", { id });
                  }}
                  onLinkLabelSave={async (l, label) => {
                    await operate("EDIT_LINK", { id: l.id, label });
                  }}
                  onLinkReconnect={async (l, s, t) => {
                    await operate("RECONNECT_LINK", {
                      id: l.id,
                      sourceId: s,
                      targetId: t,
                    });
                  }}
                  onLinkDelete={async (id) => {
                    await operate("DELETE_LINK", { id });
                  }}
                  onKitConceptDrop={async (partId, p) => {
                    await operate("IMPORT_KIT_CONCEPT", {
                      partId,
                      x: p.positionX,
                      y: p.positionY,
                    });
                  }}
                  onKitLinkCreate={async (_m, partId, s, t) => {
                    await operate("IMPORT_KIT_LINK", {
                      partId,
                      sourceId: s,
                      targetId: t,
                    });
                  }}
                  onDragStart={() => undefined}
                  onPositionSave={async (id, p) => {
                    await operate("MOVE_CONCEPT", {
                      id,
                      x: p.positionX,
                      y: p.positionY,
                    });
                    return p;
                  }}
                  onLinkPositionSave={async (id, p) => {
                    await operate("MOVE_LINK", { id, x: p.x, y: p.y });
                    return true;
                  }}
                />
                {!readonly && (
                  <div className="r05-submit-actions">
                    {run?.phase === "KB" && (
                      <>
                        <button
                          disabled={busy}
                          onClick={() => perform("CHECK")}
                        >
                          一致を確認
                        </button>
                        {feedback && (
                          <p role="status">
                            {feedback.matched ? "一致" : "不一致"}：概念{" "}
                            {feedback.concepts.matched}/
                            {feedback.concepts.total}、関係{" "}
                            {feedback.relations.matched}/
                            {feedback.relations.total}
                          </p>
                        )}
                      </>
                    )}
                    <button
                      disabled={
                        busy ||
                        (run?.phase === "KB" && !feedback?.matched) ||
                        !!label.trim() ||
                        !online
                      }
                      onClick={() => perform("SUBMIT")}
                    >
                      このMapを提出
                    </button>
                  </div>
                )}
                <section
                  className="r05-history-section"
                  aria-labelledby="r05-history-title"
                >
                  <h3 id="r05-history-title">保存済み操作履歴</h3>
                  {(view.data?.history ?? []).filter(
                    (h) => h.test_map_id === map.id,
                  ).length === 0 ? (
                    <p className="r05-history-empty">
                      このMapの保存済み操作履歴はありません。
                    </p>
                  ) : (
                    (view.data?.history ?? [])
                      .filter((h) => h.test_map_id === map.id)
                      .map((h) => (
                        <details key={h.id}>
                          <summary>
                            {operationNames[h.operation.operationType] ??
                              h.operation.operationType}{" "}
                            / {new Date(h.recorded_at).toLocaleString()}
                          </summary>
                          <button
                            onClick={() => setHistoryState(h.operation.before)}
                          >
                            変更前を見る
                          </button>
                          <button
                            onClick={() => setHistoryState(h.operation.after)}
                          >
                            変更後を見る
                          </button>
                        </details>
                      ))
                  )}
                  {historyState && (
                    <button onClick={() => setHistoryState(null)}>
                      現在状態へ戻る
                    </button>
                  )}
                </section>
              </section>
            )}
            {run && (
              <section className="session-card r05-audit-section">
                <h2>活動・提出の処理結果</h2>
                {view.audit?.map((a, i) => (
                  <p key={i}>
                    {operationNames[a.action] ?? a.action} /{" "}
                    {new Date(a.recorded_at).toLocaleString()} /{" "}
                    {a.outcome === "SUCCESS"
                      ? "成功"
                      : a.outcome === "REJECTED"
                        ? "拒否"
                        : "失敗"}{" "}
                    / {a.reason_code}
                  </p>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
