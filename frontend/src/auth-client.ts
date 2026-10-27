const key = "stage1-access-token";

export function uiText(value: string) {
  return value.replace(/Integration Map/g, "統合マップ").replace(/Goal Map/g, "ゴールマップ")
    .replace(/SessionStage/g, "セッションの活動").replace(/Session flow/g, "セッション画面")
    .replace(/Session/g, "セッション").replace(/Stage/g, "活動").replace(/Export/g, "出力")
    .replace(/\bMap\b/g, "マップ");
}

export function getAccessToken() { return sessionStorage.getItem(key); }
export function setAccessToken(token: string) { sessionStorage.setItem(key, token.trim()); }
export function clearAccessToken() { sessionStorage.removeItem(key); }

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const token = getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

export async function downloadApiFile(path: string) {
  const response = await apiFetch(path);
  if (!response.ok) throw new Error("ファイルを取得できませんでした。");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = path.split("/").at(-1) ?? "export";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
