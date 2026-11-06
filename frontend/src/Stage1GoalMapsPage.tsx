import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch, uiText } from "./auth-client";

type GoalMap = {
  id: string;
  title: string | null;
  createdAt: string;
  conceptCount: number;
  linkCount: number;
  kitDefinitionId: string | null;
  kitDefinitionName: string | null;
};

export default function Stage1GoalMapsPage() {
  const [goalMaps, setGoalMaps] = useState<GoalMap[]>([]);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadGoalMaps = useCallback(async () => {
    const response = await apiFetch("/api/research/goal-maps");
    const payload = (await response.json().catch(() => null)) as {
      goalMaps?: GoalMap[];
      message?: string;
    } | null;
    if (!response.ok || !payload || !Array.isArray(payload.goalMaps)) {
      throw new Error(
        payload?.message ?? "ゴールマップ一覧を取得できませんでした。",
      );
    }
    setGoalMaps(payload.goalMaps);
  }, []);

  useEffect(() => {
    let active = true;
    apiFetch("/api/research/goal-maps")
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as {
          goalMaps?: GoalMap[];
          message?: string;
        } | null;
        if (!response.ok || !payload || !Array.isArray(payload.goalMaps)) {
          throw new Error(
            payload?.message ?? "ゴールマップ一覧を取得できませんでした。",
          );
        }
        if (active) setGoalMaps(payload.goalMaps);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? uiText(loadError.message)
              : "ゴールマップ一覧を取得できませんでした。",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function createGoalMap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const mapTitle = title.trim();
    if (!mapTitle || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/api/research/goal-maps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: mapTitle }),
      });
      const payload = (await response.json().catch(() => null)) as {
        id?: string;
        message?: string;
      } | null;
      if (!response.ok || !payload || typeof payload.id !== "string") {
        throw new Error(payload?.message ?? "ゴールマップを作成できませんでした。");
      }
      window.location.assign(`/maps/${encodeURIComponent(payload.id)}`);
    } catch (createError) {
      setError(
        createError instanceof Error
          ? uiText(createError.message)
          : "ゴールマップを作成できませんでした。",
      );
      setBusy(false);
    }
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      await loadGoalMaps();
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? uiText(loadError.message)
          : "ゴールマップ一覧を取得できませんでした。",
      );
    } finally {
      setLoading(false);
    }
  }

  async function importGoalMap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("goal-map-json") as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file || transferBusy) return;
    setTransferBusy(true);
    setError(null);
    try {
      if (file.size > 4_000_000) throw new Error("JSONファイルは4MB以内にしてください。");
      const text = await file.text();
      let document: unknown;
      try {
        document = JSON.parse(text);
      } catch {
        throw new Error("JSONを読み取れませんでした。ファイルの内容を確認してください。");
      }
      const response = await apiFetch("/api/research/goal-maps/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(document),
      });
      const payload = (await response.json().catch(() => null)) as { id?: string; message?: string } | null;
      if (!response.ok || !payload || typeof payload.id !== "string") {
        throw new Error(payload?.message ?? "ゴールマップを取り込めませんでした。");
      }
      if (input) input.value = "";
      await loadGoalMaps();
    } catch (importError) {
      setError(importError instanceof Error ? uiText(importError.message) : "ゴールマップを取り込めませんでした。");
    } finally {
      setTransferBusy(false);
    }
  }

  async function exportGoalMap(mapId: string) {
    if (transferBusy) return;
    setTransferBusy(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/research/goal-maps/${encodeURIComponent(mapId)}/export`);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payload?.message ?? "JSONを書き出せませんでした。");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `goal-map-${mapId}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError instanceof Error ? uiText(exportError.message) : "JSONを書き出せませんでした。");
    } finally {
      setTransferBusy(false);
    }
  }

  return (
    <main className="goal-map-page">
      <header className="goal-map-page-heading">
        <div>
          <p className="eyebrow">研究者 / 教材管理</p>
          <h1>ゴールマップ</h1>
          <p>
            教師用の完成マップを作成し、概念と関係を配置したあと、Kitとして登録します。
          </p>
        </div>
        <a className="back-link" href="/">
          トップへ戻る
        </a>
      </header>

      <section className="goal-map-create-card" aria-labelledby="goal-map-transfer-title">
        <div>
          <p className="home-card-kicker">JSON</p>
          <h2 id="goal-map-transfer-title">ゴールマップを取り込む</h2>
          <p>書き出したゴールマップを新しいマップとして追加します。同じ名前のマップがある場合は、JSON内の名前を変更してから取り込んでください。</p>
        </div>
        <form className="goal-map-create-form" onSubmit={(event) => void importGoalMap(event)}>
          <label htmlFor="goal-map-json">JSONファイル（4MB以内）</label>
          <div className="goal-map-create-control">
            <input id="goal-map-json" name="goal-map-json" type="file" accept="application/json,.json" required />
            <button type="submit" className="home-primary-button" disabled={transferBusy}>
              {transferBusy ? "処理中…" : "取り込む"}
            </button>
          </div>
        </form>
      </section>

      <section
        className="goal-map-create-card"
        aria-labelledby="goal-map-create-title"
      >
        <div>
          <p className="home-card-kicker">新規作成</p>
          <h2 id="goal-map-create-title">ゴールマップを作る</h2>
          <p>
            作成後にマップ編集画面が開きます。ConceptとLinkを編集し、最後にKit名を付けて登録してください。
          </p>
        </div>
        <form
          className="goal-map-create-form"
          onSubmit={(event) => void createGoalMap(event)}
        >
          <label htmlFor="goal-map-title">ゴールマップ名</label>
          <div className="goal-map-create-control">
            <input
              id="goal-map-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
              placeholder="例：光合成の仕組み"
              required
            />
            <button
              type="submit"
              className="home-primary-button"
              disabled={busy}
            >
              {busy ? "作成中…" : "作成して編集"}
            </button>
          </div>
        </form>
      </section>

      {error && (
        <p className="goal-map-error" role="alert">
          {error}
        </p>
      )}

      <section
        className="goal-map-list-section"
        aria-labelledby="goal-map-list-title"
      >
        <div className="goal-map-list-heading">
          <div>
            <p className="home-card-kicker">保存済み</p>
            <h2 id="goal-map-list-title">ゴールマップ一覧</h2>
          </div>
          <button
            type="button"
            className="home-refresh-button"
            onClick={() => void refresh()}
            disabled={loading}
          >
            再読み込み
          </button>
        </div>
        {loading ? (
          <p role="status">読み込み中…</p>
        ) : goalMaps.length === 0 ? (
          <p className="goal-map-empty">ゴールマップはまだありません。</p>
        ) : (
          <ul className="goal-map-list">
            {goalMaps.map((map) => (
              <li key={map.id} className="goal-map-list-item">
                <div className="goal-map-list-item-main">
                  <h3>{map.title || map.kitDefinitionName || "ゴールマップ"}</h3>
                  <p>
                    {map.conceptCount} Concept · {map.linkCount} Link
                    {map.kitDefinitionName
                      ? ` · Kit登録済み：${map.kitDefinitionName}`
                      : " · Kit未登録"}
                  </p>
                  <time dateTime={map.createdAt}>
                    作成：{new Date(map.createdAt).toLocaleString()}
                  </time>
                </div>
                <a
                  className="goal-map-open-link"
                  href={`/maps/${encodeURIComponent(map.id)}`}
                >
                  {map.kitDefinitionId ? "内容を確認" : "編集する"}
                  <span aria-hidden="true">→</span>
                </a>
                <button type="button" className="home-refresh-button" disabled={transferBusy} onClick={() => void exportGoalMap(map.id)}>
                  JSONを書き出す
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
