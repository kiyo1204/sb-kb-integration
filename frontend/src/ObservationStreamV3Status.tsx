import { useEffect, useState, useSyncExternalStore } from "react";
import {
  captureObservationContext,
  getObservationRevision,
  isObservationContextCurrent,
  subscribeObservationContext,
} from "./auth-client";
import {
  observationStreamSummary,
  openObservationStreamV3,
} from "./observation-stream-v3";

type Reader = Awaited<ReturnType<typeof openObservationStreamV3>>;
type Summary = ReturnType<typeof observationStreamSummary>;
const states = {
  pending: "送信待ち",
  retry: "再送待ち",
  authorization: "認証確認待ち",
  stale: "画面切替により保留",
  ended: "実施終了により保留",
  rejected: "受付拒否により保留",
  sending: "送信中",
};

// Mounted only in the explicitly enabled verification surface.
export function ObservationStreamV3Status({
  sessionId,
  reader,
  operationLogFailed,
}: {
  sessionId: string;
  reader: Pick<Reader, "readSession">;
  operationLogFailed: boolean;
}) {
  const revision = useSyncExternalStore(
    subscribeObservationContext,
    getObservationRevision,
  );
  const [snapshot, setSnapshot] = useState<{
    sessionId: string;
    revision: number;
    summary: Summary | null;
  }>();
  useEffect(() => {
    const context = captureObservationContext(sessionId, true, revision);
    let active = true;
    let request = 0;
    const update = () => {
      const id = ++request;
      const publish = (summary: Summary | null) => {
        if (active && id === request && isObservationContextCurrent(context))
          setSnapshot({ sessionId, revision, summary });
      };
      void reader.readSession(sessionId).then(
        (row) => publish(observationStreamSummary(row, context)),
        () => publish(null),
      );
    };
    update();
    window.addEventListener("stage1-v3-delivery-change", update);
    const timer = window.setInterval(update, 1000);
    return () => {
      active = false;
      window.removeEventListener("stage1-v3-delivery-change", update);
      window.clearInterval(timer);
    };
  }, [reader, sessionId, revision]);

  const visible =
    snapshot?.sessionId === sessionId && snapshot.revision === revision
      ? snapshot.summary
      : undefined;
  return (
    <section aria-label="操作記録の送信状態">
      {visible === null && (
        <p role="alert">操作記録を読み取れず、保持件数は不明です。</p>
      )}
      {visible && (
        <div role="status">
          <p>旧記録の保留 {visible.held}件</p>
          {visible.current ? (
            <p>
              この画面の未確認 {visible.current.pending}件、受付確認済み{" "}
              {visible.current.acknowledged}件。
              {visible.current.pending > 0 && states[visible.current.state]}
            </p>
          ) : (
            <p>現在の画面の送信記録なし</p>
          )}
        </div>
      )}
      {operationLogFailed && (
        <p role="alert">
          別の操作の記録を保存できませんでした。操作の保存状態を確認してください。
        </p>
      )}
    </section>
  );
}
