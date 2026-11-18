import {
  apiFetch,
  getExperimentObservationOrigin,
  isObservationContextCurrent,
  type ObservationContext,
} from "./auth-client";
import { newClientId } from "./client-identity";
import {
  allowedObservation,
  isLegacyObservationQueue,
  QueueUpgradeBlockedError,
  limits,
  type LegacyObservationQueue,
} from "./observation-outbox";

const databaseName = "stage1-observation-outbox";
const streamLimit = 64;
const maxSequence = 999_999_999_999_999;
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const byteLength = (items: unknown[]) =>
  new TextEncoder().encode(JSON.stringify(items)).length;

type CaptureContext = Pick<
  ObservationContext,
  "sessionId" | "requiresOrigin" | "origin"
>;
type ObservationRecord = {
  id: string;
  sequence: number;
  event: Record<string, unknown>;
  created: number;
};
type DeliveryState =
  "pending" | "retry" | "authorization" | "stale" | "ended" | "rejected";
type StreamDelivery = {
  acknowledged: number;
  fence: number;
  state: DeliveryState;
  lease?: { token: string; expiresAt: number };
};
type ObservationStream = {
  sessionId: string;
  originClientId: string;
  generation: number;
  streamId: string;
  next: number;
  items: ObservationRecord[];
  delivery?: StreamDelivery;
};
type SessionSnapshot = {
  legacy: LegacyObservationQueue | undefined;
  streams: ObservationStream[];
};
type Preservation = {
  readSession(sessionId: string): Promise<SessionSnapshot>;
  close(): void;
};
type Capture = Preservation & {
  append(
    context: CaptureContext,
    event: Record<string, unknown>,
  ): Promise<{ id: string; streamId: string; sequence: number }>;
};
type VerificationLimits = Readonly<{ count?: number; bytes?: number }>;
type Delivery = Capture & {
  flush(context: ObservationContext): Promise<void>;
};
const deliveryChanged = "stage1-v3-delivery-change";
const leaseMs = 30_000;
const unsent = (): StreamDelivery => ({
  acknowledged: 0,
  fence: 0,
  state: "pending",
});
const blockedStates: DeliveryState[] = ["stale", "ended", "rejected"];

function connect(upgrade: boolean) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 3);
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new QueueUpgradeBlockedError("storage_upgrade_blocked"));
    };
    request.onupgradeneeded = (event) => {
      const tx = request.transaction!;
      try {
        if (
          blocked ||
          !upgrade ||
          event.oldVersion !== 2 ||
          tx.objectStore("sessions").keyPath !== "sessionId"
        ) {
          tx.abort();
          return;
        }
        const streams = request.result.createObjectStore("streams", {
          keyPath: ["sessionId", "originClientId", "generation"],
        });
        streams.createIndex("bySession", "sessionId");
        streams.createIndex("bySessionStream", ["sessionId", "streamId"], {
          unique: true,
        });
      } catch {
        tx.abort();
      }
    };
    request.onerror = () =>
      reject(new Error("observation_v3_unavailable", { cause: request.error }));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

function validStream(stream: ObservationStream, sessionId: string) {
  if (!stream) return false;
  const delivery = stream.delivery ?? unsent();
  return (
    stream.sessionId === sessionId &&
    uuid(stream.originClientId) &&
    Number.isSafeInteger(stream.generation) &&
    stream.generation > 0 &&
    uuid(stream.streamId) &&
    Array.isArray(stream.items) &&
    Number.isSafeInteger(stream.next) &&
    Number.isSafeInteger(delivery.acknowledged) &&
    delivery.acknowledged >= 0 &&
    Number.isSafeInteger(delivery.fence) &&
    delivery.fence >= 0 &&
    ["pending", "retry", "authorization", ...blockedStates].includes(
      delivery.state,
    ) &&
    (!delivery.lease ||
      (uuid(delivery.lease.token) &&
        Number.isSafeInteger(delivery.lease.expiresAt))) &&
    stream.next === delivery.acknowledged + stream.items.length + 1 &&
    stream.next <= maxSequence + 1 &&
    stream.items.every(
      (item, index) =>
        item &&
        uuid(item.id) &&
        item.sequence === delivery.acknowledged + index + 1 &&
        Number.isSafeInteger(item.created) &&
        item.created >= 0 &&
        allowedObservation(item.event),
    )
  );
}

function loadSession(tx: IDBTransaction, sessionId: string) {
  const legacy = tx.objectStore("sessions").get(sessionId);
  const streams = tx
    .objectStore("streams")
    .index("bySession")
    .getAll(sessionId);
  const read = (): SessionSnapshot => {
    const previous: LegacyObservationQueue | undefined = legacy.result;
    const rows: ObservationStream[] = streams.result;
    if (
      (previous !== undefined &&
        !isLegacyObservationQueue(previous, sessionId)) ||
      rows.some((row) => !validStream(row, sessionId))
    )
      throw new Error("observation_v3_invalid_record");
    return { legacy: previous, streams: rows };
  };
  return read;
}

function readSession(db: IDBDatabase, sessionId: string) {
  return new Promise<SessionSnapshot>((resolve, reject) => {
    if (!uuid(sessionId)) throw new Error("invalid_observation_session");
    const tx = db.transaction(["sessions", "streams"], "readonly");
    const read = loadSession(tx, sessionId);
    tx.oncomplete = () => {
      try {
        resolve(read());
      } catch (error) {
        reject(error);
      }
    };
    tx.onabort = () => reject(tx.error);
  });
}

function append(
  db: IDBDatabase,
  context: CaptureContext,
  event: Record<string, unknown>,
  bounds: Required<VerificationLimits>,
) {
  // Copy occurrence data before any asynchronous work. Never infer origin from live auth.
  const { sessionId, origin, requiresOrigin } = context;
  if (
    !requiresOrigin ||
    !uuid(sessionId) ||
    !origin ||
    !uuid(origin.clientId) ||
    !Number.isSafeInteger(origin.generation) ||
    origin.generation < 1
  ) {
    return Promise.reject(new Error("observation_origin_unconfirmed"));
  }
  const { clientId: originClientId, generation } = origin;
  return new Promise<Awaited<ReturnType<Capture["append"]>>>(
    (resolve, reject) => {
      const record: ObservationRecord = {
        id: newClientId(),
        sequence: 0,
        event: structuredClone(event),
        created: Date.now(),
      };
      if (!allowedObservation(record.event))
        throw new Error("invalid_observation");
      const tx = db.transaction(["sessions", "streams"], "readwrite");
      const store = tx.objectStore("streams");
      const read = loadSession(tx, sessionId);
      const legacyKeys = tx.objectStore("sessions").getAllKeys();
      const streamKeys = store.index("bySession").getAllKeys();
      let result: Awaited<ReturnType<Capture["append"]>>;
      let failure: unknown;
      streamKeys.onsuccess = () => {
        try {
          const { legacy, streams } = read();
          const current = streams.find(
            (row) =>
              row.originClientId === originClientId &&
              row.generation === generation,
          );
          const sessions = new Set([
            ...legacyKeys.result,
            ...streamKeys.result.map((key) => (key as IDBValidKey[])[0]),
          ]);
          const usedCount =
            (legacy?.items.length ?? 0) +
            streams.reduce((count, row) => count + row.items.length, 0);
          if (
            usedCount >= bounds.count ||
            (!sessions.has(sessionId) && sessions.size >= limits.sessions) ||
            (!current && streams.length >= streamLimit)
          )
            throw new Error("observation_capacity");
          const row = current ?? {
            sessionId,
            originClientId,
            generation,
            streamId: newClientId(),
            next: 1,
            items: [],
          };
          if (row.next > maxSequence)
            throw new Error("observation_sequence_exhausted");
          if (
            legacy?.clientId === row.streamId ||
            legacy?.items.some((item) => item.id === record.id) ||
            streams.some((stream) =>
              stream.items.some((item) => item.id === record.id),
            )
          )
            throw new Error("observation_id_conflict");
          record.sequence = row.next;
          const items = [...row.items, record];
          const usedBytes =
            (legacy ? byteLength(legacy.items) : 0) +
            byteLength(items) +
            streams.reduce(
              (bytes, stream) =>
                bytes + (stream === current ? 0 : byteLength(stream.items)),
              0,
            );
          if (usedBytes > bounds.bytes) throw new Error("observation_capacity");
          store.put({ ...row, next: row.next + 1, items });
          result = {
            id: record.id,
            streamId: row.streamId,
            sequence: record.sequence,
          };
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        window.dispatchEvent(new Event(deliveryChanged));
        resolve(result);
      };
      tx.onabort = () =>
        reject(
          failure ??
            new Error("observation_v3_unavailable", { cause: tx.error }),
        );
    },
  );
}

function currentOrigin(context: ObservationContext) {
  const active = getExperimentObservationOrigin(context.sessionId);
  return context.requiresOrigin &&
    uuid(context.sessionId) &&
    context.origin &&
    active &&
    isObservationContextCurrent(context) &&
    active.clientId === context.origin.clientId &&
    active.generation === context.origin.generation
    ? active
    : null;
}

function editStream<T>(
  db: IDBDatabase,
  key: IDBValidKey[],
  edit: (row: ObservationStream) => T,
) {
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction("streams", "readwrite");
    const store = tx.objectStore("streams");
    const request = store.get(key);
    let value: T | undefined;
    let failure: unknown;
    request.onsuccess = () => {
      const row: ObservationStream | undefined = request.result;
      if (!row) return;
      try {
        if (!validStream(row, String(key[0])))
          throw new Error("observation_v3_invalid_record");
        value = edit(row);
        if (value !== undefined) store.put(row);
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => {
      if (value !== undefined) window.dispatchEvent(new Event(deliveryChanged));
      resolve(value);
    };
    tx.onabort = () => reject(failure ?? tx.error);
  });
}

async function responseState(
  response: Response,
): Promise<DeliveryState | "ack"> {
  const data = await response.json().catch(() => null);
  if (
    response.ok &&
    data?.logSaved === true &&
    uuid(data.eventId) &&
    typeof data.sequenceNumber === "string" &&
    /^[1-9][0-9]*$/.test(data.sequenceNumber)
  )
    return "ack";
  if (response.status === 401) return "authorization";
  if (response.status === 409) {
    if (
      data?.error === "experiment_origin_stale" ||
      data?.error === "experiment_client_stale"
    )
      return "stale";
    if (data?.error === "experiment_ended") return "ended";
  }
  if (
    response.ok ||
    response.status >= 500 ||
    response.status === 408 ||
    response.status === 429
  )
    return "retry";
  return "rejected";
}

async function flush(db: IDBDatabase, context: ObservationContext) {
  const origin = currentOrigin(context);
  if (!origin) return;
  const key = [context.sessionId, origin.clientId, origin.generation];
  while (currentOrigin(context)) {
    const token = newClientId();
    const claimed = await editStream(db, key, (row) => {
      const delivery = row.delivery ?? unsent();
      const head = row.items[0];
      if (
        !currentOrigin(context) ||
        !head ||
        blockedStates.includes(delivery.state) ||
        (delivery.lease && delivery.lease.expiresAt > Date.now())
      )
        return;
      const fence = delivery.fence + 1;
      row.delivery = {
        ...delivery,
        fence,
        lease: { token, expiresAt: Date.now() + leaseMs },
      };
      return {
        head,
        streamId: row.streamId,
        fence,
        body: JSON.stringify(head.event),
      };
    });
    if (!claimed) return;

    let result: DeliveryState | "ack" = "retry";
    if (currentOrigin(context)) {
      try {
        result = await responseState(
          await apiFetch(`/api/sessions/${context.sessionId}/events`, {
            method: "POST",
            signal: AbortSignal.timeout(10_000),
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": claimed.head.id,
              "X-Client-Stream-Id": claimed.streamId,
              "X-Client-Sequence": String(claimed.head.sequence),
              "X-Experiment-Origin-Client": origin.clientId,
              "X-Experiment-Origin-Generation": String(origin.generation),
            },
            body: claimed.body,
          }),
        );
      } catch {
        /* Transport failure keeps the original head for replay. */
      }
    }
    const acknowledged = await editStream(db, key, (row) => {
      const delivery = row.delivery;
      if (
        !delivery ||
        delivery.fence !== claimed.fence ||
        delivery.lease?.token !== token ||
        row.streamId !== claimed.streamId ||
        row.items[0]?.id !== claimed.head.id ||
        row.items[0].sequence !== claimed.head.sequence ||
        JSON.stringify(row.items[0].event) !== claimed.body
      )
        return;
      delete delivery.lease;
      if (!currentOrigin(context)) return false;
      if (result !== "ack") {
        delivery.state = result;
        return false;
      }
      row.items.shift();
      delivery.acknowledged++;
      delivery.state = "pending";
      return true;
    });
    if (!acknowledged) return;
  }
}

export function observationStreamSummary(
  snapshot: SessionSnapshot,
  context: ObservationContext,
) {
  const origin = currentOrigin(context);
  const current =
    origin &&
    snapshot.streams.find(
      (row) =>
        row.sessionId === context.sessionId &&
        row.originClientId === origin.clientId &&
        row.generation === origin.generation,
    );
  return {
    held:
      (snapshot.legacy?.items.length ?? 0) +
      snapshot.streams.reduce(
        (sum, row) => sum + (row === current ? 0 : row.items.length),
        0,
      ),
    current: current
      ? {
          pending: current.items.length,
          acknowledged: current.delivery?.acknowledged ?? 0,
          state:
            current.delivery?.lease &&
            current.delivery.lease.expiresAt > Date.now()
              ? ("sending" as const)
              : (current.delivery?.state ?? "pending"),
        }
      : null,
  };
}

// This entry point is intentionally separate from the normal v2 page and sender.
// Only an explicit loopback verification capture may upgrade; preservation can only read v3.
export function openObservationStreamV3(
  mode: "preserve",
): Promise<Preservation>;
export function openObservationStreamV3(
  mode: "capture",
  lowerLimits?: VerificationLimits,
): Promise<Capture>;
export function openObservationStreamV3(mode: "delivery"): Promise<Delivery>;
export async function openObservationStreamV3(
  mode: "preserve" | "capture" | "delivery",
  lowerLimits?: VerificationLimits,
) {
  if (mode !== "preserve" && mode !== "capture" && mode !== "delivery")
    throw new Error("invalid_observation_storage_mode");
  if (mode !== "preserve" && location.hostname !== "127.0.0.1")
    throw new Error("observation_v3_requires_loopback");
  const bounds = {
    count: lowerLimits?.count ?? limits.count,
    bytes: lowerLimits?.bytes ?? limits.bytes,
  };
  if (
    !Number.isSafeInteger(bounds.count) ||
    bounds.count < 1 ||
    bounds.count > limits.count ||
    !Number.isSafeInteger(bounds.bytes) ||
    bounds.bytes < 1 ||
    bounds.bytes > limits.bytes
  )
    throw new Error("invalid_observation_limits");
  const db = await connect(mode === "capture");
  const reader = {
    readSession: (sessionId: string) => readSession(db, sessionId),
    close: () => db.close(),
  };
  if (mode === "preserve") return reader;
  const capture = {
    ...reader,
    append: (context: CaptureContext, event: Record<string, unknown>) =>
      append(db, context, event, bounds),
  };
  return mode === "delivery"
    ? { ...capture, flush: (context: ObservationContext) => flush(db, context) }
    : capture;
}
