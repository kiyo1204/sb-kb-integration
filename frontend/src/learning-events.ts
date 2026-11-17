import { enqueue, flush, recordObservationFailure } from "./observation-outbox";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  apiFetch,
  captureObservationContext,
  isObservationContextCurrent,
  subscribeObservationContext,
  getObservationRevision,
  type ObservationContext,
} from "./auth-client";

export type ObservedLearningEvent =
  | {
      eventType: "FEEDBACK_DISPLAY";
      targetType: "FEEDBACK";
      stageId: string;
      mapId: string;
    }
  | {
      eventType: "SCREEN_ENTER" | "SCREEN_LEAVE";
      targetType: "SCREEN";
      stageId: string;
      mapId?: string;
    }
  | {
      eventType: "STAGE_PAUSE" | "STAGE_RESUME";
      targetType: "STAGE";
      stageId: string;
      mapId?: string;
    }
  | {
      eventType: "VIDEO_PLAY" | "VIDEO_PAUSE" | "VIDEO_COMPLETE";
      targetType: "VIDEO";
      stageId: string;
    }
  | {
      eventType: "VIDEO_SEEK";
      targetType: "VIDEO";
      stageId: string;
      details: { fromSeconds: number; toSeconds: number };
    };

export async function sendObservedLearningEvent(
  sessionId: string,
  event: ObservedLearningEvent,
  keepalive = false,
  context: ObservationContext = captureObservationContext(sessionId),
): Promise<boolean> {
  const visibilityEvent =
    event.eventType === "STAGE_PAUSE" || event.eventType === "STAGE_RESUME";
  void keepalive;
  try {
    if (
      context.sessionId !== sessionId ||
      (context.requiresOrigin && !context.origin)
    ) {
      recordObservationFailure(sessionId);
      return false;
    }
    await enqueue(
      sessionId,
      {
        schemaVersion: 1,
        ...event,
        outcome: visibilityEvent ? "UNKNOWN" : "SUCCESS",
        ...(visibilityEvent ? { reasonCode: "UNKNOWN" } : {}),
        clientTimestamp: new Date().toISOString(),
        clientTimeQuality: "OBSERVED",
      },
      context.origin,
    );
    if (!isObservationContextCurrent(context)) return false;
    return flush(sessionId, async (path, init) => {
      if (!isObservationContextCurrent(context))
        throw new Error("observation_context_changed");
      const response = await apiFetch(path, init);
      if (!isObservationContextCurrent(context))
        throw new Error("observation_context_changed");
      return response;
    });
  } catch {
    return false;
  }
}

export function useObservedLearningScreen(
  sessionId: string,
  stageId: string | null | undefined,
  mapId: string | null | undefined,
  enabled: boolean,
  onLogFailure?: () => void,
  requiresOrigin = false,
) {
  const revision = useSyncExternalStore(
    subscribeObservationContext,
    getObservationRevision,
  );
  const context = useMemo(
    () => captureObservationContext(sessionId, requiresOrigin, revision),
    [sessionId, requiresOrigin, revision],
  );
  const scope = useMemo(
    () => ({ context, stageId, mapId }),
    [context, stageId, mapId],
  );
  const activeScope = useRef<typeof scope | null>(null);
  const post = useCallback(
    (event: ObservedLearningEvent, keepalive = false) => {
      return sendObservedLearningEvent(
        sessionId,
        event,
        keepalive,
        context,
      ).then((saved) => {
        if (
          activeScope.current === scope &&
          isObservationContextCurrent(context) &&
          !saved
        )
          onLogFailure?.();
        return saved;
      });
    },
    [sessionId, context, scope, onLogFailure],
  );
  useEffect(() => {
    if (!sessionId) return;
    const retry = () => {
      if (
        isObservationContextCurrent(context) &&
        (!context.requiresOrigin || context.origin)
      )
        void flush(sessionId, async (path, init) => {
          if (!isObservationContextCurrent(context))
            throw new Error("observation_context_changed");
          const response = await apiFetch(path, init);
          if (!isObservationContextCurrent(context))
            throw new Error("observation_context_changed");
          return response;
        });
    };
    retry();
    window.addEventListener("online", retry);
    window.addEventListener("pageshow", retry);
    const timer = window.setInterval(retry, 15000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", retry);
      window.removeEventListener("pageshow", retry);
    };
  }, [sessionId, context]);
  useEffect(() => {
    if (!enabled || !stageId) return;
    activeScope.current = scope;
    let left = false;
    let visible = document.visibilityState === "visible";
    const observationMapId = mapId ?? undefined;
    const screenEnter = () => {
      if (left) left = false;
      post({
        eventType: "SCREEN_ENTER",
        targetType: "SCREEN",
        stageId,
        ...(observationMapId ? { mapId: observationMapId } : {}),
      });
    };
    const screenLeave = () => {
      if (left) return;
      left = true;
      post(
        {
          eventType: "SCREEN_LEAVE",
          targetType: "SCREEN",
          stageId,
          ...(observationMapId ? { mapId: observationMapId } : {}),
        },
        true,
      );
    };
    const visibilityChanged = () => {
      const nextVisible = document.visibilityState === "visible";
      if (nextVisible === visible) return;
      visible = nextVisible;
      post({
        eventType: nextVisible ? "STAGE_RESUME" : "STAGE_PAUSE",
        targetType: "STAGE",
        stageId,
      });
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && left) screenEnter();
      visible = document.visibilityState === "visible";
    };
    screenEnter();
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pagehide", screenLeave);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      if (activeScope.current === scope) activeScope.current = null;
      screenLeave();
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pagehide", screenLeave);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [enabled, mapId, post, scope, sessionId, stageId]);
  return post;
}
