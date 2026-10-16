import { useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "./auth-client";

type Kit = { id: string; name: string };

export default function Stage1NewSessionPage() {
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
        }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = result && typeof result === "object" && "message" in result &&
          typeof result.message === "string" ? result.message : "Sessionを作成できません。";
        throw new Error(message);
      }
      setCreated(result as {id:string;learnerAccessToken:string});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sessionの作成に失敗しました。");
      setBusy(false);
    }
  }

  return (
    <main className="page session-page">
      <section className="session-card">
        <p className="eyebrow">研究 Stage 1 / 開発用</p>
        <h1>5ステップ研究プロトタイプ</h1>
        <p className="description">
          動画 → Scratch-Build → Kit-Build → 統合 → 研究者分析。
          最後の分析は学習者の作業終了後に行います。
        </p>
        <p>実名やメールアドレスは入力しないでください。作成後の学習者用コードは一度だけ表示されます。</p>
        {created && <div className="stage1-verification-note">
          <p>Sessionを作成しました。学習者用コードを安全な方法で本人に渡してください。</p>
          <code>{created.learnerAccessToken}</code>
          <p><a href={`/sessions/${created.id}`}>研究者としてSessionを開く</a></p>
        </div>}
        {loading ? <p role="status">Kitを読み込んでいます…</p> : (
          kits.length === 0 ? <p role="status">
            使用できるKitがありません。先に<a href="/research/goal-maps">Goal Mapを作成してKitとして登録</a>してください。
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
            <button type="submit" className="session-primary-button"
              disabled={busy || kits.length === 0}>
              {busy ? "作成中…" : "Stage 1 Sessionを作成"}
            </button>
          </form>
        )}
        {error && <p className="session-error" role="alert">{error}</p>}
        <a className="back-link" href="/">トップへ戻る</a>
      </section>
    </main>
  );
}
