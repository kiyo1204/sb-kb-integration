import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  apiFetch,
  clearAccessToken,
  getAccessToken,
  setAccessToken,
} from "./auth-client";
import HomePage from "./HomePage";
import MapPage from "./MapPage";
import SessionFlowPage from "./SessionFlowPage";
import Stage1NewSessionPage from "./Stage1NewSessionPage";
import Stage1AnalysisPage from "./Stage1AnalysisPage";
import Stage1GoalMapsPage from "./Stage1GoalMapsPage";
import TutorialPage from "./TutorialPage";

export default function App() {
  const [token, updateToken] = useState(getAccessToken());
  const [entry, setEntry] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [principal, setPrincipal] = useState<
    { role?: string; sessionId?: string } | null | undefined
  >(token ? undefined : null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    apiFetch("/api/me")
      .then(async (response) => {
        if (!response.ok) throw new Error("Access code is no longer valid");
        return (await response.json()) as { role?: string; sessionId?: string };
      })
      .then((currentPrincipal) => {
        if (!active) return;
        setPrincipal(currentPrincipal);
        if (
          currentPrincipal.role === "learner" &&
          currentPrincipal.sessionId &&
          window.location.pathname === "/"
        ) {
          window.location.assign(`/sessions/${currentPrincipal.sessionId}`);
        }
      })
      .catch(() => {
        if (active) setPrincipal(null);
      });
    return () => {
      active = false;
    };
  }, [token]);

  function renderHomePage() {
    const accessMode = !token
      ? "signed-out"
      : principal === undefined
        ? "checking"
        : principal?.role === "researcher"
          ? "researcher"
          : principal?.role === "learner"
            ? "learner"
            : "signed-out";
    return (
      <HomePage
        accessCode={entry}
        accessError={authError}
        accessMode={accessMode}
        learnerSessionHref={
          principal?.role === "learner" && principal.sessionId
            ? `/sessions/${principal.sessionId}`
            : undefined
        }
        onAccessCodeChange={setEntry}
        onAccessCodeSubmit={(event) => void signIn(event)}
      />
    );
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (entry.trim().length < 32) return;
    const candidate = entry.trim();
    const response = await fetch("/api/me", {
      headers: { Authorization: `Bearer ${candidate}` },
    }).catch(() => null);
    if (!response?.ok) {
      setAuthError("コードを確認できませんでした。再入力してください。");
      return;
    }
    const nextPrincipal = (await response.json()) as {
      role: string;
      sessionId?: string;
    };
    setPrincipal(nextPrincipal);
    setAccessToken(candidate);
    updateToken(candidate);
    setEntry("");
    setAuthError(null);
    if (nextPrincipal.role === "learner" && nextPrincipal.sessionId) {
      window.location.assign(`/sessions/${nextPrincipal.sessionId}`);
    }
  }

  if (window.location.pathname === "/tutorial") {
    return <TutorialPage returnHref={principal?.role === "learner" && principal.sessionId ? `/sessions/${principal.sessionId}` : "/"} />;
  }
  if (!token) {
    return renderHomePage();
  }
  if (principal === undefined) {
    return (
      <main className="page">
        <p role="status">アクセスを確認しています…</p>
      </main>
    );
  }
  return (
    <>
      <div
        className={`auth-toolbar${principal?.role === "learner" ? " is-learner" : ""}`}
      >
        <button
          type="button"
          onClick={() => {
            clearAccessToken();
            setPrincipal(null);
            updateToken(null);
          }}
        >
          アクセスコードを切り替える
        </button>
      </div>
      <AuthenticatedApp
        homePage={renderHomePage()}
        principalRole={principal?.role}
        learnerSessionId={principal?.role === "learner" ? principal.sessionId : undefined}
      />
    </>
  );
}

function AuthenticatedApp({
  homePage,
  principalRole,
  learnerSessionId,
}: {
  homePage: ReactNode;
  principalRole?: string;
  learnerSessionId?: string;
}) {
  const mapId = window.location.pathname.match(/^\/maps\/([^/]+)\/?$/)?.[1];
  const sessionPath = window.location.pathname.match(
    /^\/sessions\/([^/]+)(?:\/([^/]+))?\/?$/,
  );

  if (mapId) {
    return <MapPage mapId={mapId} isLearner={principalRole === "learner"} learnerSessionId={learnerSessionId} />;
  }
  const analysisSessionId = window.location.pathname.match(
    /^\/research\/stage1\/([a-f0-9-]+)\/analysis\/?$/i,
  )?.[1];
  if (analysisSessionId)
    return (
      <ResearcherOnly>
        <Stage1AnalysisPage sessionId={analysisSessionId} />
      </ResearcherOnly>
    );
  if (window.location.pathname === "/research/stage1/new")
    return (
      <ResearcherOnly>
        <Stage1NewSessionPage />
      </ResearcherOnly>
    );
  if (window.location.pathname === "/research/goal-maps")
    return (
      <ResearcherOnly>
        <Stage1GoalMapsPage />
      </ResearcherOnly>
    );
  if (sessionPath && sessionPath[1] !== "new") {
    return (
      <SessionFlowPage
        sessionId={sessionPath[1]}
        requestedStageSlug={sessionPath[2]}
        isLearner={principalRole === "learner"}
      />
    );
  }
  if (window.location.pathname !== "/") return <RouteNotFound />;

  return <>{homePage}</>;
}

function ResearcherOnly({ children }: { children: ReactNode }) {
  const [authorized, setAuthorized] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    apiFetch("/api/me")
      .then(async (response) =>
        response.ok ? ((await response.json()) as { role?: string }) : null,
      )
      .then((principal) => {
        if (mounted) setAuthorized(principal?.role === "researcher");
      })
      .catch(() => {
        if (mounted) setAuthorized(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (authorized === null)
    return (
      <main className="page">
        <p role="status">アクセスを確認しています…</p>
      </main>
    );
  if (!authorized) return <RouteNotFound />;
  return <>{children}</>;
}

function RouteNotFound() {
  return (
    <main className="page">
      <section className="status-card" aria-labelledby="route-error-title">
        <p className="eyebrow">研究用MVP</p>
        <h1 id="route-error-title">ページが見つかりません</h1>
        <p className="description">URLを確認してください。</p>
        <a className="demo-map-link" href="/">
          トップへ戻る
        </a>
      </section>
    </main>
  );
}
