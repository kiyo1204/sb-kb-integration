import { useEffect, useState, type FormEvent } from "react";
import { apiFetch, uiText } from "./auth-client";

type Kit = { id: string; name: string };

export default function Stage1NewSessionPage() {
  const [minutes, setMinutes] = useState<number | null>(null);
  const [durationInput, setDurationInput] = useState("");
  const [studyGroup, setStudyGroup] = useState("");
  const [kits, setKits] = useState<Kit[]>([]);
  const [kitId, setKitId] = useState("");
  const [participantCode, setParticipantCode] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{id:string; learnerAccessToken:string}|null>(null);

  useEffect(() => {
    let active = true;
    apiFetch("/api/research/stage1/settings").then(async res => { if (!res.ok) throw new Error(); return res.json() as Promise<{minutes:number|null}>; }).then(data => { if (active) { setMinutes(data.minutes); setDurationInput(data.minutes === null ? "" : String(data.minutes)); } }).catch(() => { if (active) setError("共通時間を取得できませんでした。"); });
    apiFetch("/api/kits")
      .then(async (res) => {
        if (!res.ok) throw new Error("Kit一覧を取得できませんでした。");
        return (await res.json()) as { kits: Kit[] };
      })
      .then(({ kits: options }) => {
        if (!active) return;
        setKits(options);
        setKitId(options[0]?.id ?? "");
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Kit取得に失敗しました。");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !kitId || !participantCode.trim() || !videoUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/api/research/stage1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participantCode: participantCode.trim(),
          videoUrl: videoUrl.trim(),
          kitDefinitionId: kitId,
          studyGroup,
        }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = result && typeof result === "object" && "message" in result &&
          typeof result.message === "string" ? uiText(result.message) : "セッションを作成できません。";
        throw new Error(message);
      }
      setCreated(result as {id:string;learnerAccessToken:string});
    } catch (err) {
      setError(err instanceof Error ? err.message : "セッションの作成に失敗しました。");
      setBusy(false);
    }
  }

  async function saveSettings() {
    const value = Number(durationInput);
    if (!Number.isInteger(value) || value <= 0) { setError("正の整数の分数を入力してください。"); return; }
    setBusy(true); setError(null);
    try {
      const response = await apiFetch("/api/research/stage1/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes: value }) });
      if (!response.ok) throw new Error("共通時間を保存できませんでした。");
      setMinutes(value);
    } catch (err) { setError(err instanceof Error ? err.message : "設定を保存できませんでした。"); }
    finally { setBusy(false); }
  }

  return (
    <main className="page session-page stage1-session-create-page">
      <section className="session-card">
        <p className="eyebrow">研究 活動 1 / 開発用</p>
        <h1>学習セッションの作成</h1>
        <p className="description">
          動画 → Scratch-Build → Kit-Build → 事前評価 → 群別活動 → 事後評価。セッション作成後、開始前に評価問題を登録してください。
        </p>
        <p>実名やメールアドレスは入力しないでください。作成後の学習者用コードは一度だけ表示されます。</p>
        <div className="stage1-form stage1-settings">
          <label htmlFor="duration">群別活動の共通時間（分）
            <input id="duration" type="number" min="1" step="1" value={durationInput} onChange={event => setDurationInput(event.target.value)} />
          </label>
          <button type="button" disabled={busy} onClick={() => void saveSettings()}>共通時間を保存</button>
          <p>{minutes === null ? "共通時間は未設定です。セッション作成前に設定してください。" : `現在の設定: ${minutes}分。作成済みセッションの時間は変わりません。`}</p>
        </div>
        {created && <div className="stage1-verification-note stage1-session-created">
          <p>セッションを作成しました。学習者用コードを安全な方法で本人に渡してください。</p>
          <code>{created.learnerAccessToken}</code>
          <p><a href={`/sessions/${created.id}`}>研究者としてセッションを開く</a></p>
        </div>}
        {loading ? <p role="status">Kitを読み込んでいます…</p> : (
          kits.length === 0 ? <p role="status">
            使用できるKitがありません。先に<a href="/research/goal-maps">ゴールマップを作成してKitとして登録</a>してください。
          </p> :
          <form className="stage1-form" onSubmit={(event) => void submit(event)}>
            <label htmlFor="stage1-code">
              参加者コード（仮名）
              <input id="stage1-code" value={participantCode}
                onChange={(event) => setParticipantCode(event.target.value)}
                maxLength={64} placeholder="P001" required />
            </label>
            <label htmlFor="stage1-video">
              授業動画のURL / ファイル公開パス
              <input id="stage1-video" value={videoUrl}
                onChange={(event) => setVideoUrl(event.target.value)}
                placeholder="https://example.edu/video.mp4" required />
            </label>
            <label htmlFor="stage1-kit">
              使用するKit
              <select id="stage1-kit" value={kitId}
                onChange={(event) => setKitId(event.target.value)} required>
                {kits.map((kit) => <option key={kit.id} value={kit.id}>{kit.name}</option>)}
              </select>
            </label>
            <label htmlFor="group">群
              <select id="group" required value={studyGroup} onChange={event => setStudyGroup(event.target.value)}>
                <option value="">選択してください</option><option value="EXPERIMENTAL">実験群</option><option value="CONTROL">統制群</option>
              </select>
            </label>
            <button type="submit" className="session-primary-button"
              disabled={busy || kits.length === 0 || minutes === null || !studyGroup}>
              {busy ? "作成中…" : "活動 1 セッションを作成"}
            </button>
          </form>
        )}
        {error && <p className="session-error" role="alert">{error}</p>}
        <a className="back-link" href="/">トップへ戻る</a>
      </section>
    </main>
  );
}
