import { useEffect, useState } from "react";
import { apiFetch } from "./auth-client";
import { queueStatus, QueueUpgradeBlockedError } from "./observation-outbox";
type Queue = Awaited<ReturnType<typeof queueStatus>>;
type Report = {
  client_id: string;
  pending: number;
  retrying: number;
  acknowledged: number;
  attempts: number;
  last_response: string;
  capacity_lost: number;
  expired_lost: number;
  rejected_lost: number;
  storage_lost: number;
  received_at: string;
};
type Delivery = {
  clientReported: Report[];
  serverVerified: {
    client_id: string;
    persisted: number;
    sequence_gaps: string;
  }[];
};
export function LearnerDeliveryStatus({ sessionId }: { sessionId: string }) {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; status: Queue | null; upgradeBlocked?: boolean }>();
  useEffect(() => {
    let active = true;
    let request = 0;
    const update = () => {
      const current = ++request;
      void queueStatus(sessionId).then(
        (status) => {
          if (active && request === current) setSnapshot({ sessionId, status });
        },
        (error: unknown) => {
          if (active && request === current) setSnapshot({ sessionId, status: null, upgradeBlocked: error instanceof QueueUpgradeBlockedError });
        },
      );
    };
    update();
    window.addEventListener("stage1-delivery-change", update);
    const timer = window.setInterval(update, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("stage1-delivery-change", update);
    };
  }, [sessionId]);
  if (snapshot?.sessionId !== sessionId) return null;
  const { status } = snapshot;
  if (snapshot.upgradeBlocked)
    return (
      <p role="alert">
        旧版のタブが操作記録の記憶領域を使用しています。両方のタブで操作を止め、未保存の入力と送信中の処理を確認してから旧版のタブを閉じ、この画面を再読み込みしてください。ブラウザーのデータは削除しないでください。
      </p>
    );
  if (!status)
    return (
      <p role="alert">
        操作記録の記憶領域を利用できません。保持済みの件数と保存状態は不明です。操作を止め、ブラウザーのデータを保持して研究者に知らせてください。
      </p>
    );
  if (!status.pending && !status.lost && !status.capacityRefused && !status.storageIssue) return null;
  return (
    <p role="status">
      {status.held ? (
        <>操作記録：先頭1件は旧世代のため送信保留中です。後続 {status.blockedBehindHead}件も順序を守るため送信できません。ブラウザーのデータを保持して研究者に知らせてください。</>
      ) : (
        <>操作記録：送信待ち {status.pending}件（再送待ち {status.retrying}件）。</>
      )}{" "}
      {!status.held && status.pending > 0 && "接続状況を確認し、順に再送します。"}{" "}
      {status.retentionReview && "保管目安の7日を過ぎた未確認記録も保持しています。"}{" "}
      {status.capacityRefused > 0 && <>容量上限のため、新たな操作記録 {status.capacityRefused}件を保持できませんでした。</>}{" "}
      {status.storageRefused > 0 && <>このタブで新たな操作記録 {status.storageRefused}件を保持できませんでした。</>}{" "}
      {status.storageIssue && !status.storageRefused && "操作記録の状態を記憶領域に保存できませんでした。"}{" "}
      {status.lost > 0 && <>復旧できない記録 {status.lost}件があります。</>}{" "}
      {!status.held && (status.capacityRefused > 0 || status.storageIssue || status.lost > 0) &&
        "ブラウザーのデータを保持して研究者に知らせてください。"}{" "}
      回答・マップの保存状態は各画面で確認してください。
    </p>
  );
}
export function ResearchDeliveryStatus({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<Delivery | null>(null),
    [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () => {
      void apiFetch("/api/research/sessions/" + sessionId + "/delivery-status")
        .then(async (r) => {
          if (!r.ok) throw new Error();
          return r.json() as Promise<Delivery>;
        })
        .then((d) => {
          if (active) {
            setData(d);
            setError(false);
          }
        })
        .catch(() => {
          if (active) setError(true);
        });
    };
    load();
    const timer = window.setInterval(load, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);
  const responseNames: Record<string, string> = {
    NONE: "未応答",
    ACK: "保存確認済み",
    NETWORK: "応答未確認",
    RETRYABLE: "再送待ち",
    REJECTED: "受付拒否",
    STORAGE: "記憶領域を読み出せないため件数不明",
    SENDING: "送信・再送中（最終申告時点）",
  };
  return (
    <section className="session-card" aria-label="操作記録の送信状態">
      <h2>操作記録の送信状態</h2>
      <p>
        ブラウザーの申告とサーバーの保存確認を別々に示します。申告は最終受信時点の値です。未報告・切断中・ブラウザーの記憶領域消去による欠損は把握できません。
      </p>
      {error && (
        <p role="alert">送信状態を取得できません。欠損の有無は不明です。</p>
      )}
      {data && !data.clientReported.length && (
        <p>ブラウザーからの状態報告はありません。欠損の有無は不明です。</p>
      )}
      {data?.clientReported.map((r, i) => (
        <div key={r.client_id}>
          <h3>
            ブラウザー {i + 1}（{r.client_id.slice(0, 8)}・申告）
          </h3>
          {r.last_response === "STORAGE" ? (
            <p>
              未送信・ACK済み・過去の欠損件数は不明です。新たに保持できなかった観測は{" "}
              {r.storage_lost}件です。
            </p>
          ) : (
            <>
              <p>
                送信待ち {r.pending}件／再送待ち {r.retrying}件／ACK済み{" "}
                {r.acknowledged}件／送信試行 {r.attempts}回／最終応答：
                {responseNames[r.last_response]}
              </p>
            </>
          )}
          {r.last_response !== "STORAGE" && (
            <p>
              復旧不能の申告：容量超過 {r.capacity_lost}件、期限切れ{" "}
              {r.expired_lost}件、受付拒否 {r.rejected_lost}件、記憶領域障害{" "}
              {r.storage_lost}件。
            </p>
          )}
          <p>受信：{new Date(r.received_at).toLocaleString("ja-JP")}</p>
        </div>
      ))}
      {data?.serverVerified.map((r, i) => (
        <p key={r.client_id}>
          サーバー確認・ストリーム {i + 1}（{r.client_id.slice(0, 8)}）：保存{" "}
          {r.persisted}件、申告順序の欠番 {r.sequence_gaps}件（欠損疑い）。
        </p>
      ))}
      <p>
        操作の成功、イベントの保存、ブラウザーのACKは別の状態です。サーバー処理の履歴は既存の操作詳細・評価履歴・出力で確認してください。
      </p>
    </section>
  );
}
