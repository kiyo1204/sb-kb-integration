import {discardDeletedQueue} from "./observation-outbox";
import { reliableFetch } from "./operation-client";
const key = "stage1-access-token";
let authenticationRevision = 0;
export const getAuthenticationRevision = () => authenticationRevision;
let experimentClient: {secret:string;generation:number;clientId?:string}|null=null;
export function bindExperimentClient(value:typeof experimentClient){experimentClient=value;}
export function getExperimentObservationOrigin(){return experimentClient?.clientId ? {clientId:experimentClient.clientId,generation:experimentClient.generation} : null;}


export function uiText(value: string) {
  return value.replace(/Integration Map/g, "統合マップ").replace(/Goal Map/g, "ゴールマップ")
    .replace(/SessionStage/g, "セッションの活動").replace(/Session flow/g, "セッション画面")
    .replace(/Session/g, "セッション").replace(/Stage/g, "活動").replace(/Export/g, "出力")
    .replace(/\bMap\b/g, "マップ");
}

export function getAccessToken() { return sessionStorage.getItem(key); }
export function setAccessToken(token: string) { const next=token.trim(); if(next!==getAccessToken())authenticationRevision++; sessionStorage.setItem(key, next); }
export function clearAccessToken() { if(getAccessToken()!==null)authenticationRevision++; sessionStorage.removeItem(key); }

export async function apiErrorMessage(response: Response, fallback: string) {
  const payload = await response.clone().json().catch(() => null);
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
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if(experimentClient){headers.set("X-Experiment-Client",experimentClient.secret);headers.set("X-Experiment-Generation",String(experimentClient.generation));}
  return reliableFetch(input, { ...init, headers }).then(async response=>{
    if(response.status===409 && (await response.clone().json().catch(()=>null))?.error==="experiment_ended"){
      if(revision === authenticationRevision && token === getAccessToken())
        window.dispatchEvent(new CustomEvent("experiment-ended", {detail:{authenticationRevision:revision}}));
    }
    if(response.status===410){const body=await response.clone().json().catch(()=>null);if(body?.error==="research_data_deleted"&&typeof body.queueKey==="string")await discardDeletedQueue(body.queueKey,async(path,options)=>{const h=new Headers(options.headers);if(token)h.set("Authorization",`Bearer ${token}`);return fetch(path,{...options,headers:h});}).catch(()=>undefined);}
    return response;
  });
}

export async function downloadApiFile(path: string) {
  const response = await apiFetch(path);
  if (!response.ok) throw new Error(await apiErrorMessage(response, "ファイルを取得できませんでした。"));
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = path.split("/").at(-1) ?? "export";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
