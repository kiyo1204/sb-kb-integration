import {getExperimentObservationOrigin, type ObservationOrigin} from "./auth-client";
import {discardAssessmentDrafts} from "./assessment-drafts";
import { newClientId, requestDigest } from "./client-identity";
type Item = {
  experimentOrigin?: {clientId:string;generation:number};
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
  heldHeadId?: string;
  capacityRefused?: number;
};
export const limits = {
  count: 500,
  bytes: 1000000,
  ageMs: 7 * 86400000,
  sessions: 32,
};
const storageLoss = new Map<
  string,
  { clientId: string; count: number; sequence: number; sessionLimitCount?: number }
>();
class QueueCapacityError extends Error {}
export class QueueUpgradeBlockedError extends Error {}
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("stage1-observation-outbox", 2);
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new QueueUpgradeBlockedError("storage_upgrade_blocked"));
    };
    request.onupgradeneeded = (event) => {
      const transaction = request.transaction!;
      if (blocked) {
        transaction.abort();
      } else if (event.oldVersion === 0) {
        request.result.createObjectStore("sessions", { keyPath: "sessionId" });
      } else if (!request.result.objectStoreNames.contains("sessions") ||
        transaction.objectStore("sessions").keyPath !== "sessionId") {
        transaction.abort();
      }
      // Existing rows retain their full contents. Hold metadata is written only on a matching 409.
    };
    request.onsuccess = () => {
      const connection = request.result;
      connection.onversionchange = connection.onclose = () => {
        connection.close();
        database = undefined;
        window.dispatchEvent(new Event("stage1-delivery-change"));
      };
      resolve(connection);
    };
    request.onerror = () => {
      database = undefined;
      reject(new Error("storage_unavailable"));
    };
  }));
}
async function readState(sessionId: string): Promise<State | undefined> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const request = connection.transaction("sessions", "readonly").objectStore("sessions").get(sessionId);
    request.onsuccess = () => {
      try {
        const state: State | undefined = request.result;
        if (state !== undefined && !validState(state, sessionId)) throw new Error();
        resolve(state);
      } catch {
        reject(new Error("storage_unavailable"));
      }
    };
    request.onerror = () => reject(new Error("storage_unavailable"));
  });
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
    let atSessionLimit = false;
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
          if (count.result >= limits.sessions) {
            atSessionLimit = true;
            tx.abort();
          } else apply();
        };
      }
    };
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(atSessionLimit
      ? new QueueCapacityError("observation_capacity")
      : new Error("storage_unavailable"));
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
          "heldHeadId",
          "capacityRefused",
          ...counters,
        ].includes(k),
    ) ||
    value.sessionId !== sessionId ||
    !uuid(value.clientId) ||
    !Array.isArray(value.items) ||
    value.items.length > 500 ||
    (value.heldHeadId !== undefined && (!uuid(value.heldHeadId) || value.heldHeadId !== value.items[0]?.id)) ||
    (value.capacityRefused !== undefined && (!Number.isSafeInteger(value.capacityRefused) || value.capacityRefused < 0)) ||
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
          !["id", "order", "event", "created", "attempts", "last", "experimentOrigin"].includes(k),
      ) ||
      (i.experimentOrigin !== undefined && (!uuid(i.experimentOrigin.clientId) || !Number.isSafeInteger(i.experimentOrigin.generation) || i.experimentOrigin.generation<1 || Object.keys(i.experimentOrigin).sort().join()!=="clientId,generation")) ||
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
  } catch (error) {
    if (error instanceof QueueCapacityError) throw error;
    if (!storageLoss.has(sessionId))
      storageLoss.set(sessionId, {
        clientId: newClientId(),
        count: 0,
        sequence: 0,
      });
    throw new Error("storage_unavailable", { cause: error });
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
  origin: ObservationOrigin|null = getExperimentObservationOrigin(sessionId),
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      sessionId,
    ) ||
    !allowedObservation(event)
  )
    throw new Error("invalid_observation");
  let id: string | undefined;
  try {
    id = await changeState(sessionId, (s) => {
      const item: Item = {
        id: newClientId(),
        order: s.next,
        event,
        created: Date.now(),
        attempts: 0,
        last: "UNSENT",
        ...(origin ? { experimentOrigin: origin } : {}),
      };
      // Refusing the new item keeps the existing queue and its next sequence intact.
      if (s.items.length >= limits.count ||
        new TextEncoder().encode(JSON.stringify([...s.items, item])).length > limits.bytes) {
        s.capacityRefused = (s.capacityRefused ?? 0) + 1;
        return undefined;
      }
      s.items.push(item);
      s.next++;
      return item.id;
    });
  } catch (error) {
    recordObservationFailure(sessionId, error instanceof QueueCapacityError);
    throw error;
  }
  window.dispatchEvent(new Event("stage1-delivery-change"));
  if (!id) throw new QueueCapacityError("observation_capacity");
  return id;
}
// Existing capture-failure reporting, without persisting credentials or inventing an event.
export function recordObservationFailure(sessionId: string, sessionLimit = false) {
    const loss = storageLoss.get(sessionId) ?? {
      clientId: newClientId(),
      count: 0,
      sequence: 0,
    };
    loss.count++;
    if (sessionLimit) loss.sessionLimitCount = (loss.sessionLimitCount ?? 0) + 1;
    storageLoss.set(sessionId, loss);
    window.dispatchEvent(new Event("stage1-delivery-change"));
}
type Sender = (path: string, init: RequestInit) => Promise<Response>;
type HoldCandidate = { clientId: string; itemId: string };
// If the marker cannot be committed, keep the observed rejection in this tab.
const pendingHolds = new Map<string, HoldCandidate>();
function matchesHead(s: State | undefined, candidate: HoldCandidate) {
  return s?.clientId === candidate.clientId && s.items[0]?.id === candidate.itemId;
}
async function persistHold(sessionId: string, candidate: HoldCandidate) {
  await changeState(sessionId, (s) => {
    if (matchesHead(s, candidate)) {
      s.heldHeadId = candidate.itemId;
      s.lastResponse = "REJECTED";
    }
  });
  pendingHolds.delete(sessionId);
}
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
      if (!me.ok) return false;
      const identity=await me.json();
      if(identity.sessionId!==sessionId || identity.runState==="ENDED")return false;
      const pendingHold = pendingHolds.get(sessionId);
      if (pendingHold) await persistHold(sessionId, pendingHold);
      let failed = false,
        announced = false;
      for (;;) {
        const next = await changeState(sessionId, (s) => {
          const item = s.heldHeadId ? undefined : s.items[0];
          if (item) {
            item.attempts++;
            item.last = "RETRYING";
            s.attempts++;
          }
          return { item, held: !!s.heldHeadId, clientId: s.clientId };
        });
        if (next.held) {
          failed = true;
          break;
        }
        if (!next.item) break;
        const sentItem = next.item;
        const candidate = { clientId: next.clientId, itemId: sentItem.id };
        const stillAtHead = (s: State | undefined) => matchesHead(s, candidate) && !s?.heldHeadId;
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
            capacityLost: s.capacityLost + (s.capacityRefused ?? 0),
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
        if (!stillAtHead(await readState(sessionId))) continue;
        let response: Response;
        try {
          response = await send("/api/sessions/" + sessionId + "/events", {
            method: "POST",
            signal: AbortSignal.timeout(10000),
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": sentItem.id,
              "X-Client-Stream-Id": next.clientId,
              "X-Client-Sequence": String(sentItem.order),
              ...(sentItem.experimentOrigin ? {"X-Experiment-Origin-Client":sentItem.experimentOrigin.clientId,"X-Experiment-Origin-Generation":String(sentItem.experimentOrigin.generation)} : {}),
            },
            body: JSON.stringify(sentItem.event),
          });
        } catch {
          await changeState(sessionId, (s) => {
            if (stillAtHead(s)) {
              s.items[0].last = "UNKNOWN";
              s.lastResponse = "NETWORK";
            }
          });
          failed = true;
          break;
        }
        const payload = await response.json().catch(() => null);
        if (response.status === 409 && payload?.error === "experiment_origin_stale") {
          pendingHolds.set(sessionId, candidate);
          await persistHold(sessionId, candidate);
          window.dispatchEvent(new Event("stage1-delivery-change"));
          failed = true;
          break;
        }
        if (payload?.error === "experiment_ended") return false;
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
            if (stillAtHead(s)) {
              s.items.shift();
              s.acknowledged++;
              s.lastResponse = "ACK";
            }
          });
        } else if ([400, 403, 404, 409, 410, 422].includes(response.status)) {
          await changeState(sessionId, (s) => {
            if (stillAtHead(s)) {
              s.items.shift();
              s.rejectedLost++;
              s.lastResponse = "REJECTED";
            }
          });
        } else {
          await changeState(sessionId, (s) => {
            if (stillAtHead(s)) {
              s.items[0].last = "UNKNOWN";
              s.lastResponse = "RETRYABLE";
            }
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
        capacityLost: s.capacityLost + (s.capacityRefused ?? 0),
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
      window.dispatchEvent(new Event("stage1-delivery-change"));
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
  const s = await readState(sessionId);
  const pending = s?.items.length ?? 0;
  const pendingHold = pendingHolds.get(sessionId);
  const held = !!s?.heldHeadId || (!!pendingHold && matchesHead(s, pendingHold));
  const loss = storageLoss.get(sessionId);
  const sessionLimitCount = loss?.sessionLimitCount ?? 0;
  return {
    pending,
    held,
    blockedBehindHead: held ? pending - 1 : 0,
    retrying: held ? 0 : (s?.items.filter((i) => i.attempts > 0).length ?? 0),
    lost: s ? s.capacityLost + s.expiredLost + s.rejectedLost + s.storageLost : 0,
    acknowledged: s?.acknowledged ?? 0,
    capacityRefused: (s?.capacityRefused ?? 0) + sessionLimitCount,
    storageRefused: (loss?.count ?? 0) - sessionLimitCount,
    storageIssue: !!loss && (loss.count === 0 || loss.count > sessionLimitCount || !!pendingHold),
    retentionReview: s?.items.some((item) => Date.now() - item.created >= limits.ageMs) ?? false,
  };
}

export async function discardDeletedQueue(queueKey:string,send:Sender) {
 discardAssessmentDrafts(queueKey);
 const database=await db();
 const states=await new Promise<State[]>((resolve,reject)=>{const r=database.transaction("sessions","readonly").objectStore("sessions").getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error("queue_unavailable"));});
 for(const state of states){const hash=requestDigest(state.sessionId);if(hash!==queueKey)continue;
 await new Promise<void>((resolve,reject)=>{const tx=database.transaction("sessions","readwrite");tx.objectStore("sessions").delete(state.sessionId);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(new Error("queue_delete_failed"));});storageLoss.delete(state.sessionId);pendingHolds.delete(state.sessionId);
 await send("/api/deletion-ack",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientId:state.clientId})});
 }
}
