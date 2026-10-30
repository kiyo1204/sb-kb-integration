import {enqueue,flush} from "./observation-outbox";
import { useEffect } from "react";
import { apiFetch } from "./auth-client";

export type ObservedLearningEvent =
  | {eventType:"FEEDBACK_DISPLAY";targetType:"FEEDBACK";stageId:string;mapId:string}
  | { eventType: "SCREEN_ENTER" | "SCREEN_LEAVE"; targetType: "SCREEN"; stageId: string; mapId?: string }
  | { eventType: "STAGE_PAUSE" | "STAGE_RESUME"; targetType: "STAGE"; stageId: string; mapId?: string }
  | { eventType: "VIDEO_PLAY" | "VIDEO_PAUSE" | "VIDEO_COMPLETE"; targetType: "VIDEO"; stageId: string }
  | { eventType: "VIDEO_SEEK"; targetType: "VIDEO"; stageId: string; details: { fromSeconds: number; toSeconds: number } };

export async function sendObservedLearningEvent(
  sessionId: string,
  event: ObservedLearningEvent,
  keepalive = false,
): Promise<boolean> {
  const visibilityEvent = event.eventType === "STAGE_PAUSE" || event.eventType === "STAGE_RESUME";
  void keepalive;
  try {
    await enqueue(sessionId,{schemaVersion:1,...event,outcome:visibilityEvent?"UNKNOWN":"SUCCESS",...(visibilityEvent?{reasonCode:"UNKNOWN"}:{}),clientTimestamp:new Date().toISOString(),clientTimeQuality:"OBSERVED"});
    return flush(sessionId,apiFetch);
  } catch { return false; }

}

export function useObservedLearningScreen(
  sessionId: string,
  stageId: string | null | undefined,
  mapId: string | null | undefined,
  enabled: boolean,
  onLogFailure?: () => void,
) {
  useEffect(()=>{
    if(!sessionId)return;
    const retry=()=>{void flush(sessionId,apiFetch);};
    retry();window.addEventListener("online",retry);window.addEventListener("pageshow",retry);
    const timer=window.setInterval(retry,15000);
    return ()=>{window.clearInterval(timer);window.removeEventListener("online",retry);window.removeEventListener("pageshow",retry);};
  },[sessionId]);
  useEffect(() => {
    if (!enabled || !stageId) return;
    let active = true;
    let left = false;
    let visible = document.visibilityState === "visible";
    const observationMapId = mapId ?? undefined;
    const post = (event: ObservedLearningEvent, keepalive = false) => {
      void sendObservedLearningEvent(sessionId, event, keepalive).then(saved => {
        if (active && !saved) onLogFailure?.();
      });
    };
    const screenEnter = () => {
      if (left) left = false;
      post({ eventType: "SCREEN_ENTER", targetType: "SCREEN", stageId, ...(observationMapId ? { mapId: observationMapId } : {}) });
    };
    const screenLeave = () => {
      if (left) return;
      left = true;
      post({ eventType: "SCREEN_LEAVE", targetType: "SCREEN", stageId, ...(observationMapId ? { mapId: observationMapId } : {}) }, true);
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
      screenLeave();
      active = false;
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pagehide", screenLeave);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [enabled, mapId, onLogFailure, sessionId, stageId]);
}
