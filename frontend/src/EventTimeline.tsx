import { useEffect, useState } from "react";
import { apiFetch } from "./auth-client";
import { ResearchDeliveryStatus } from "./DeliveryStatus";
type Event = {
  event_id: string;
  server_timestamp: string;
  client_timestamp: string | null;
  session_id: string | null;
  learner_id: string | null;
  study_group: string | null;
  activity: string | null;
  event_type: string;
  actor_type: string;
  outcome: string;
  payload_status: string;
  boundary_status: string;
  before_quality: string;
  after_quality: string;
  reason_code: string | null;
  target_id: string | null;
  related_event_id: string | null;
  [key: string]: unknown;
};
const outcomes: Record<string, string> = {
  SUCCESS: "成功",
  FAILURE: "失敗",
  REJECTED: "拒否",
  CANCELLED: "取消",
  UNKNOWN: "不明",
};
const actors: Record<string, string> = {
  LEARNER: "学習者",
  RESEARCHER: "研究者",
  SYSTEM: "システム",
  UNKNOWN: "不明",
};
export default function EventTimeline({
  exportId,
  eventNames,
  activityNames,
  groupNames,
}: {
  exportId: string;
  eventNames: Record<string, string>;
  activityNames: Record<string, string>;
  groupNames: Record<string, string>;
}) {
  const [rows, setRows] = useState<Event[]>([]),
    [offset, setOffset] = useState(0),
    [next, setNext] = useState<number | null>(null),
    [selected, setSelected] = useState<Event | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true);
  useEffect(() => {
    let active = true;
    apiFetch(`/api/research/event-views/${exportId}?offset=${offset}`)
      .then(async (r) => {
        if (!r.ok) throw new Error();
        return r.json() as Promise<{ events: Event[]; next: number | null }>;
      })
      .then((p) => {
        if (active) {
          setRows(p.events);
          setNext(p.next);
        }
      })
      .catch(() => {
        if (active) {
          setRows([]);
          setError(
            "一覧を取得できません。有効期限（15分）を過ぎた場合は再検索してください。",
          );
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [exportId, offset]);
  async function select(index: number) {
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch(
        `/api/research/event-views/${exportId}?offset=${offset + index}&detail=1`,
      );
      if (!r.ok) throw new Error();
      const p = (await r.json()) as { events: Event[] };
      setSelected(p.events[0] ?? null);
    } catch {
      setError("詳細を取得できません。再検索してください。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="session-card"
      aria-label="時系列イベント一覧"
      aria-busy={busy}
    >
      <h2>時系列イベント一覧</h2>
      <p>
        サーバー保存時刻の昇順（UTC）。同時刻はイベントID順です。旧・新の再生順とは異なります。検索時点の結果を固定し、下のJSON／CSVも同じ集合を出力します。
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="event-export-table">
        <table className="event-timeline-table">
          <thead>
            <tr>
              {[
                "時刻（UTC）",
                "セッション／仮名ID",
                "群",
                "活動",
                "操作",
                "主体",
                "結果",
                "注意",
                "詳細",
              ].map((x) => (
                <th key={x} scope="col">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => (
              <tr key={e.event_id}>
                <td>{e.server_timestamp}</td>
                <td>
                  {e.session_id ?? "未所属"}
                  <br />
                  {e.learner_id ?? "—"}
                </td>
                <td>
                  {groupNames[e.study_group ?? "UNASSIGNED"] ?? e.study_group}
                </td>
                <td>
                  {activityNames[e.activity ?? "UNASSIGNED"] ?? e.activity}
                </td>
                <td>{eventNames[e.event_type] ?? e.event_type}</td>
                <td>{actors[e.actor_type] ?? e.actor_type}</td>
                <td>{e.event_type==="FEEDBACK_CHECK"&&e.schema_version===6&&e.outcome==="SUCCESS" ? (e.feedback_match===false?"不一致（確認完了）":e.feedback_match===true?"一致（確認完了）":"確認完了・一致結果不明") : e.event_type==="FEEDBACK_CHECK"&&e.schema_version===1&&e.outcome==="REJECTED"?"不一致（旧形式・確認完了）":outcomes[e.outcome] ?? e.outcome}</td>
                <td>
                  {!["EXPORTED", "NO_PAYLOAD"].includes(e.payload_status)
                    ? "本文の非表示・上限等あり "
                    : ""}
                  {["INVALID_AFTER_BOUNDARY", "MISSING_BOUNDARY"].includes(
                    e.boundary_status,
                  )
                    ? "履歴境界要確認 "
                    : ""}
                  {e.before_quality !== "OBSERVED" ||
                  e.after_quality !== "OBSERVED"
                    ? "状態の品質を詳細で確認"
                    : "—"}
                </td>
                <td>
                  <button disabled={busy} onClick={() => void select(i)}>
                    詳細 {offset + i + 1}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && !busy && <p>一致するイベントはありません。</p>}
      <p>
        <button
          disabled={busy || offset === 0}
          onClick={() => {
            setBusy(true);
            setError("");
            setSelected(null);
            setOffset(Math.max(0, offset - 25));
          }}
        >
          前の25件
        </button>{" "}
        {offset + 1}件目から{" "}
        <button
          disabled={busy || next === null}
          onClick={() => {
            if (next !== null) {
              setBusy(true);
              setError("");
              setSelected(null);
              setOffset(next);
            }
          }}
        >
          次の25件
        </button>
      </p>
      {selected && (
        <section aria-label="イベント詳細">
          <h3>イベント詳細</h3>
          <button onClick={() => setSelected(null)}>詳細を閉じる</button>
          <dl>
            {[
              "event_id",
              "reason_code",
              "target_id",
              "related_event_id",
              "related_legacy_operation_log_id",
              "server_timestamp",
              "client_timestamp",
              "client_time_quality",
              "before_quality",
              "after_quality",
              "payload_status",
              "boundary_status",
            ].map((k) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>
                  {String(selected[k] ?? "未保存・該当なし（推定しません）")}
                </dd>
              </div>
            ))}
          </dl>
          <p>
            クライアント時刻は申告値です。UNKNOWN・MISSINGは未確定／欠測、NOT_APPLICABLEは該当なし、ESTIMATEDは推定値です。取消・拒否・失敗はoutcomeに従い、成功と扱いません。本文の非表示は欠損の確定ではありません。
          </p>
          {["before", "after", "details"].map((k) => (
            <details key={k}>
              <summary>{k}（保存状態・詳細）</summary>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  maxHeight: "30rem",
                  overflow: "auto",
                }}
              >
                {selected[k] == null
                  ? "未保存・該当なし"
                  : JSON.stringify(selected[k], null, 2)}
              </pre>
            </details>
          ))}
          {selected.related_event_id && (
            <p>
              関連イベントIDは上記のとおりです。絞り込み対象外の関連イベントは、この結果には含まれない場合があります。
            </p>
          )}
          {selected.session_id && (
            <ResearchDeliveryStatus
              key={selected.session_id}
              sessionId={selected.session_id}
            />
          )}
          <p>
            通信状態はセッション全体の最新の申告・保存記録です。このイベントの保存時点や個別イベントの欠損を確定するものではありません。報告なしから欠損なしとは判断できません。
          </p>
        </section>
      )}
    </section>
  );
}
