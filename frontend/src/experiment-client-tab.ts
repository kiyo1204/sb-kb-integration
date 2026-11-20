// Keep an experiment client's in-tab identity across F5, not across credentials.
// Session storage is cloned by some "Duplicate tab" operations; tab exclusion
// is therefore mandatory before a cached secret may be sent to the server.
import { getAccessToken } from "./auth-client";
import { newClientId, requestDigest } from "./client-identity";

const prefix = "sbkb-experiment-client-v1:";
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function generateSecret() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function getReloadableExperimentClient(sessionId: string): {
  secret: string;
  reused: boolean;
} {
  const token = getAccessToken();
  const credentialDigest = token ? requestDigest(token) : "";
  const key = `${prefix}${sessionId}`;
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (
      token && value && typeof value === "object" &&
      "credentialDigest" in value && value.credentialDigest === credentialDigest &&
      "secret" in value && typeof value.secret === "string" &&
      secretPattern.test(value.secret)
    ) {
      return { secret: value.secret, reused: true };
    }
  } catch {
    // Absent/corrupt storage must never cause a privileged fallback claim.
  }
  const secret = generateSecret();
  try {
    if (token) {
      sessionStorage.setItem(key, JSON.stringify({ credentialDigest, secret }));
    } else {
      sessionStorage.removeItem(key);
    }
  } catch {
    // Without storage, a subsequent reload will be an independent candidate.
  }
  return { secret, reused: false };
}

export type ExperimentTabLease = { release: () => void };

// The Web Locks manager provides atomic cross-tab exclusion on secure origins.
// It is not available on every HTTP LAN origin, where BroadcastChannel provides
// cooperative duplicate-tab detection. No storage-only authorization fallback.
async function webLock(secret: string): Promise<(() => void) | null> {
  const name = `sbkb-experiment-client:${requestDigest(secret)}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    let releaseHold = () => {};
    const hold = new Promise<void>((resolve) => { releaseHold = () => resolve(); });
    const acquired = await new Promise<boolean>((resolve) => {
      void navigator.locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
        resolve(lock !== null);
        if (lock) await hold;
      }).catch(() => resolve(false));
    });
    if (acquired) return releaseHold;
    if (attempt < 7) await delay(120); // Let an unloading F5 page release its lock.
  }
  return null;
}

export async function acquireExperimentTabLease(
  secret: string,
  reused: boolean,
  signal: AbortSignal,
  onCollision: () => void,
): Promise<ExperimentTabLease | null> {
  if (signal.aborted) return null;
  const hasLocks = typeof navigator.locks?.request === "function";
  const releaseWebLock = hasLocks ? await webLock(secret) : null;
  if (hasLocks && !releaseWebLock) return null;
  if (signal.aborted) {
    releaseWebLock?.();
    return null;
  }

  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(`sbkb-experiment-tab:${requestDigest(secret)}`);
    }
  } catch {
    channel = null;
  }
  if (!channel) {
    // A copied sessionStorage secret cannot be reused without tab exclusion.
    if (!releaseWebLock && reused) return null;
    return { release: () => releaseWebLock?.() };
  }

  const peer = newClientId();
  let active = false;
  let collision = false;
  let closed = false;
  const stop = () => {
    closed = true;
    active = false;
    channel?.close();
    releaseWebLock?.();
  };
  signal.addEventListener("abort", stop, { once: true });
  const send = (kind: "probe" | "active" | "candidate", to?: string) =>
    channel?.postMessage({ kind, from: peer, to });
  channel.onmessage = (event: MessageEvent) => {
    const message = event.data as { kind?: string; from?: string; to?: string } | null;
    if (!message || typeof message.from !== "string" || message.from === peer) return;
    if (message.kind === "probe") {
      if (active) send("active", message.from);
      else if (peer < message.from) send("candidate", message.from);
      else collision = true;
    }
    if ((message.kind === "active" || message.kind === "candidate") && message.to === peer) {
      if (active && !closed) {
        stop();
        onCollision(); // Fail closed if a second page unexpectedly owns the secret.
      } else collision = true;
    }
  };
  send("probe");
  await delay(650);
  if (collision || closed || signal.aborted) {
    signal.removeEventListener("abort", stop);
    stop();
    return null;
  }
  active = true;
  return {
    release: () => {
      signal.removeEventListener("abort", stop);
      stop();
    },
  };
}
