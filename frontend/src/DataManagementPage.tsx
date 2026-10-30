import {discardAssessmentDrafts,quarantinedDraftCount} from "./assessment-drafts";
import {requestDigest} from "./client-identity";
import { useEffect, useState } from "react";
import { apiFetch } from "./auth-client";
type Data = {
  studies: {
    id: string;
    retain_until: string | null;
    retention_state: string;
  }[];
  sessions: { session_id: string; pseudonym: string; study_id: string }[];
  deletions: {
    id: string;
    deleted_at: string;
    session_count: number;
    pending_devices: number;
  }[];
};
type Preview = {
  planId: string;
  counts: Record<string, number>;
  sessionIds: string[];
  warning: string;
};
export default function DataManagementPage() {
  const [legacyCount]=useState(()=>{try{return quarantinedDraftCount();}catch{return null;}});
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<Preview | null>(null),
    [confirm, setConfirm] = useState(""),
    [reissue, setReissue] = useState<string | null>(null);
  async function load() {
    const r = await apiFetch("/api/research/data-management");
    if (!r.ok) throw new Error();
    setData(await r.json());
  }
  useEffect(() => {
    void apiFetch("/api/research/data-management")
      .then(async (r) => {
        if (!r.ok) throw new Error();
        return r.json() as Promise<Data>;
      })
      .then(setData)
      .catch(() => setError("管理情報を取得できません。"));
  }, []);
  async function action(path: string, body: unknown, method = "POST") {
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch("/api/research/data-management" + path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const x = await r.json();
      if (!r.ok)
        throw new Error(
          x.message ??
            "操作を確定できませんでした。対象と状態を再確認してください。",
        );
      if (path === "/preview") {
        setPreview(x);
        setConfirm("");
      } else {
        let localDraftCleanupConfirmed=true;
        if(path==="/delete"&&preview)for(const id of preview.sessionIds){try{discardAssessmentDrafts(requestDigest(id));}catch{localDraftCleanupConfirmed=false;}}
        if(!localDraftCleanupConfirmed)setError("DBの削除は完了しましたが、このブラウザーの下書き消去は確認できません。端末の保存データを確認してください。");
        setPreview(null);
        setReissue(null);
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作できませんでした。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="page">
      <section className="session-card">
        <h1>研究データ管理</h1>
        <p>
          開発・模擬データ専用です。本番の研究参加者データを安全に扱えることを保証する構成ではありません。
        </p>
        <a href="/">研究者トップへ</a>
        {error && <p role="alert">{error}</p>}
      </section>
      <section className="session-card">
        <h2>研究ごとの保存期限</h2>
        <p>
          期限を過ぎても自動削除しません。研究は管理用UUIDで区別します。新しい研究に移す操作は、同じ仮名IDの全セッションへ適用されます。
        </p>
        <button disabled={busy} onClick={() => void action("/studies", {})}>
          研究を追加
        </button>
        {data?.studies.map((s) => (
          <form
            key={s.id}
            onSubmit={(e) => {
              e.preventDefault();
              const v = new FormData(e.currentTarget).get("date") as string;
              void action(
                "/studies/" + s.id,
                { retainUntil: v ? v + "T23:59:59+09:00" : null },
                "PATCH",
              );
            }}
          >
            <h3>{s.id}</h3>
            <p>
              {
                (
                  {
                    UNSET: "未設定",
                    EXPIRED: "期限超過",
                    DUE_SOON: "30日以内",
                    SET: "設定済み",
                  } as Record<string, string>
                )[s.retention_state]
              }{" "}
              / {s.retain_until ?? "期限なし"}
            </p>
            <label>
              期限日（日本時間）
              <input
                key={s.retain_until}
                name="date"
                type="date"
                defaultValue={
                  s.retain_until
                    ? new Date(new Date(s.retain_until).getTime() + 9 * 3600000)
                        .toISOString()
                        .slice(0, 10)
                    : ""
                }
              />
            </label>
            <button disabled={busy}>期限を保存（空欄は未設定）</button>
          </form>
        ))}
      </section>
      <section className="session-card">
        <h2>仮名IDと削除対象</h2>
        <p>
          自動発行はセッションごとです。同じ人と確認した場合だけ「同じ仮名IDに関連付け」を使ってください。内部参加者ID・対応表は表示しません。再発行は同じ人の全セッションの表示IDを変更し、保存済み回答・イベントは書き換えません。
        </p>
        {data?.sessions.map((s) => (
          <section key={s.session_id}>
            <h3>{s.pseudonym}</h3>
            <p>セッション：{s.session_id}</p>
            <label>
              研究
              <select
                value={s.study_id}
                disabled={busy}
                onChange={(e) =>
                  void action("/assign", {
                    sessionId: s.session_id,
                    studyId: e.target.value,
                  })
                }
              >
                {data.studies.map((x) => (
                  <option key={x.id}>{x.id}</option>
                ))}
              </select>
            </label>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action("/assign", {
                  sessionId: s.session_id,
                  pseudonym: new FormData(e.currentTarget).get("pseudonym"),
                });
              }}
            >
              <label>
                同じ仮名IDに関連付け
                <select name="pseudonym" defaultValue={s.pseudonym}>
                  {[...new Set(data.sessions.map((x) => x.pseudonym))].map(
                    (x) => (
                      <option key={x}>{x}</option>
                    ),
                  )}
                </select>
              </label>
              <button disabled={busy}>関連付ける</button>
            </form>
            <button disabled={busy} onClick={() => setReissue(s.session_id)}>
              仮名IDを再発行…
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action("/preview", { sessionId: s.session_id })
              }
            >
              このセッションの削除範囲を確認
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action("/preview", { pseudonym: s.pseudonym })
              }
            >
              この仮名IDの全セッションの削除範囲を確認
            </button>
          </section>
        ))}
      </section>
      {reissue && (
        <section
          className="session-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reissue-heading"
        >
          <h2 id="reissue-heading">仮名IDの再発行</h2>
          <p>
            同じ人に関連付けた全セッションの表示IDが変わります。過去に取得したファイルは更新できません。
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void action("/assign", { sessionId: reissue, reissue: true })
            }
          >
            再発行する
          </button>
          <button disabled={busy} onClick={() => setReissue(null)}>
            戻る
          </button>
        </section>
      )}
      {preview && (
        <section
          className="session-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="deletion-heading"
        >
          <h2 id="deletion-heading">削除の最終確認</h2>
          <p>{preview.warning}</p>
          <p>対象セッション：{preview.sessionIds.join(", ")}</p>
          <dl>
            {Object.entries(preview.counts).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}件</dd>
              </div>
            ))}
          </dl>
          <p>
            元に戻せません。確認後に変更された場合は拒否します。一時出力だけが先に消去され、DB削除が中止される場合は再出力してください。
          </p>
          <label>
            削除する場合は DELETE と入力
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <button
            disabled={busy || confirm !== "DELETE"}
            onClick={() =>
              void action("/delete", { planId: preview.planId, confirm })
            }
          >
            {busy ? "処理中…" : "確認した対象を削除する"}
          </button>
          <button disabled={busy} onClick={() => setPreview(null)}>
            戻る
          </button>
        </section>
      )}
      <section className="session-card" aria-label="所有者不明の旧下書き">
        <h2>所有者不明の旧評価下書き</h2>
        <p>このブラウザーの隔離対象：{legacyCount===null?"取得できません":`${legacyCount}件`}。回答本文や活動IDは表示しません。</p>
        <p>所属を安全に特定できないため、復元・紐付け・削除を保留しています。他の端末や接続先の保存件数は分かりません。端末管理者が本人・使用端末・接続先を別の記録で確認できるまで保存データを保持してください。</p>
      </section>
      <section className="session-card">
        <h2>削除後の端末確認</h2>
        <p>
          既知端末の確認待ちが0でも、未知の端末・バックアップ・ダウンロード済みファイルまで消去された証明ではありません。定期的に再読み込みして確認してください。
        </p>
        <button
          disabled={busy}
          onClick={() =>
            void load().catch(() => setError("読み込みできません。"))
          }
        >
          再読み込み
        </button>
        {data?.deletions.map((d) => (
          <p key={d.id}>
            {d.deleted_at}：{d.session_count}
            セッション削除。端末側の削除確認待ち（不明を含む）
            {d.pending_devices}件
          </p>
        ))}
      </section>
    </main>
  );
}
