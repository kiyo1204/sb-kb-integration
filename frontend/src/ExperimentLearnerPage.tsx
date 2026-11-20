import { useCallback, useEffect, useRef, useState } from "react";
import { acquireExperimentTabLease, getReloadableExperimentClient } from "./experiment-client-tab";
import {
  apiFetch,
  bindExperimentClient,
  registerExperimentClientOwner,
  releaseExperimentClientOwner,
  isExperimentClientOwnerCurrent,
} from "./auth-client";
import SessionFlowPage from "./SessionFlowPage";
import MapPage from "./MapPage";
import "./experiment-learner.css";
import {
  experimentAccessIssue,
  experimentAccessCopy,
  isTransientAccessStatus,
  type ExperimentAccessIssue,
} from "./experiment-access-status";
type ConnectionResult = {
  clientId: string;
  material: Record<string, string> | null;
  issue: ExperimentAccessIssue | null;
  retryable?: boolean;
};
/** One live page owns one client secret. Internal navigation never reloads it. */
export default function ExperimentLearnerPage({
  sessionId,
  flowMode,
}: {
  sessionId: string;
  flowMode?: string;
}) {
  const [clientIdentity] = useState(() => getReloadableExperimentClient(sessionId));
  const secret = clientIdentity.secret;
  const [path, setPath] = useState(window.location.pathname),
    [material, setMaterial] = useState<Record<string, string> | null>(null),
    [issue, setIssue] = useState<ExperimentAccessIssue | null>(null),
    [busy, setBusy] = useState(false),
    [clientId, setClientId] = useState(""),
    [retryable, setRetryable] = useState(false),
    [retryCount, setRetryCount] = useState(0),
    [tabCollision, setTabCollision] = useState(false);
  const ownerRef = useRef<ReturnType<
    typeof registerExperimentClientOwner
  > | null>(null);
  const requestRef = useRef(0);
  const connect = useCallback(async (): Promise<ConnectionResult | null> => {
    const owner = ownerRef.current;
    const request = ++requestRef.current;
    const current = () =>
      !!owner &&
      isExperimentClientOwnerCurrent(owner) &&
      request === requestRef.current;
    if (!current()) return null;
    const claim = await apiFetch("/api/experiment-client/claim", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Experiment-Client": secret,
      },
      body: "{}",
    });
    const c = await claim.json().catch(() => null);
    if (!current()) return null;
    if (
      !claim.ok ||
      c?.ownership !== "OWNED" ||
      typeof c.clientId !== "string" ||
      !Number.isInteger(c.deviceGeneration)
    ) {
      if (!isTransientAccessStatus(claim.status)) bindExperimentClient(null, owner!);
      return {
        clientId: typeof c?.clientId === "string" ? c.clientId : "",
        material: null,
        issue:
          claim.status === 409 &&
          c?.ownership === "PENDING" &&
          c?.error === "experiment_client_in_use"
            ? "conflict"
            : "unavailable",
        retryable: isTransientAccessStatus(claim.status),
      };
    }
    bindExperimentClient(
      {
        secret,
        generation: c.deviceGeneration,
        clientId: c.clientId,
      },
      owner!,
    );
    const r = await apiFetch("/api/experiment-material");
    if (!current()) return null;
    if (!r.ok)
      return {
        clientId: c.clientId,
        material: null,
        issue: experimentAccessIssue(
          r.status,
          await r.json().catch(() => null),
        ),
        retryable: isTransientAccessStatus(r.status),
      };
    const d = await r.json();
    if (!current()) return null;
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
  const apply = useCallback((r: ConnectionResult | null) => {
    if (!r) return;
    setClientId(r.clientId);
    setMaterial(r.material);
    setIssue(r.issue);
    setRetryable(r.issue === "unavailable" && !!r.retryable);
  }, []);
  useEffect(() => {
    const owner = registerExperimentClientOwner(sessionId);
    ownerRef.current = owner;
    let active = true;
    let releaseLease: (() => void) | undefined;
    const tabController = new AbortController();
    const current = () => active && isExperimentClientOwnerCurrent(owner);
    // Do not claim or load maps until exclusive use of a cached tab secret
    // is established. A duplicate tab must remain a distinct, blocked view.
    void acquireExperimentTabLease(secret, clientIdentity.reused, tabController.signal, () => {
      if (!current()) return;
      requestRef.current++;
      bindExperimentClient(null, owner);
      setMaterial(null);
      setRetryable(false);
      setTabCollision(true);
      setIssue("conflict");
    })
      .then((lease) => {
        if (!current()) {
          lease?.release();
          return;
        }
        if (!lease) {
          setTabCollision(true);
          setRetryable(false);
          setIssue("conflict");
          return;
        }
        releaseLease = lease.release;
        void connect()
          .then((r) => {
            if (current()) apply(r);
          })
          .catch(() => {
            if (current()) {
              setIssue("unavailable");
              setRetryable(true);
            }
          });
      })
      .catch(() => {
        if (current()) {
          setIssue("unavailable");
          setRetryable(false);
        }
      });
    return () => {
      active = false;
      tabController.abort();
      releaseLease?.();
      releaseExperimentClientOwner(owner);
      if (ownerRef.current === owner) ownerRef.current = null;
    };
  }, [connect, apply, sessionId, secret, clientIdentity.reused]);
  // Bounded backoff avoids turning a brief outage into permanent lockout,
  // without retrying definite 401/409 or changing client ownership.
  useEffect(() => {
    if (!retryable || retryCount >= 3 || busy) return;
    const timer = window.setTimeout(() => {
      const owner = ownerRef.current;
      if (!owner || !isExperimentClientOwnerCurrent(owner)) return;
      setRetryCount(value => value + 1);
      setBusy(true);
      void connect()
        .then(r => { if (isExperimentClientOwnerCurrent(owner)) apply(r); })
        .catch(() => {
          if (isExperimentClientOwnerCurrent(owner)) {
            setIssue("unavailable");
            setRetryable(true);
          }
        })
        .finally(() => { if (isExperimentClientOwnerCurrent(owner)) setBusy(false); });
    }, [4000, 8000, 16000][retryCount]);
    return () => window.clearTimeout(timer);
  }, [retryable, retryCount, busy, connect, apply]);
  useEffect(() => {
    if (!retryable) return;
    const online = () => setRetryCount(0);
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [retryable]);
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
      {flowMode !== "enabled" && (
        <p className="experiment-preview-banner">
          模擬検証専用です。実研究データを入力しないでください。
        </p>
      )}
      {issue ? (
        <section
          className="session-card"
          aria-labelledby="experiment-access-heading"
        >
          <h1 id="experiment-access-heading">
            {tabCollision ? "この画面は別タブで利用中です" : experimentAccessCopy[issue].title}
          </h1>
          {issue === "waiting" && (
            <p>コードの確認と、この画面の端末登録は完了しています。</p>
          )}
          <p role={issue === "waiting" || retryable ? "status" : "alert"}>
            {tabCollision
              ? "同じ利用画面が別タブで開かれています。元のタブを使ってください。このタブでは登録や操作を行いません。"
              : experimentAccessCopy[issue].message}
          </p>
          {issue === "unavailable" && retryable && (
            <p role="status">
              {retryCount >= 3
                ? "一時的な通信エラーが続いています。自動再確認は一旦終了しました。接続を確認し、手動で再確認してください。"
                : "一時的な通信エラーです。自動的に再確認します。再確認できるまで編集・提出はできません。"}
            </p>
          )}
          {clientId && (
            <p>
              画面識別子：<code>{clientId}</code>
            </p>
          )}
          <button
            disabled={busy || tabCollision}
            onClick={() => {
              const owner = ownerRef.current;
              if (!owner || !isExperimentClientOwnerCurrent(owner)) return;
              setRetryCount(0);
              setBusy(true);
              void connect()
                .then((r) => {
                  if (isExperimentClientOwnerCurrent(owner)) apply(r);
                })
                .catch(() => {
                  if (isExperimentClientOwnerCurrent(owner)) {
                    setMaterial(null);
                    setIssue("unavailable");
                    setRetryable(true);
                  }
                })
                .finally(() => {
                  if (isExperimentClientOwnerCurrent(owner)) setBusy(false);
                });
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
