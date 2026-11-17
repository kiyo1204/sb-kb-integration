import { discardDeletedQueue } from "./observation-outbox";
import { reliableFetch } from "./operation-client";
const key = "stage1-access-token";
let authenticationRevision = 0;
export const getAuthenticationRevision = () => authenticationRevision;
type ExperimentClientOwner = Readonly<{
  sessionId: string;
  authenticationRevision: number;
}>;
export type ObservationOrigin = Readonly<{
  clientId: string;
  generation: number;
}>;
export type ObservationContext = Readonly<{
  sessionId: string;
  authenticationRevision: number;
  revision: number;
  requiresOrigin: boolean;
  origin: ObservationOrigin | null;
}>;
let experimentClient: {
  secret: string;
  generation: number;
  clientId?: string;
} | null = null;
let experimentOwner: ExperimentClientOwner | null = null;
let observationRevision = 0;
const observationListeners = new Set<() => void>();
function observationChanged() {
  observationRevision++;
  observationListeners.forEach((listener) => listener());
}
export const getObservationRevision = () => observationRevision;
export function subscribeObservationContext(listener: () => void) {
  observationListeners.add(listener);
  return () => {
    observationListeners.delete(listener);
  };
}
export function registerExperimentClientOwner(
  sessionId: string,
): ExperimentClientOwner {
  const owner = Object.freeze({ sessionId, authenticationRevision });
  experimentOwner = owner;
  experimentClient = null;
  observationChanged();
  return owner;
}
export function isExperimentClientOwnerCurrent(owner: ExperimentClientOwner) {
  return (
    experimentOwner === owner &&
    owner.authenticationRevision === authenticationRevision
  );
}
export function releaseExperimentClientOwner(owner: ExperimentClientOwner) {
  if (!isExperimentClientOwnerCurrent(owner)) return;
  experimentOwner = null;
  experimentClient = null;
  observationChanged();
}
export function bindExperimentClient(
  value: typeof experimentClient,
  owner: ExperimentClientOwner,
) {
  if (!isExperimentClientOwnerCurrent(owner)) return false;
  experimentClient = value;
  observationChanged();
  return true;
}
export function getExperimentObservationOrigin(
  sessionId?: string,
): ObservationOrigin | null {
  return experimentClient?.clientId &&
    experimentOwner &&
    isExperimentClientOwnerCurrent(experimentOwner) &&
    (!sessionId || sessionId === experimentOwner.sessionId)
    ? Object.freeze({
        clientId: experimentClient.clientId,
        generation: experimentClient.generation,
      })
    : null;
}
export function captureObservationContext(
  sessionId: string,
  requiresOrigin = false,
  revision = observationRevision,
): ObservationContext {
  return Object.freeze({
    sessionId,
    authenticationRevision,
    revision,
    requiresOrigin: requiresOrigin || experimentOwner?.sessionId === sessionId,
    origin: getExperimentObservationOrigin(sessionId),
  });
}
export function isObservationContextCurrent(context: ObservationContext) {
  return (
    context.authenticationRevision === authenticationRevision &&
    context.revision === observationRevision
  );
}

export function uiText(value: string) {
  return value
    .replace(/Integration Map/g, "統合マップ")
    .replace(/Goal Map/g, "ゴールマップ")
    .replace(/SessionStage/g, "セッションの活動")
    .replace(/Session flow/g, "セッション画面")
    .replace(/Session/g, "セッション")
    .replace(/Stage/g, "活動")
    .replace(/Export/g, "出力")
    .replace(/\bMap\b/g, "マップ");
}

export function getAccessToken() {
  return sessionStorage.getItem(key);
}
export function setAccessToken(token: string) {
  const next = token.trim();
  const changed = next !== getAccessToken();
  if (changed) authenticationRevision++;
  sessionStorage.setItem(key, next);
  if (changed) {
    experimentOwner = null;
    experimentClient = null;
    observationChanged();
  }
}
export function clearAccessToken() {
  const changed = getAccessToken() !== null;
  if (changed) authenticationRevision++;
  sessionStorage.removeItem(key);
  if (changed) {
    experimentOwner = null;
    experimentClient = null;
    observationChanged();
  }
}

export async function apiErrorMessage(response: Response, fallback: string) {
  const payload = await response
    .clone()
    .json()
    .catch(() => null);
  // Only fixed safety codes select these messages; never render exception details.
  if (payload?.error === "safety_budget_exceeded")
    return "安全確認の処理量上限を超えました。入力を短くするか出力範囲を絞ってください。範囲を変更できない場合は管理者に連絡してください。";
  if (payload?.error === "safety_lookup_unavailable")
    return "安全確認を行えませんでした。時間をおいて再度お試しください。改善しない場合は管理者に連絡してください。";
  return fallback;
}

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const token = getAccessToken();
  const revision = authenticationRevision;
  const bindingRevision = observationRevision;
  const current = () =>
    revision === authenticationRevision &&
    bindingRevision === observationRevision &&
    token === getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (experimentClient) {
    headers.set("X-Experiment-Client", experimentClient.secret);
    headers.set("X-Experiment-Generation", String(experimentClient.generation));
  }
  return reliableFetch(input, { ...init, headers }).then(async (response) => {
    if (
      response.status === 409 &&
      (
        await response
          .clone()
          .json()
          .catch(() => null)
      )?.error === "experiment_ended"
    ) {
      if (current())
        window.dispatchEvent(
          new CustomEvent("experiment-ended", {
            detail: { authenticationRevision: revision },
          }),
        );
    }
    if (response.status === 410) {
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      if (
        current() &&
        body?.error === "research_data_deleted" &&
        typeof body.queueKey === "string"
      )
        await discardDeletedQueue(body.queueKey, async (path, options) => {
          const h = new Headers(options.headers);
          if (token) h.set("Authorization", `Bearer ${token}`);
          return fetch(path, { ...options, headers: h });
        }).catch(() => undefined);
    }
    return response;
  });
}

export async function downloadApiFile(path: string) {
  const response = await apiFetch(path);
  if (!response.ok)
    throw new Error(
      await apiErrorMessage(response, "ファイルを取得できませんでした。"),
    );
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = path.split("/").at(-1) ?? "export";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
