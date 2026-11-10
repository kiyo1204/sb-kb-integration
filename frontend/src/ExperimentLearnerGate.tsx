import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./auth-client";
export default function ExperimentLearnerGate() {
  const [clientSecret] = useState(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  });
  const [binding, setBinding] = useState<{
      clientId: string;
      ownership: string;
    } | null>(null),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(true);
  const fetchBinding = useCallback(async () => {
    const r = await apiFetch("/api/experiment-client/claim", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Experiment-Client": clientSecret,
      },
      body: "{}",
    });
    const data = await r.json();
    if (
      typeof data?.clientId !== "string" ||
      !(
        (r.status === 200 && data.ownership === "OWNED") ||
        (r.status === 409 &&
          data.ownership === "PENDING" &&
          data.error === "experiment_client_in_use")
      )
    )
      throw new Error();
    return data as { clientId: string; ownership: string };
  }, [clientSecret]);
  const refresh = useCallback(async () => {
    setBusy(true);
    setError(false);
    try {
      setBinding(await fetchBinding());
    } catch {
      setBinding(null);
      setError(true);
    } finally {
      setBusy(false);
    }
  }, [fetchBinding]);
  useEffect(() => {
    let active = true;
    void fetchBinding()
      .then((data) => {
        if (active) setBinding(data);
      })
      .catch(() => {
        if (active) {
          setBinding(null);
          setError(true);
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    const online = () => void refresh();
    window.addEventListener("online", online);
    return () => {
      active = false;
      window.removeEventListener("online", online);
    };
  }, [fetchBinding, refresh]);
  return (
    <main className="page">
      <section className="session-card">
        <p className="eyebrow">新実験フロー / 未公開</p>
        <h1>学習者フローはまだ利用できません</h1>
        <p>
          参加者向けの公開を停止しています。実施の開始待ちとは別の利用制限です。これは研究者の模擬検証用です。授業・動画、マップ編集、提出は開始できません。実参加者へのコード配布・本番実施は行わないでください。
        </p>
        {binding && (
          <>
            <h2>
              {binding.ownership === "OWNED"
                ? "コード確認・端末登録済み"
                : "この画面では利用できません"}
            </h2>
            <p>
              画面識別子：<code>{binding.clientId}</code>
            </p>
            <p>
              {binding.ownership === "OWNED"
                ? "コードの確認と、この画面の端末登録は完了しています。学習操作は公開停止中のため実行できません。"
                : "別の画面が登録されています。この識別子を研究者に伝え、切替を依頼してください。実施の開始を待つだけでは、この画面は利用可能になりません。"}
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="session-error">
            コードまたは接続状態を確認できません。研究者に確認してください。
          </p>
        )}
        <button disabled={busy} onClick={() => void refresh()}>
          接続状態を更新
        </button>
        <p className="description">
          同じ画面の通信復帰では接続情報を維持します。再読み込み・別画面は新しい接続候補になり、研究者の切替が必要です。未同期Map変更を別画面へ自動移送・適用しません。
        </p>
      </section>
    </main>
  );
}
