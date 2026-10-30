import { newClientId, requestDigest } from "./client-identity";
type ReceiptKey = { hash: string; key: string; created: number };
const maxPending = 100,
  maxAge = 7 * 86400000;
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("stage1-operation-keys", 1);
    r.onupgradeneeded = () =>
      r.result.createObjectStore("keys", { keyPath: "hash" });
    r.onerror = () => {
      database = undefined;
      reject(
        new Error("操作の再送情報を保持できません。研究者に知らせてください。"),
      );
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => {
        r.result.close();
        database = undefined;
      };
      resolve(r.result);
    };
  }));
}
// Only the fingerprint, random key and creation time persist. Never a request body or credential.
export async function operationKey(hash: string, supplied?: string | null) {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !/^[0-9a-f]{64}$/.test(hash) ||
    (supplied !== undefined && supplied !== null && !uuid.test(supplied))
  )
    throw new Error("再送キーの形式が不正です。");
  const database = await db();
  return new Promise<string>((resolve, reject) => {
    const tx = database.transaction("keys", "readwrite"),
      store = tx.objectStore("keys"),
      r = store.get(hash);
    let key = "",
      message = "操作の再送情報を保持できません。研究者に知らせてください。";
    r.onsuccess = () => {
      const prior = r.result as ReceiptKey | undefined;
      if (prior) {
        if (
          !uuid.test(prior.key) ||
          Object.keys(prior).some(
            (k) => !["hash", "key", "created"].includes(k),
          ) ||
          !Number.isFinite(prior.created) ||
          Date.now() - prior.created > maxAge
        ) {
          message =
            "未確認の操作の再送期限を過ぎています。セッション画面で保存状態を確認してください。";
          tx.abort();
          return;
        }
        key = prior.key;
        return;
      }
      const count = store.count();
      count.onsuccess = () => {
        if (count.result >= maxPending) {
          message =
            "未確認の操作が多いため、セッションの保存状態を研究者と確認してください。";
          tx.abort();
          return;
        }
        key = supplied ?? newClientId();
        store.put({ hash, key, created: Date.now() });
      };
    };
    tx.oncomplete = () => resolve(key);
    tx.onerror = tx.onabort = () => reject(new Error(message));
  });
}
async function acknowledge(hash: string, key: string) {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction("keys", "readwrite"),
      store = tx.objectStore("keys"),
      r = store.get(hash);
    r.onsuccess = () => {
      if (r.result?.key === key) store.delete(hash);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(new Error("receipt_storage_unavailable"));
  });
}
export async function reliableFetch(
  input: RequestInfo | URL,
  init: RequestInit,
  send: typeof fetch = fetch,
) {
  const path = String(input),
    method = (init.method ?? "GET").toUpperCase();
  if (
    !["POST", "PATCH", "DELETE"].includes(method) ||
    !/^\/api\/(maps|concepts|links|session-stages|kits)\//.test(path)
  )
    return send(input, init);
  const hash = requestDigest(
    method +
      ":" +
      path +
      ":" +
      (typeof init.body === "string" ? init.body : ""),
  );
  const headers = new Headers(init.headers),
    key = await operationKey(hash, headers.get("Idempotency-Key"));
  headers.set("Idempotency-Key", key);
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await send(input, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(15000),
      });
      break;
    } catch (error) {
      if (attempt || init.signal?.aborted || !navigator.onLine) throw error;
    }
  }
  if (!response) throw new Error("operation_unconfirmed");
  if (response.ok || [400, 403, 404, 409, 422].includes(response.status)) {
    // Losing the local ACK must never turn a successful operation response into a failure.
    await acknowledge(hash, key).catch(() => undefined);
  }
  return response;
}
