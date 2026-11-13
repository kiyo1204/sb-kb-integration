import { newClientId } from "./client-identity";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { apiFetch, uiText, downloadApiFile } from "./auth-client";
import "./materials.css";
import "./experiment-participants.css";
type Participant = {
  id: string;
  label: string;
  status: string;
  registeredAt: string;
  credentialGeneration: number;
  deviceGeneration: number;
  activeClientId: string | null;
  completedStages: number;
  clients: Array<{ id: string; createdAt: string }>;
};
type View = {
  run: {
    id: string;
    name: string;
    materialTitle: string;
    materialVersion: number;
    catalogVersionId: string;
    plannedParticipants: number;
    registeredSessions: number;
    state: string;
    integrationSeconds: number;
    endedAt?: string | null;
  };
  startAvailable?:boolean;
  participants: Participant[];
};
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch("/api/research/experiment-runs" + path, init).catch(
    () => {
      throw new Error(
        "保存状態を確認できません。同じ内容で再試行し、コードが表示されない場合は参加者行から再発行してください。",
      );
    },
  );
  const d = await r.json().catch(() => null);
  if (!r.ok)
    throw new Error(
      uiText(
        d?.message ??
          "参加者の状態を確認できませんでした。再度更新してください。",
      ),
    );
  return d;
}
function IssuedCode({ code, onClose }: { code: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="participant-code-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="issued-code-title"
    >
      <h2 id="issued-code-title">コードは今回だけ表示します</h2>
      <p>
        新学習者フローは未公開です。研究者の模擬検証用として扱い、実参加者へ配布しないでください。
      </p>
      <code className="issued-participant-code">{code}</code>
      <p>
        閉じると再表示できません。応答を失った場合は同じSessionのコードを明示的に再発行し、旧コードを無効化します。
      </p>
      <button autoFocus onClick={onClose}>
        コード表示を閉じる
      </button>
    </dialog>
  );
}
export default function ExperimentParticipantsPage({
  runId,
}: {
  runId: string;
}) {
  const [view, setView] = useState<View | null>(null),
    [label, setLabel] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [issued, setIssued] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const load = useCallback(async () => {
    const d = await api<View>(`/${runId}/participants`);
    setView(d);
  }, [runId]);
  useEffect(() => {
    let active = true;
    void api<View>(`/${runId}/participants`)
      .then((data) => {
        if (active) setView(data);
      })
      .catch(() => {
        if (active)
          setError("参加者一覧を取得できませんでした。再度更新してください。");
      });
    return () => {
      active = false;
    };
  }, [runId]);
  async function perform(path: string, body: unknown, register = false) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const signature = JSON.stringify([path, body]);
    try {
      let key = keys.current.get(signature);
      if (!key) {
        key = newClientId();
        keys.current.set(signature, key);
      }
      const r = await api<{ issuedCode: string | null; codeDelivery: string }>(
        path,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(body),
        },
      );
      // A resolved form submission is a new intent if entered again. Preserve
      // the key only across uncertain/lost responses, not forever by label.
      keys.current.delete(signature);
      if (register) setLabel("");
      if (r.issuedCode) setIssued(r.issuedCode);
      setNotice(
        r.codeDelivery === "NOT_REPLAYED"
          ? "受付済みの操作です。Sessionやコードは重複作成していません。コードは再表示しないため、必要なら参加者行から明示的に再発行してください。"
          : "管理操作を保存しました。学習者フローは引き続き未公開です。",
      );
      await load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "保存状態を確認できませんでした。",
      );
    } finally {
      setBusy(false);
    }
  }
  function register(e: FormEvent) {
    e.preventDefault();
    if (label.trim())
      void perform(
        `/${runId}/participants`,
        { participantLabel: label.trim() },
        true,
      );
  }
  async function refresh() {
    setError(null);
    try {
      await load();
    } catch {
      setError("一覧を更新できません。表示は前回取得時の内容です。");
    }
  }
  const r = view?.run,
    participants = view?.participants ?? [];
  return (
    <main className="materials-page">
      <header className="materials-header">
        <h1>実施管理 / 実施詳細</h1>
        <span>研究者画面 / R08</span>
      </header>
      <div className="materials-content">
        {error && (
          <p role="alert" className="session-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="participant-notice">
            {notice}
          </p>
        )}
        {!r && !error && <p role="status">実施と参加者を読み込んでいます…</p>}
        {r && (
          <>
            <section className="material-summary">
              <div>
                <h2>{r.name}</h2>
                <p>
                  使用教材：
                  <a href={`/research/materials/${r.catalogVersionId}`}>
                    {r.materialTitle} v{r.materialVersion}
                  </a>{" "}
                  / 状態：{r.state==="ENDED" ? "終了" : r.state==="RUNNING" ? "実施中（模擬）" : "準備中"} / 統合制限時間：{r.integrationSeconds}秒
                </p>
              </div>
              <div className="material-actions">
                <button disabled={busy} onClick={() => void refresh()}>
                  状態を更新
                </button>
                <button disabled={busy || r.state!=="RUNNING"} onClick={()=>{if(window.confirm("実施を終了します。活動中の参加者は停止し、未提出マップは未提出のまま保持します。終了後の変更・提出・操作記録は拒否し、参加者は保存済みマップも閲覧できません。研究者の閲覧・出力は残ります。終了しますか？"))void perform(`/${runId}/end`,{confirmed:true});}}>実施を終了</button>
                <button disabled={!view?.startAvailable || busy || participants.length===0 || r.state!=="PREPARING"} aria-describedby="experiment-start-gate" onClick={()=>void perform(`/${runId}/start`,{})}>
                  {view?.startAvailable ? "実施開始（模擬検証専用）" : "実施開始（未公開）"}
                </button>
              </div>
            </section>
            {r.endedAt && <p>終了日時：{new Date(r.endedAt).toLocaleString("ja-JP")}。参加者の完了・離脱・撤回記録は変更していません。</p>}
            <p id="experiment-start-gate" className="participant-flow-gate">
              新しい学習者フローが未公開のため、コードは研究者の模擬検証用です。実参加者への配布・本番利用・開始はできません。
              {participants.length === 0
                ? "開始には参加者Sessionが1人以上必要ですが、登録後もフロー公開までは開始できません。"
                : "人数条件を満たしていても、フロー公開までは開始できません。"}
            </p>
            <div className="participant-summary-grid">
              {[
                ["参加予定", r.plannedParticipants],
                ["登録Session", participants.length],
                [
                  r.state === "ENDED" ? "終了時に未開始" : "未開始",
                  participants.filter((p) => p.status === "NOT_STARTED").length,
                ],
                [
                  r.state === "ENDED" ? "終了時に進行中" : "進行中",
                  participants.filter((p) => p.status === "IN_PROGRESS").length,
                ],
                [
                  "完了",
                  participants.filter((p) => p.status === "COMPLETED").length,
                ],
              ].map(([name, value]) => (
                <section className="material-panel participant-stat" key={name}>
                  <span>{name}</span>
                  <strong>{value}</strong>
                </section>
              ))}
            </div>
            <section className="material-panel material-series">
              <h2>参加者Session一覧</h2>
              <p role="group" aria-label="研究用出力"><button type="button" onClick={()=>void downloadApiFile(`/api/research/experiment-runs/${runId}/research.json`).catch(e=>setError(e instanceof Error?e.message:"研究用JSONを取得できませんでした。対象を確認して再試行してください。"))}>実施の研究用JSON</button>
              <button type="button" onClick={()=>void downloadApiFile(`/api/research/experiment-runs/${runId}/research.csv`).catch(e=>setError(e instanceof Error?e.message:"研究用CSVを取得できませんでした。対象を確認して再試行してください。"))}>実施のMap状態CSV</button></p>
              <form className="participant-register" onSubmit={register}>
                <label htmlFor="participant-label">
                  参加者ラベル（仮名）
                  <input
                    id="participant-label"
                    maxLength={64}
                    required
                    disabled={busy}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </label>
                <button
                  className="session-primary-button"
                  disabled={busy || r.state === "ENDED" || !label.trim()}
                >
                  ＋ 参加者Session・検証用コードを追加
                </button>
              </form>
              <p className="material-muted">
                予定人数は登録上限ではありません。コード平文は一覧に保存・再表示しません。学習者のライブMapは表示しません。
              </p>
              {participants.length === 0 ? (
                <p>参加者Sessionはまだありません。</p>
              ) : (
                <div className="material-table-scroll">
                  <table className="participants-table">
                    <thead>
                      <tr>
                        <th>参加者</th>
                        <th>現在の活動</th>
                        <th>状態</th>
                        <th>作業時間</th>
                        <th>最終操作</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {participants.map((p) => (
                        <ParticipantRow
                          key={p.id}
                          p={p}
                          runId={runId}
                          busy={busy}
                          ended={r.state === "ENDED"}
                          perform={perform}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
        <p className="material-footer">
          <a href="/research/experiment-runs">実施一覧へ戻る</a>
        </p>
      </div>
      {issued && <IssuedCode code={issued} onClose={() => setIssued(null)} />}
    </main>
  );
}
function ParticipantRow({
  p,
  runId,
  busy,
  ended,
  perform,
}: {
  p: Participant;
  runId: string;
  busy: boolean;
  ended: boolean;
  perform: (path: string, body: unknown) => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const candidates = p.clients.filter((c) => c.id !== p.activeClientId);
  return (
    <tr>
      <td>{p.label}<br/><a href={`/research/stage1/${p.id}/analysis`}>保存Map・履歴・研究用出力</a></td>
      <td>
        {p.completedStages}/4活動完了
        <br />
        <small>学習フロー未公開</small>
      </td>
      <td>
        {ended && p.status!=="COMPLETED" ? `終了により停止（終了時：${p.status==="IN_PROGRESS" ? "進行中" : "未開始"}）` : p.status === "NOT_STARTED"
          ? "未開始"
          : p.status === "IN_PROGRESS"
            ? "進行中"
            : p.status === "COMPLETED"
              ? "完了"
              : p.status}
      </td>
      <td>未計測</td>
      <td>記録なし</td>
      <td>
        <details>
          <summary>コード・画面管理</summary>
          <p>
            {p.credentialGeneration
              ? `コード発行済み（世代 ${p.credentialGeneration}）`
              : "コード未発行"}
          </p>
          <button
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  p.credentialGeneration
                    ? "同じSessionのコードを再発行します。旧コードを無効化し、利用画面の登録も解除します。Map・Stage・履歴は作り直しません。続行しますか？"
                    : "研究者の模擬検証用コードを発行します。実参加者へ配布できません。続行しますか？",
                )
              )
                void perform(
                  `/${runId}/participants/${p.id}/code${p.credentialGeneration ? "/reissue" : ""}`,
                  { expectedCredentialGeneration: p.credentialGeneration },
                );
            }}
          >
            {p.credentialGeneration ? "コード再発行" : "コード発行"}
          </button>
          <p>利用画面：{p.activeClientId ?? "未登録"}</p>
          <label>
            切替先の画面識別子
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={busy || !candidates.length}
            >
              <option value="">選択してください</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={busy || !candidates.some((c) => c.id === target)}
            onClick={() => {
              if (
                window.confirm(
                  "選択した画面へ切り替えます。旧画面の更新・提出・再送を受け付けません。未同期Map変更は移送・適用しません。続行しますか？",
                )
              )
                void perform(`/${runId}/participants/${p.id}/client-switch`, {
                  clientId: target,
                  expectedDeviceGeneration: p.deviceGeneration,
                });
            }}
          >
            利用画面を切替
          </button>
          <p className="material-muted">
            別画面は候補として登録され、研究者が明示的に切り替えます。画面世代：
            {p.deviceGeneration}
          </p>
        </details>
      </td>
    </tr>
  );
}
