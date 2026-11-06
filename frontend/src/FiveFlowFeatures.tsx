import { useEffect, useState } from "react";
import { apiFetch, downloadApiFile } from "./auth-client";
type CountState = {
  status: string;
  reason: string | null;
  activeConcepts: number | null;
  hiddenMergeSources: number | null;
  links: number | null;
};
type FeatureData = {
  featureVersion: string;
  protocolKey: string;
  sampledAt: string;
  start: CountState & { capturedAt: string | null };
  completion: CountState & {
    submittedAt: string | null;
    eventId: string | null;
    eventType: string | null;
  };
  delta: CountState;
  operationResults: {
    scope: string;
    total: number;
    rows: {
      historySource: string;
      actorType: string;
      outcome: string;
      count: number;
    }[];
  };
};
const reasons: Record<string, string> = {
  NOT_SUBMITTED: "未提出／算出不可",
  INTEGRATION_MAP_MISSING: "統合マップ記録なし",
  INITIAL_SNAPSHOT_MISSING_OR_INVALID: "開始状態が欠損・不整合",
  SUBMISSION_STATE_UNAVAILABLE: "受理済み完成状態を特定できません",
  HISTORY_INCONSISTENT: "履歴が不整合",
  START_OR_COMPLETION_UNAVAILABLE: "開始または完成状態が算出不可",
};
export function FiveFlowFeatures({ sessionId }: { sessionId: string }) {
  const [value, setValue] = useState<FeatureData | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void apiFetch(
      `/api/research/stage1/sessions/${sessionId}/descriptive-features`,
    )
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => null);
          if (body?.error === "wrong_protocol") return null;
          throw new Error("新5活動の特徴量を取得できませんでした。");
        }
        return (await r.json()) as FeatureData;
      })
      .then((v) => {
        if (active) setValue(v);
      })
      .catch((e) => {
        if (active) setError(String(e.message));
      });
    return () => {
      active = false;
    };
  }, [sessionId]);
  if (!value) return error ? <p role="alert">{error}</p> : null;
  const shown = (v: number | null) => (v === null ? "算出不可" : String(v));
  return (
    <section className="session-card" aria-label="新5活動の記述的特徴量">
      <h2>統合マップの開始・完成状態</h2>
      <p>
        記述的・探索的な値です。困難・理解・学習成果・因果効果を示す指標ではありません。
      </p>
      <p>
        定義版：{value.featureVersion} · プロトコル：{value.protocolKey}
      </p>
      <p>
        開始記録：{value.start.capturedAt ?? "記録なし"} · 受理済み提出時刻：
        {value.completion.submittedAt ?? "未提出"}
      </p>
      <p>
        完成状態の根拠：{value.completion.eventType ?? "記録なし"} · Event ID：
        {value.completion.eventId ?? "記録なし"}
      </p>
      <div style={{ overflowX: "auto" }}>
        <table>
          <caption>
            差分は完成－開始。編集中の状態は完成値に含めません。
          </caption>
          <thead>
            <tr>
              <th>集計時点</th>
              <th>active概念</th>
              <th>非表示Merge元</th>
              <th>リンク</th>
              <th>算出状態</th>
            </tr>
          </thead>
          <tbody>
            {(["start", "completion", "delta"] as const).map((point) => (
              <tr key={point} data-feature-point={point}>
                <th>
                  {
                    {
                      start: "開始",
                      completion: "完成（受理済み提出）",
                      delta: "差分",
                    }[point]
                  }
                </th>
                <td>{shown(value[point].activeConcepts)}</td>
                <td>{shown(value[point].hiddenMergeSources)}</td>
                <td>{shown(value[point].links)}</td>
                <td>
                  {value[point].status === "AVAILABLE"
                    ? "算出済み"
                    : (reasons[value[point].reason ?? ""] ?? "算出不可")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>保存済みMap操作イベント</h3>
      <p>
        取得時点：{value.sampledAt} · 集計範囲：{value.operationResults.scope} ·
        合計{value.operationResults.total}
        件。操作主体・結果・旧ログを区別します。全試行数や未送信操作数ではありません。
      </p>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>記録種別</th>
              <th>主体</th>
              <th>保存された結果</th>
              <th>件数</th>
            </tr>
          </thead>
          <tbody>
            {value.operationResults.rows.map((r) => (
              <tr
                key={JSON.stringify([r.historySource, r.actorType, r.outcome])}
              >
                <td>{r.historySource}</td>
                <td>{r.actorType}</td>
                <td>{r.outcome}</td>
                <td>{r.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        UNKNOWNは結果不明、UNRECORDEDは結果・主体の未記録です。成功へ補完しません。
      </p>
      <button
        type="button"
        onClick={() =>
          void downloadApiFile(
            `/api/research/stage1/sessions/${sessionId}/descriptive-features.csv`,
          ).catch(() => setError("新5活動CSVを取得できませんでした。"))
        }
      >
        新5活動の特徴量CSVを出力
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
