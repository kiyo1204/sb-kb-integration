import {discardAssessmentDrafts} from "./assessment-drafts";
import { newClientId, requestDigest } from "./client-identity";
type Item = {
  id: string;
  order: number;
  event: Record<string, unknown>;
  created: number;
  attempts: number;
  last: "UNSENT" | "RETRYING" | "UNKNOWN";
};
type State = {
  sessionId: string;
  clientId: string;
  next: number;
  reportSequence: number;
  attempts: number;
  lastResponse: "NONE" | "ACK" | "NETWORK" | "RETRYABLE" | "REJECTED";
  acknowledged: number;
  capacityLost: number;
  expiredLost: number;
  rejectedLost: number;
  storageLost: number;
  items: Item[];
};
export const limits = {
  count: 500,
  bytes: 1000000,
  ageMs: 7 * 86400000,
  sessions: 32,
};
const storageLoss = new Map<
  string,
  { clientId: string; count: number; sequence: number }
>();
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("stage1-observation-outbox", 1);
    r.onupgradeneeded = () =>
      r.result.createObjectStore("sessions", { keyPath: "sessionId" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => {
      database = undefined;
      reject(new Error("storage_unavailable"));
    };
  }));
}
async function changeStateInner<T>(
  sessionId: string,
  fn: (s: State) => T,
): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("sessions", "readwrite"),
      store = tx.objectStore("sessions"),
      r = store.get(sessionId);
    let value: T;
    r.onsuccess = () => {
      const apply = () => {
        const s: State = r.result ?? {
          sessionId,
          clientId: newClientId(),
          next: 1,
          reportSequence: 0,
          attempts: 0,
          lastResponse: "NONE",
          acknowledged: 0,
          capacityLost: 0,
          expiredLost: 0,
          rejectedLost: 0,
          storageLost: 0,
          items: [],
        };
        try {
          if (!validState(s, sessionId)) throw new Error();
          value = fn(s);
          store.put(s);
        } catch {
          tx.abort();
        }
      };
      if (r.result) apply();
      else {
        const count = store.count();
        count.onsuccess = () => {
          if (count.result >= limits.sessions) tx.abort();
          else apply();
        };
      }
    };
    tx.oncomplete = () => resolve(value);
    tx.onerror = tx.onabort = () => reject(new Error("storage_unavailable"));
  });
}
const uuid = (x: unknown): x is string =>
  typeof x === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
function validState(value: State, sessionId: string) {
  const counters = [
    "next",
    "reportSequence",
    "attempts",
    "acknowledged",
    "capacityLost",
    "expiredLost",
    "rejectedLost",
    "storageLost",
  ] as const;
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some(
      (k) =>
        ![
          "sessionId",
          "clientId",
          "lastResponse",
          "items",
          ...counters,
        ].includes(k),
    ) ||
    value.sessionId !== sessionId ||
    !uuid(value.clientId) ||
    !Array.isArray(value.items) ||
    value.items.length > 500 ||
    !counters.every((k) => Number.isSafeInteger(value[k]) && value[k] >= 0) ||
    value.next < 1 ||
    !["NONE", "ACK", "NETWORK", "RETRYABLE", "REJECTED"].includes(
      value.lastResponse,
    )
  )
    return false;
  const ids = new Set<string>();
  let previous = 0;
  for (const i of value.items) {
    if (
      !i ||
      typeof i !== "object" ||
      Object.keys(i).some(
        (k) =>
          !["id", "order", "event", "created", "attempts", "last"].includes(k),
      ) ||
      !uuid(i.id) ||
      ids.has(i.id) ||
      !Number.isSafeInteger(i.order) ||
      i.order <= previous ||
      i.order >= value.next ||
      !Number.isFinite(i.created) ||
      i.created < 0 ||
      !Number.isSafeInteger(i.attempts) ||
      i.attempts < 0 ||
      !["UNSENT", "RETRYING", "UNKNOWN"].includes(i.last) ||
      !allowedObservation(i.event)
    )
      return false;
    previous = i.order;
    ids.add(i.id);
  }
  return (
    new TextEncoder().encode(JSON.stringify(value.items)).length <= 1000000
  );
}
export async function changeState<T>(
  sessionId: string,
  fn: (s: State) => T,
): Promise<T> {
  try {
    return await changeStateInner(sessionId, fn);
  } catch {
    if (!storageLoss.has(sessionId))
      storageLoss.set(sessionId, {
        clientId: newClientId(),
        count: 0,
        sequence: 0,
      });
    throw new Error("storage_unavailable");
  }
}
export function allowedObservation(e: Record<string, unknown>) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  const types: Record<string, string> = {
    SCREEN_ENTER: "SCREEN",
    SCREEN_LEAVE: "SCREEN",
    STAGE_PAUSE: "STAGE",
    STAGE_RESUME: "STAGE",
    VIDEO_PLAY: "VIDEO",
    VIDEO_PAUSE: "VIDEO",
    VIDEO_SEEK: "VIDEO",
    VIDEO_COMPLETE: "VIDEO",
    FEEDBACK_DISPLAY: "FEEDBACK",
  };
  const uuid = (x: unknown) =>
    typeof x === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
  if (
    e.schemaVersion !== 1 ||
    typeof e.eventType !== "string" ||
    types[e.eventType] !== e.targetType ||
    !uuid(e.stageId) ||
    (e.mapId !== undefined && !uuid(e.mapId))
  )
    return false;
  if (e.eventType === "FEEDBACK_DISPLAY" && !uuid(e.mapId)) return false;
  if (
    Object.keys(e).some(
      (k) =>
        ![
          "schemaVersion",
          "eventType",
          "targetType",
          "stageId",
          "mapId",
          "outcome",
          "reasonCode",
          "clientTimestamp",
          "clientTimeQuality",
          "details",
        ].includes(k),
    )
  )
    return false;
  if (
    e.clientTimeQuality !== "OBSERVED" ||
    typeof e.clientTimestamp !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.clientTimestamp) ||
    !Number.isFinite(Date.parse(e.clientTimestamp))
  )
    return false;
  const pause = e.eventType === "STAGE_PAUSE" || e.eventType === "STAGE_RESUME";
  if (
    e.outcome !== (pause ? "UNKNOWN" : "SUCCESS") ||
    e.reasonCode !== (pause ? "UNKNOWN" : undefined)
  )
    return false;
  if (e.details !== undefined) {
    if (
      e.eventType !== "VIDEO_SEEK" ||
      !e.details ||
      typeof e.details !== "object" ||
      Array.isArray(e.details)
    )
      return false;
    const d = e.details as Record<string, unknown>;
    if (
      Object.keys(d).length !== 2 ||
      !["fromSeconds", "toSeconds"].every(
        (k) =>
          typeof d[k] === "number" &&
          Number.isFinite(d[k]) &&
          (d[k] as number) >= 0,
      )
    )
      return false;
  }
  return true;
}
export async function enqueue(
  sessionId: string,
  event: Record<string, unknown>,
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      sessionId,
    ) ||
    !allowedObservation(event)
  )
    throw new Error("invalid_observation");
  try {
    return await changeState(sessionId, (s) => {
      const now = Date.now();
      const old = s.items.length;
      s.items = s.items.filter((x) => now - x.created < limits.ageMs);
      s.expiredLost += old - s.items.length;
      const item: Item = {
        id: newClientId(),
        order: s.next++,
        event,
        created: now,
        attempts: 0,
        last: "UNSENT",
      };
      s.items.push(item);
      while (
        s.items.length > limits.count ||
        new TextEncoder().encode(JSON.stringify(s.items)).length > limits.bytes
      ) {
        s.items.shift();
        s.capacityLost++;
      }
      return item.id;
    });
  } catch {
    const loss = storageLoss.get(sessionId) ?? {
      clientId: newClientId(),
      count: 0,
      sequence: 0,
    };
    loss.count++;
    storageLoss.set(sessionId, loss);
    window.dispatchEvent(new Event("stage1-delivery-change"));
    throw new Error("storage_unavailable");
  }
}
type Sender = (path: string, init: RequestInit) => Promise<Response>;
const running = new Map<string, Promise<boolean>>();
export async function flush(sessionId: string, send: Sender): Promise<boolean> {
  if (running.has(sessionId)) return running.get(sessionId)!;
  const task = (async () => {
    try {
      // Authenticate the current tab without persisting credentials.
      const me = await send("/api/me", { signal: AbortSignal.timeout(10000) });
      if (me.status === 410) {
        const body=await me.json().catch(()=>null);
        if(body?.error === "research_data_deleted") {
          if(typeof body.queueKey === "string") await discardDeletedQueue(body.queueKey,send);
        }
        return false;
      }
      if (!me.ok || (await me.json()).sessionId !== sessionId) return false;
      let failed = false,
        announced = false;
      for (;;) {
        const next = await changeState(sessionId, (s) => {
          const old = s.items.length;
          s.items = s.items.filter(
            (x) => Date.now() - x.created < limits.ageMs,
          );
          s.expiredLost += old - s.items.length;
          const item = s.items[0];
          if (item) {
            item.attempts++;
            item.last = "RETRYING";
            s.attempts++;
          }
          return { item, clientId: s.clientId };
        });
        if (!next.item) break;
        if (!announced) {
          announced = true;
          const sending = await changeState(sessionId, (s) => ({
            clientId: s.clientId,
            reportSequence: ++s.reportSequence,
            attempts: s.attempts,
            lastResponse: "SENDING",
            pending: s.items.length,
            retrying: s.items.filter((x) => x.attempts > 0).length,
            acknowledged: s.acknowledged,
            capacityLost: s.capacityLost,
            expiredLost: s.expiredLost,
            rejectedLost: s.rejectedLost,
            storageLost: s.storageLost,
          }));
          await send("/api/sessions/" + sessionId + "/delivery-status", {
            method: "POST",
            signal: AbortSignal.timeout(10000),
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(sending),
          }).catch(() => undefined);
        }
        let response: Response;
        try {
          response = await send("/api/sessions/" + sessionId + "/events", {
            method: "POST",
            signal: AbortSignal.timeout(10000),
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": next.item.id,
              "X-Client-Stream-Id": next.clientId,
              "X-Client-Sequence": String(next.item.order),
            },
            body: JSON.stringify(next.item.event),
          });
        } catch {
          await changeState(sessionId, (s) => {
            const item = s.items.find((i) => i.id === next.item!.id);
            if (item) item.last = "UNKNOWN";
            s.lastResponse = "NETWORK";
          });
          failed = true;
          break;
        }
        const payload = await response.json().catch(() => null);
        if(response.status===410 && payload?.error === "research_data_deleted") {
          if(typeof payload.queueKey === "string") await discardDeletedQueue(payload.queueKey,send);
          return false;
        }
        if (
          response.ok &&
          payload?.logSaved === true &&
          typeof payload.eventId === "string" &&
          typeof payload.sequenceNumber === "string"
        ) {
          await changeState(sessionId, (s) => {
            if (s.items.some((i) => i.id === next.item!.id)) {
              s.items = s.items.filter((i) => i.id !== next.item!.id);
              s.acknowledged++;
            }
            s.lastResponse = "ACK";
          });
        } else if ([400, 403, 404, 409, 410, 422].includes(response.status)) {
          await changeState(sessionId, (s) => {
            if (s.items.some((i) => i.id === next.item!.id)) {
              s.items = s.items.filter((i) => i.id !== next.item!.id);
              s.rejectedLost++;
            }
            s.lastResponse = "REJECTED";
          });
        } else {
          await changeState(sessionId, (s) => {
            const item = s.items.find((i) => i.id === next.item!.id);
            if (item) item.last = "UNKNOWN";
            s.lastResponse = "RETRYABLE";
          });
          failed = true;
          break;
        }
      }
      await reportStorageLoss(sessionId, send);
      const report = await changeState(sessionId, (s) => ({
        clientId: s.clientId,
        reportSequence: ++s.reportSequence,
        attempts: s.attempts,
        lastResponse: s.lastResponse,
        pending: s.items.length,
        retrying: s.items.filter((x) => x.attempts > 0).length,
        acknowledged: s.acknowledged,
        capacityLost: s.capacityLost,
        expiredLost: s.expiredLost,
        rejectedLost: s.rejectedLost,
        storageLost: s.storageLost,
      }));
      await send("/api/sessions/" + sessionId + "/delivery-status", {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      }).catch(() => undefined);
      window.dispatchEvent(new Event("stage1-delivery-change"));
      return !failed;
    } catch {
      await reportStorageLoss(sessionId, send).catch(() => undefined);
      return false;
    }
  })().finally(() => running.delete(sessionId));
  running.set(sessionId, task);
  return task;
}
async function reportStorageLoss(sessionId: string, send: Sender) {
  const loss = storageLoss.get(sessionId);
  if (!loss) return;
  const report = {
    clientId: loss.clientId,
    reportSequence: ++loss.sequence,
    pending: 0,
    retrying: 0,
    attempts: 0,
    lastResponse: "STORAGE",
    acknowledged: 0,
    capacityLost: 0,
    expiredLost: 0,
    rejectedLost: 0,
    storageLost: loss.count,
  };
  await send("/api/sessions/" + sessionId + "/delivery-status", {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  });
}
export async function queueStatus(sessionId: string) {
  if (storageLoss.has(sessionId)) throw new Error("storage_unavailable");
  return changeState(sessionId, (s) => ({
    pending: s.items.length,
    retrying: s.items.filter((i) => i.attempts > 0).length,
    lost: s.capacityLost + s.expiredLost + s.rejectedLost + s.storageLost,
    acknowledged: s.acknowledged,
  }));
}

export async function discardDeletedQueue(queueKey:string,send:Sender) {
 discardAssessmentDrafts(queueKey);
 const database=await db();
 const states=await new Promise<State[]>((resolve,reject)=>{const r=database.transaction("sessions","readonly").objectStore("sessions").getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error("queue_unavailable"));});
 for(const state of states){const hash=requestDigest(state.sessionId);if(hash!==queueKey)continue;
 await new Promise<void>((resolve,reject)=>{const tx=database.transaction("sessions","readwrite");tx.objectStore("sessions").delete(state.sessionId);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(new Error("queue_delete_failed"));});storageLoss.delete(state.sessionId);
 await send("/api/deletion-ack",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientId:state.clientId})});
 }
}
