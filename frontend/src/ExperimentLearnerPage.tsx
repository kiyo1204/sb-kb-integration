import { useCallback, useEffect, useState } from "react";
import { apiFetch, bindExperimentClient } from "./auth-client";
import SessionFlowPage from "./SessionFlowPage";
import MapPage from "./MapPage";
import "./experiment-learner.css";
import {
  experimentAccessIssue,
  experimentAccessCopy,
  type ExperimentAccessIssue,
} from "./experiment-access-status";
type ConnectionResult = {
  clientId: string;
  material: Record<string, string> | null;
  issue: ExperimentAccessIssue | null;
};
/** One live page owns one client secret. Internal navigation never reloads it. */
export default function ExperimentLearnerPage({
  sessionId,
}: {
  sessionId: string;
}) {
  const [secret] = useState(() =>
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, ""),
  );
  const [path, setPath] = useState(window.location.pathname),
    [material, setMaterial] = useState<Record<string, string> | null>(null),
    [issue, setIssue] = useState<ExperimentAccessIssue | null>(null),
    [busy, setBusy] = useState(false),
    [clientId, setClientId] = useState("");
  const connect = useCallback(async (): Promise<ConnectionResult> => {
    const claim = await apiFetch("/api/experiment-client/claim", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Experiment-Client": secret,
      },
      body: "{}",
    });
    const c = await claim.json().catch(() => null);
    if (
      !claim.ok ||
      c?.ownership !== "OWNED" ||
      typeof c.clientId !== "string" ||
      !Number.isInteger(c.deviceGeneration)
    ) {
      bindExperimentClient(null);
      return {
        clientId: typeof c?.clientId === "string" ? c.clientId : "",
        material: null,
        issue:
          claim.status === 409 &&
          c?.ownership === "PENDING" &&
          c?.error === "experiment_client_in_use"
            ? "conflict"
            : "unavailable",
      };
    }
    bindExperimentClient({
      secret,
      generation: c.deviceGeneration,
      clientId: c.clientId,
    });
    const r = await apiFetch("/api/experiment-material");
    if (!r.ok)
      return {
        clientId: c.clientId,
        material: null,
        issue: experimentAccessIssue(
          r.status,
          await r.json().catch(() => null),
        ),
      };
    const d = await r.json();
    if (
      ![d?.sbInstructions, d?.kbInstructions, d?.integrationInstructions].every(
        (v) => typeof v === "string",
      )
    )
      return { clientId: c.clientId, material: null, issue: "unavailable" };
    return {
      clientId: c.clientId,
      issue: null,
      material: {
        PRIOR: d.sbInstructions,
        PRIOR_MAP: d.sbInstructions,
        KB: d.kbInstructions,
        KB_MAP: d.kbInstructions,
        INTEGRATION: d.integrationInstructions,
        INTEGRATION_MAP: d.integrationInstructions,
      },
    };
  }, [secret]);
  const apply = useCallback((r: ConnectionResult) => {
    setClientId(r.clientId);
    setMaterial(r.material);
    setIssue(r.issue);
  }, []);
  useEffect(() => {
    let active = true;
    void connect()
      .then((r) => {
        if (active) apply(r);
      })
      .catch(() => {
        if (active) setIssue("unavailable");
      });
    return () => {
      active = false;
      bindExperimentClient(null);
    };
  }, [connect, apply]);
  const navigate = useCallback((next: string) => {
    history.pushState(null, "", next);
    setPath(next);
  }, []);
  useEffect(() => {
    const pop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const map = /^\/maps\/([a-f0-9-]{36})$/.exec(path);
  return (
    <div
      className="experiment-learner"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (a && /^\/(sessions|maps)\//.test(a.getAttribute("href") ?? "")) {
          e.preventDefault();
          navigate(a.getAttribute("href")!);
        }
      }}
    >
      <p className="experiment-preview-banner">
        模擬検証専用・通常利用は未公開です。実研究データを入力しないでください。
      </p>
      {issue ? (
        <section
          className="session-card"
          aria-labelledby="experiment-access-heading"
        >
          <h1 id="experiment-access-heading">
            {experimentAccessCopy[issue].title}
          </h1>
          {issue === "waiting" && (
            <p>コードの確認と、この画面の端末登録は完了しています。</p>
          )}
          <p role={issue === "waiting" ? "status" : "alert"}>
            {experimentAccessCopy[issue].message}
          </p>
          {clientId && (
            <p>
              画面識別子：<code>{clientId}</code>
            </p>
          )}
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void connect()
                .then(apply)
                .catch(() => {
                  setMaterial(null);
                  setIssue("unavailable");
                })
                .finally(() => setBusy(false));
            }}
          >
            接続状態を更新
          </button>
          {issue === "conflict" && (
            <p>未同期Mapは別画面へ自動移送・適用しません。</p>
          )}
        </section>
      ) : !material ? (
        <p>接続状態を確認しています…</p>
      ) : map ? (
        <MapPage
          key={map[1]}
          mapId={map[1]}
          learnerSessionId={sessionId}
          isLearner
          navigate={navigate}
          instructions={material}
        />
      ) : (
        <SessionFlowPage
          key={sessionId + path}
          sessionId={sessionId}
          isLearner
          navigate={navigate}
          instructions={material}
        />
      )}
    </div>
  );
}
