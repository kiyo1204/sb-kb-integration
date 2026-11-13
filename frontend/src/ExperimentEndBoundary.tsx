import { useEffect, useState, type ReactNode } from "react";
import { apiFetch, getAuthenticationRevision } from "./auth-client";
export default function ExperimentEndBoundary({
  children,
  initialEnded = false,
}: {
  children: ReactNode;
  initialEnded?: boolean;
}) {
  const [ended, setEnded] = useState(initialEnded);
  useEffect(() => {
    let active = true;
    const revision = getAuthenticationRevision();
    const stop = () => {
      if (active && revision === getAuthenticationRevision()) setEnded(true);
    };
    const onEnded = (event: Event) => {
      if (
        (event as CustomEvent<{ authenticationRevision: number }>).detail
          ?.authenticationRevision === revision
      )
        stop();
    };
    const check = async () => {
      try {
        const r = await apiFetch("/api/experiment-status");
        if (r.ok && (await r.json()).state === "ENDED") stop();
      } catch {
        /* Offline cannot establish server state; no false ACK. */
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 2000);
    window.addEventListener("experiment-ended", onEnded);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("experiment-ended", onEnded);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
    };
  }, []);
  return ended ? (
    <main className="page">
      <section className="session-card">
        <h1>実施は終了しました</h1>
        <p>
          研究者が実施を終了しました。学習操作と保存済みマップの閲覧は利用できません。研究者の指示を待ってください。
        </p>
        <p>
          未送信データを送信済みとして扱ったり、自動削除したりはしていません。
        </p>
      </section>
    </main>
  ) : (
    children
  );
}
