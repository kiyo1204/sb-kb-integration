import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
} from "react";
import { apiFetch, uiText } from "./auth-client";

type Concept = {
  id: string;
  label: string;
  positionX: number;
  positionY: number;
  createdAt: string;
  updatedAt: string;
  isMergeResult?: boolean;
};

type MergeConceptResponse = {
  concept: Concept & { mapId: string };
  mergedConceptIds: string[];
  incidentLinks: MapLink[];
};

type MapLink = {
  id: string;
  mapId: string;
  sourceConceptId: string;
  targetConceptId: string;
  label: string;
  kitLinkItemId?: string | null;
};

type KitLinkItem = {
  kitLinkItemId: string;
  label: string;
  used: boolean;
};

type KitConceptItem = {
  kitConceptItemId: string;
  label: string;
  imported: boolean;
};

type KitPalettePart =
  | { kind: "concept"; itemId: string; label: string }
  | { kind: "link"; itemId: string; label: string };

type TemporaryConnector = {
  id: string;
  kind: "kit" | "map";
  kitLinkItemId: string | null;
  label: string;
  position: Point;
  sourceConceptId: string | null;
  targetConceptId: string | null;
  saving: boolean;
  error: string | null;
};

const KIT_PALETTE_MIME = "application/x-kbcm-kit-part";

function createTemporaryId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

type KitDefinitionOption = {
  id: string;
  name: string;
};

type CreatedMapLink = MapLink & { createdAt: string };
type UpdatedMapLink = MapLink & { updatedAt: string };

type LinkEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
};

type NodeSize = { width: number; height: number };
type Point = { x: number; y: number };
type EdgeGeometry = { path: string; labelX: number; labelY: number };

function mapLinksToEdges(
  links: MapLink[],
  concepts: Concept[],
  mapId: string,
): LinkEdge[] {
  const conceptIds = new Set(concepts.map((concept) => concept.id));

  return links.flatMap((link) => {
    if (
      link.mapId !== mapId ||
      !conceptIds.has(link.sourceConceptId) ||
      !conceptIds.has(link.targetConceptId)
    ) {
      if (import.meta.env.DEV) {
        console.warn("Skipping Link with a missing or cross-Map Concept", link);
      }
      return [];
    }

    return [
      {
        id: link.id,
        source: link.sourceConceptId,
        target: link.targetConceptId,
        label: link.label,
      },
    ];
  });
}

function rectangleBoundaryPoint(
  position: ConceptPosition,
  size: NodeSize,
  toward: Point,
): Point {
  const center = {
    x: position.positionX + size.width / 2,
    y: position.positionY + size.height / 2,
  };
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const scale =
    1 /
    Math.max(Math.abs(dx) / (size.width / 2), Math.abs(dy) / (size.height / 2));

  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function getEdgeGeometry(
  edge: LinkEdge,
  offset: number,
  positions: Map<string, ConceptPosition>,
  nodeSizes: Map<string, NodeSize>,
): EdgeGeometry | null {
  const sourcePosition = positions.get(edge.source);
  const targetPosition = positions.get(edge.target);
  const sourceSize = nodeSizes.get(edge.source);
  const targetSize = nodeSizes.get(edge.target);

  if (!sourcePosition || !targetPosition || !sourceSize || !targetSize) {
    return null;
  }

  if (edge.source === edge.target) {
    const left = sourcePosition.positionX;
    const top = sourcePosition.positionY;
    const bottom = top + sourceSize.height;
    const start = { x: left + sourceSize.width * 0.68, y: bottom };
    const end = { x: left + sourceSize.width * 0.32, y: bottom };
    const path = `M ${start.x} ${start.y} C ${left + sourceSize.width * 0.9} ${bottom + 44}, ${left + sourceSize.width * 0.1} ${bottom + 44}, ${end.x} ${end.y}`;

    return {
      path,
      labelX: left + sourceSize.width / 2,
      labelY: bottom + 34,
    };
  }

  const sourceCenter = {
    x: sourcePosition.positionX + sourceSize.width / 2,
    y: sourcePosition.positionY + sourceSize.height / 2,
  };
  const targetCenter = {
    x: targetPosition.positionX + targetSize.width / 2,
    y: targetPosition.positionY + targetSize.height / 2,
  };

  if (sourceCenter.x === targetCenter.x && sourceCenter.y === targetCenter.y) {
    const bottom = sourcePosition.positionY + sourceSize.height;
    const start = {
      x: sourcePosition.positionX + sourceSize.width * 0.68,
      y: bottom,
    };
    const end = {
      x: sourcePosition.positionX + sourceSize.width * 0.32,
      y: bottom,
    };

    return {
      path: `M ${start.x} ${start.y} C ${start.x + 24} ${bottom + 40}, ${end.x - 24} ${bottom + 40}, ${end.x} ${end.y}`,
      labelX: sourcePosition.positionX + sourceSize.width / 2,
      labelY: bottom + 30,
    };
  }

  const start = rectangleBoundaryPoint(
    sourcePosition,
    sourceSize,
    targetCenter,
  );
  const end = rectangleBoundaryPoint(targetPosition, targetSize, sourceCenter);

  if (offset === 0) {
    return {
      path: `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
      labelX: (start.x + end.x) / 2,
      labelY: (start.y + end.y) / 2 - 9,
    };
  }

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const control = {
    x: (start.x + end.x) / 2 - (dy / length) * offset,
    y: (start.y + end.y) / 2 + (dx / length) * offset,
  };

  return {
    path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
    labelX: (start.x + 2 * control.x + end.x) / 4,
    labelY: (start.y + 2 * control.y + end.y) / 4 - 9,
  };
}

type ConceptPosition = Pick<Concept, "positionX" | "positionY">;

type PositionSaveFeedback = {
  type: "success" | "error" | "saving";
  message: string;
};

type UpdatedConceptPosition = ConceptPosition & {
  id: string;
  mapId: string;
  updatedAt: string;
};

type UpdatedConceptLabel = Concept & { mapId: string };

type LabelEditFeedback = {
  conceptId: string;
  type: "success" | "error" | "saving";
  message: string;
};

type LinkLabelEditFeedback = {
  linkId: string;
  type: "success" | "error" | "saving";
  message: string;
};

type LinkDeleteFeedback = {
  linkId: string;
  type: "error" | "deleting";
  message: string;
};

type LinkReconnectFeedback = {
  linkId: string;
  type: "error" | "saving" | "success";
  message: string;
};

type ConceptDeleteFeedback = {
  conceptId: string;
  message: string;
};

type MapResponse = {
  id: string;
  type: "GOAL" | "PRIOR" | "KB" | "INTEGRATION";
  status: "DRAFT" | "SUBMITTED";
  title: string | null;
  createdAt: string;
  submittedAt: string | null;
  basedOnMapId: string | null;
  kitDefinitionId: string | null;
  kitDefinitionName: string | null;
  sessionStageId: string | null;
  sessionId: string | null;
  sessionStageStatus: string | null;
  sessionProtocolKey: string | null;
  concepts: Concept[];
  links: MapLink[];
  kitLinks: KitLinkItem[];
  kitConcepts: KitConceptItem[];
  availableKitDefinitions: KitDefinitionOption[];
};

export type HistoricalMapSnapshot = {
  mapId: string;
  mapType: "PRIOR" | "KB" | "INTEGRATION";
  concepts: Array<{
    id: string;
    mapId: string;
    label: string;
    positionX: number;
    positionY: number;
    mergedIntoConceptId: string | null;
  }>;
  links: Array<{
    id: string;
    mapId: string;
    sourceConceptId: string;
    targetConceptId: string;
    label: string;
  }>;
};

type SubmittedMapResponse = Pick<
  MapResponse,
  "id" | "type" | "status" | "submittedAt"
>;

type MapEditorSaveStatus = "saved" | "saving" | "error";

type UndoRedoState = {
  mapId: string;
  status: "AVAILABLE" | "UNAVAILABLE" | "PARTIAL";
  sequenceNumber: number;
  canUndo: boolean;
  canRedo: boolean;
  undoOperation: { id: string; operationType: string } | null;
  redoOperation: { id: string; operationType: string } | null;
  reason: string | null;
};

type KitBuildFeedbackResult = {
  configurationComplete: boolean;
  matched: boolean;
  concepts: { matched: number; total: number };
  relations: { matched: number; total: number };
  message: string;
  mapSignature: string;
};

type KitBuildFeedbackState = {
  result: KitBuildFeedbackResult;
  verifiedSignature: string | null;
  requestId: number;
};

type KitFeedbackDialog =
  | { status: "loading" }
  | { status: "result"; fromSubmission: boolean }
  | { status: "error"; message: string };

type KitFeedbackFreshness = "current" | "stale" | "saving" | "unknown";

function kitMapSignature(map: MapResponse): string {
  const byId = (a: { id: string }, b: { id: string }) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return JSON.stringify([
    map.id,
    map.kitDefinitionId,
    [...map.concepts].sort(byId).map(({ id, label }) => [id, label]),
    [...map.links].sort(byId).map(({ id, label, sourceConceptId, targetConceptId }) => [
      id, label, sourceConceptId, targetConceptId,
    ]),
  ]);
}

function isKitBuildFeedback(value: unknown): value is KitBuildFeedbackResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<KitBuildFeedbackResult>;
  return typeof result.configurationComplete === "boolean" &&
    typeof result.matched === "boolean" && typeof result.message === "string" &&
    typeof result.mapSignature === "string" &&
    Number.isInteger(result.concepts?.matched) && Number.isInteger(result.concepts?.total) &&
    Number.isInteger(result.relations?.matched) && Number.isInteger(result.relations?.total);
}

type LoadState =
  | { status: "loading" }
  | { status: "success"; map: MapResponse }
  | {
      status: "stage-blocked";
      sessionId: string;
      currentStageType: string | null;
    }
  | { status: "not-found" }
  | { status: "error"; message: string };

type SessionFlowResponse = {
  session: { status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED"; protocolKey: string; groupActivitySeconds: number | null };
  serverNow: string;
  currentStage: { id: string; stageType: string; startedAt: string | null } | null;
  stages: { id: string; status: "PENDING" | "IN_PROGRESS" | "COMPLETED" }[];
};

function stageDisplayName(type: string) {
  return ({ LESSON: "授業動画", PRIOR_MAP: "Scratch-Build", KB_MAP: "Kit-Build", INTEGRATION_MAP: "統合マップ", PRE_ASSESSMENT: "事前評価", POST_ASSESSMENT: "事後評価", SELF_STUDY: "自主学習" } as Record<string, string>)[type] ?? type;
}

function mapDisplayName(type: MapResponse["type"]) {
  return ({ GOAL: "ゴールマップ", PRIOR: "Scratch-Build マップ", KB: "Kit-Build マップ", INTEGRATION: "統合マップ" })[type];
}

export default function MapPage({
  mapId,
  isLearner = false,
  learnerSessionId,
}: {
  mapId: string;
  isLearner?: boolean;
  learnerSessionId?: string;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [integrationDeadline, setIntegrationDeadline] = useState<number | null>(null);
  const [kitBuildFeedback, setKitBuildFeedback] =
    useState<KitBuildFeedbackState | null>(null);
  const [kitFeedbackChecking, setKitFeedbackChecking] = useState(false);
  const [kitFeedbackDialog, setKitFeedbackDialog] = useState<KitFeedbackDialog | null>(null);
  const [undoRedoState, setUndoRedoState] = useState<UndoRedoState | null>(null);
  const [undoRedoBusy, setUndoRedoBusy] = useState(false);
  const [undoRedoFeedback, setUndoRedoFeedback] = useState<string | null>(null);
  const [canvasLinkCreation, setCanvasLinkCreation] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [positionSaving, setPositionSaving] = useState(false);
  const [mapEditorSaveStatus, setMapEditorSaveStatus] =
    useState<MapEditorSaveStatus>("saved");
  const [mergingConcepts, setMergingConcepts] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitFeedback, setSubmitFeedback] = useState<
    { type: "success" | "error" | "saving"; message: string } | undefined
  >();
  const [positionFeedback, setPositionFeedback] =
    useState<PositionSaveFeedback | null>(null);
  const mapEditorMutationsRef = useRef({ inFlight: 0, failed: false });
  const undoRedoRequestRef = useRef(0);
  const kitFeedbackRequestRef = useRef(0);
  const kitFeedbackSignature =
    state.status === "success" && state.map.type === "KB"
      ? kitMapSignature(state.map)
      : null;
  const kitFeedbackFreshness: KitFeedbackFreshness =
    kitBuildFeedback &&
    (kitBuildFeedback.result.mapSignature !== kitFeedbackSignature ||
      (kitBuildFeedback.verifiedSignature !== null &&
        kitBuildFeedback.result.mapSignature !== kitBuildFeedback.verifiedSignature))
      ? "stale"
      : mapEditorSaveStatus === "saving" || undoRedoBusy
        ? "saving"
        : mapEditorSaveStatus === "error" || !kitBuildFeedback?.verifiedSignature
          ? "unknown"
          : "current";

  async function fetchCurrentKitMapSignature(targetMapId: string): Promise<string> {
    const response = await apiFetch(`/api/maps/${encodeURIComponent(targetMapId)}/kit-graph-signature`);
    if (!response.ok) throw new Error("マップの状態を確認できませんでした。");
    const result = (await response.json()) as { mapSignature?: unknown };
    if (typeof result.mapSignature !== "string") {
      throw new Error("マップの状態を確認できませんでした。");
    }
    return result.mapSignature;
  }

  async function checkKitBuildFeedback() {
    if (state.status !== "success" || state.map.type !== "KB" || kitFeedbackChecking || submitting) return;
    const targetMapId = state.map.id;
    const requestId = ++kitFeedbackRequestRef.current;
    setKitFeedbackChecking(true);
    setKitFeedbackDialog({ status: "loading" });
    try {
      const response = await apiFetch(`/api/maps/${encodeURIComponent(targetMapId)}/kit-feedback`);
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok || !isKitBuildFeedback(result)) throw new Error("feedback request failed");
      const verifiedSignature = await fetchCurrentKitMapSignature(targetMapId).catch(() => null);
      if (requestId !== kitFeedbackRequestRef.current) return;
      setKitBuildFeedback({ result, verifiedSignature, requestId });
      setKitFeedbackDialog({ status: "result", fromSubmission: false });
    } catch {
      if (requestId === kitFeedbackRequestRef.current) {
        setKitFeedbackDialog({
          status: "error",
          message: "一致状況を確認できませんでした。接続を確認してもう一度お試しください。",
        });
      }
    } finally {
      if (requestId === kitFeedbackRequestRef.current) setKitFeedbackChecking(false);
    }
  }

  const reloadUndoRedoState = useCallback(
    async (targetMapId = mapId) => {
      const requestNumber = ++undoRedoRequestRef.current;
      try {
        const response = await apiFetch(
          `/api/maps/${encodeURIComponent(targetMapId)}/undo-redo`,
        );
        if (!response.ok) {
          if (requestNumber === undoRedoRequestRef.current) setUndoRedoState(null);
          return null;
        }
        const next = (await response.json()) as UndoRedoState;
        if (requestNumber === undoRedoRequestRef.current) setUndoRedoState(next);
        return next;
      } catch {
        if (requestNumber === undoRedoRequestRef.current) setUndoRedoState(null);
        return null;
      }
    },
    [mapId],
  );

  async function trackMapEditorMutation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const tracking = mapEditorMutationsRef.current;
    if (tracking.inFlight === 0) tracking.failed = false;
    tracking.inFlight += 1;
    setMapEditorSaveStatus("saving");

    try {
      const result = await operation();
      await reloadUndoRedoState();
      return result;
    } catch (error) {
      tracking.failed = true;
      throw error;
    } finally {
      tracking.inFlight -= 1;
      if (tracking.inFlight === 0) {
        setMapEditorSaveStatus(tracking.failed ? "error" : "saved");
      }
    }
  }

  async function reloadMapFromServer() {
    const response = await apiFetch(`/api/maps/${encodeURIComponent(mapId)}`);
    if (!response.ok) throw new Error("Map refresh failed");

    const map = (await response.json()) as MapResponse;
    setState({ status: "success", map });
    await reloadUndoRedoState(map.id);
    return map;
  }

  async function performUndoRedo(action: "UNDO" | "REDO") {
    const currentMap = state.status === "success" ? state.map : null;
    const candidate =
      action === "UNDO" ? undoRedoState?.undoOperation : undoRedoState?.redoOperation;
    if (
      !currentMap ||
      ! ["STAGE1_4", "STAGE1_6"].includes(currentMap.sessionProtocolKey ?? "") ||
      (currentMap.type !== "PRIOR" &&
        currentMap.type !== "KB" &&
        currentMap.type !== "INTEGRATION") ||
      currentMap.status !== "DRAFT" ||
      !candidate ||
      undoRedoBusy ||
      mapEditorMutationsRef.current.inFlight > 0 ||
      positionSaving ||
      mergingConcepts ||
      submitting ||
      !undoRedoState
    ) {
      return;
    }

    setUndoRedoBusy(true);
    setUndoRedoFeedback(null);
    setMapEditorSaveStatus("saving");
    try {
      const response = await apiFetch(
        `/api/maps/${encodeURIComponent(currentMap.id)}/undo-redo`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            expectedSequenceNumber: undoRedoState.sequenceNumber,
            idempotencyKey: crypto.randomUUID(),
            clientTimestamp: new Date().toISOString(),
          }),
        },
      );
      const result = (await response.json().catch(() => null)) as {
        state?: UndoRedoState;
        error?: string;
      } | null;
      if (!response.ok) {
        if (result?.state) setUndoRedoState(result.state);
        await reloadMapFromServer().catch(() => undefined);
        setUndoRedoFeedback(
          response.status === 409
            ? "履歴が更新されました。現在のマップを再取得しました。"
            : "操作を適用できませんでした。現在のマップを再取得しました。",
        );
        return;
      }
      if (result?.state) setUndoRedoState(result.state);
      await reloadMapFromServer();
      setUndoRedoFeedback(action === "UNDO" ? "操作を元に戻しました。" : "操作をやり直しました。");
    } catch {
      await reloadMapFromServer().catch(() => undefined);
      setUndoRedoFeedback("Undo/Redoの結果を確認できませんでした。マップを再読み込みしてください。");
    } finally {
      setUndoRedoBusy(false);
      setMapEditorSaveStatus("saved");
    }
  }

  async function submitMap() {
    if (
      state.status !== "success" ||
      (state.map.type !== "PRIOR" &&
        state.map.type !== "KB" &&
        state.map.type !== "INTEGRATION") ||
      state.map.status !== "DRAFT" ||
      (state.map.type === "INTEGRATION" && state.map.sessionProtocolKey === "STAGE1_6") ||
      submitting ||
      positionSaving ||
      mergingConcepts
    ) {
      return;
    }

    const mapLabel =
      state.map.type === "KB"
        ? "KB マップ"
        : state.map.type === "INTEGRATION"
          ? "統合マップ"
          : "学習者マップ（Scratch-Build）";
    if (
      !window.confirm(`提出後はこの${mapLabel}を編集できません。提出しますか？`)
    ) {
      return;
    }

    const submissionFeedbackRequestId = ++kitFeedbackRequestRef.current;
    setKitFeedbackChecking(false);
    setSubmitting(true);
    setSubmitFeedback({ type: "saving", message: `${mapLabel}を提出中…` });

    try {
      const response = await apiFetch(
        `/api/maps/${encodeURIComponent(state.map.id)}/submit`,
        { method: "POST" },
      );

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as {
          error?: unknown;
          message?: unknown;
          feedback?: unknown;
        } | null;
        const message =
          response.status === 404
            ? "マップが見つからないため、提出できませんでした。"
            : response.status === 409 && typeof errorBody?.message !== "string"
              ? `この${mapLabel}は既に提出されています。状態を再取得しました。`
              : typeof errorBody?.message === "string"
                ? uiText(errorBody.message)
                : `${mapLabel}を提出できませんでした。時間をおいて再度お試しください。`;

        if (response.status === 409 && errorBody?.error === "kit_build_not_matched" &&
            isKitBuildFeedback(errorBody.feedback)) {
          await reloadMapFromServer().catch(() => null);
          const verifiedSignature = await fetchCurrentKitMapSignature(state.map.id).catch(() => null);
          setKitBuildFeedback({
            result: errorBody.feedback,
            verifiedSignature,
            requestId: submissionFeedbackRequestId,
          });
          setKitFeedbackDialog({ status: "result", fromSubmission: true });
        } else if (response.status === 409 && errorBody?.error === "kit_build_not_matched") {
          setKitFeedbackDialog({ status: "error", message: "提出時の一致状況を確認できませんでした。もう一度お試しください。" });
        } else if (response.status === 409) {
          await reloadMapFromServer().catch(() => undefined);
        }
        setSubmitFeedback({ type: "error", message });
        return;
      }

      const submittedMap = (await response.json()) as SubmittedMapResponse;
      if (
        submittedMap.id !== state.map.id ||
        submittedMap.type !== state.map.type ||
        submittedMap.status !== "SUBMITTED" ||
        typeof submittedMap.submittedAt !== "string"
      ) {
        throw new Error(
          "提出結果を確認できませんでした。マップを再読み込みしてください。",
        );
      }

      if (isLearner && learnerSessionId) {
        setState({ status: "loading" });
        window.location.replace(`/sessions/${encodeURIComponent(learnerSessionId)}`);
        return;
      }

      setState((current) =>
        current.status === "success" && current.map.id === submittedMap.id
          ? {
              status: "success",
              map: {
                ...current.map,
                status: submittedMap.status,
                submittedAt: submittedMap.submittedAt,
              },
            }
          : current,
      );
      setSubmitFeedback({
        type: "success",
        message: `${mapLabel}を提出しました。以後は読み取り専用です。`,
      });
    } catch (error) {
      await reloadMapFromServer().catch(() => undefined);
      setSubmitFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : `${mapLabel}を提出できませんでした。マップを再読み込みしてください。`,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function saveConceptPosition(
    conceptId: string,
    position: ConceptPosition,
    originalPosition: ConceptPosition,
  ): Promise<ConceptPosition | null> {
    setPositionSaving(true);
    setPositionFeedback({ type: "saving", message: "位置を保存中…" });

    try {
      const response = await apiFetch(
        `/api/concepts/${encodeURIComponent(conceptId)}/position`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...position,
            clientTimestamp: new Date().toISOString(),
          }),
        },
      );

      if (!response.ok) {
        const message =
          response.status === 404
            ? "Conceptが見つからないため、位置を保存できませんでした。"
            : response.status === 400
              ? "座標が正しくないため、位置を保存できませんでした。"
              : "Conceptの位置を保存できませんでした。";

        try {
          const latestMap = await reloadMapFromServer();
          const latestConcept = latestMap.concepts.find(
            (concept) => concept.id === conceptId,
          );
          setPositionFeedback({
            type: "error",
            message: `${message} サーバーから位置を再取得しました。`,
          });
          return latestConcept
            ? {
                positionX: latestConcept.positionX,
                positionY: latestConcept.positionY,
              }
            : null;
        } catch {
          setPositionFeedback({
            type: "error",
            message: `${message} 表示をドラッグ前の位置へ戻します。`,
          });
          return originalPosition;
        }
      }

      const updated = (await response.json()) as UpdatedConceptPosition;
      if (
        updated.id !== conceptId ||
        updated.mapId !== mapId ||
        !Number.isFinite(updated.positionX) ||
        !Number.isFinite(updated.positionY)
      ) {
        throw new Error("Unexpected position response");
      }

      setState((current) =>
        current.status === "success"
          ? {
              status: "success",
              map: {
                ...current.map,
                concepts: current.map.concepts.map((concept) =>
                  concept.id === conceptId
                    ? {
                        ...concept,
                        positionX: updated.positionX,
                        positionY: updated.positionY,
                        updatedAt: updated.updatedAt,
                      }
                    : concept,
                ),
              },
            }
          : current,
      );
      await reloadUndoRedoState(mapId);
      setPositionFeedback({
        type: "success",
        message: "Conceptの位置を保存しました。",
      });
      return {
        positionX: updated.positionX,
        positionY: updated.positionY,
      };
    } catch {
      try {
        const latestMap = await reloadMapFromServer();
        const latestConcept = latestMap.concepts.find(
          (concept) => concept.id === conceptId,
        );
        setPositionFeedback({
          type: "error",
          message:
            "保存結果を確認できなかったため、サーバーから位置を再取得しました。",
        });
        return latestConcept
          ? {
              positionX: latestConcept.positionX,
              positionY: latestConcept.positionY,
            }
          : null;
      } catch {
        setPositionFeedback({
          type: "error",
          message:
            "位置を保存できませんでした。表示をドラッグ前へ戻し、ページを再読み込みして状態を確認してください。",
        });
        return originalPosition;
      }
    } finally {
      setPositionSaving(false);
    }
  }

  async function saveConceptLabel(conceptId: string, label: string) {
    const response = await apiFetch(
      `/api/concepts/${encodeURIComponent(conceptId)}/label`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          clientTimestamp: new Date().toISOString(),
        }),
      },
    );

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      const message =
        response.status === 404
          ? "Conceptが見つからないため、labelを保存できませんでした。"
          : typeof errorBody?.message === "string"
            ? uiText(errorBody.message)
            : "Conceptのlabelを保存できませんでした。時間をおいて再度お試しください。";

      throw new Error(message);
    }

    const updated = (await response.json()) as UpdatedConceptLabel;
    if (
      updated.id !== conceptId ||
      updated.mapId !== mapId ||
      updated.label !== label
    ) {
      throw new Error(
        "保存結果を確認できませんでした。マップを再読み込みして状態を確認してください。",
      );
    }

    setState((current) =>
      current.status === "success"
        ? {
            status: "success",
            map: {
              ...current.map,
              concepts: current.map.concepts.map((concept) =>
                concept.id === conceptId
                  ? {
                      ...concept,
                      label: updated.label,
                      updatedAt: updated.updatedAt,
                    }
                  : concept,
              ),
            },
          }
        : current,
    );
  }

  async function deleteConcept(conceptId: string) {
    const response = await apiFetch(
      `/api/concepts/${encodeURIComponent(conceptId)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientTimestamp: new Date().toISOString() }),
      },
    );

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      const message =
        response.status === 404
          ? "Conceptが見つからないため、削除できませんでした。マップを再読み込みしてください。"
          : typeof errorBody?.message === "string"
            ? uiText(errorBody.message)
            : "Conceptを削除できませんでした。時間をおいて再度お試しください。";

      throw new Error(message);
    }

    const deleted = (await response.json()) as { id?: unknown };
    if (deleted.id !== conceptId) {
      throw new Error(
        "削除結果を確認できませんでした。マップを再読み込みして状態を確認してください。",
      );
    }

    setState((current) =>
      current.status === "success"
        ? {
            status: "success",
            map: {
              ...current.map,
              concepts: current.map.concepts.filter(
                (concept) => concept.id !== conceptId,
              ),
              links: current.map.links.filter(
                (link) =>
                  link.sourceConceptId !== conceptId &&
                  link.targetConceptId !== conceptId,
              ),
            },
          }
        : current,
    );
  }

  async function mergeConcepts(
    targetMapId: string,
    conceptIds: [string, string],
    label: string,
  ) {
    setMergingConcepts(true);

    try {
      const response = await apiFetch(
        `/api/maps/${encodeURIComponent(targetMapId)}/concepts/merge`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conceptIds,
            label,
            clientTimestamp: new Date().toISOString(),
          }),
        },
      );

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as {
          message?: unknown;
        } | null;
        throw new Error(
          typeof errorBody?.message === "string"
            ? uiText(errorBody.message)
            : "ConceptをMergeできませんでした。マップを再読み込みしてください。",
        );
      }

      const result = (await response.json()) as MergeConceptResponse;
      const expectedIds = new Set(conceptIds);
      const returnedIds = new Set(result.mergedConceptIds);
      const validResult =
        result.concept.mapId === targetMapId &&
        !expectedIds.has(result.concept.id) &&
        result.concept.label === label &&
        result.concept.isMergeResult === true &&
        Number.isFinite(result.concept.positionX) &&
        Number.isFinite(result.concept.positionY) &&
        typeof result.concept.createdAt === "string" &&
        typeof result.concept.updatedAt === "string" &&
        returnedIds.size === expectedIds.size &&
        [...expectedIds].every((id) => returnedIds.has(id)) &&
        Array.isArray(result.incidentLinks) &&
        result.incidentLinks.every(
          (link) =>
            link.mapId === targetMapId &&
            typeof link.id === "string" &&
            typeof link.sourceConceptId === "string" &&
            typeof link.targetConceptId === "string" &&
            typeof link.label === "string",
        );

      if (!validResult) {
        throw new Error(
          "Merge結果を確認できませんでした。マップを再読み込みしてください。",
        );
      }

      const updatedLinksById = new Map(
        result.incidentLinks.map((link) => [link.id, link]),
      );
      setState((current) =>
        current.status === "success" && current.map.id === targetMapId
          ? {
              status: "success",
              map: {
                ...current.map,
                concepts: [
                  ...current.map.concepts.filter(
                    (concept) => !expectedIds.has(concept.id),
                  ),
                  result.concept,
                ],
                links: current.map.links.map((link) => {
                  const updated = updatedLinksById.get(link.id);
                  return updated
                    ? {
                        ...link,
                        sourceConceptId: updated.sourceConceptId,
                        targetConceptId: updated.targetConceptId,
                      }
                    : link;
                }),
              },
            }
          : current,
      );

      await reloadMapFromServer().catch(() => undefined);
    } catch (error) {
      await reloadMapFromServer().catch(() => undefined);
      throw error instanceof Error
        ? error
        : new Error(
            "ConceptをMergeできませんでした。マップを再読み込みしてください。",
          );
    } finally {
      setMergingConcepts(false);
    }
  }

  async function createMapConcept(targetMapId: string, label: string) {
    const currentMap =
      state.status === "success" && state.map.id === targetMapId
        ? state.map
        : null;
    if (
      !currentMap ||
      (currentMap.type !== "PRIOR" && currentMap.type !== "INTEGRATION")
    ) {
      throw new Error("マップを読み込んでからConceptを追加してください。");
    }

    const response = await apiFetch(
      `/api/maps/${encodeURIComponent(targetMapId)}/concepts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          ...(currentMap.type === "INTEGRATION"
            ? getNextPosition(currentMap.concepts)
            : getInitialConceptPosition(currentMap.concepts)),
          clientTimestamp: new Date().toISOString(),
        }),
      },
    );

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      throw new Error(
        response.status === 404
          ? "マップが見つからないため、Conceptを保存できませんでした。"
          : typeof errorBody?.message === "string"
            ? uiText(errorBody.message)
            : "Conceptを保存できませんでした。時間をおいて再度お試しください。",
      );
    }

    const created = (await response.json()) as Concept;
    if (
      typeof created.id !== "string" ||
      created.label !== label ||
      !Number.isFinite(created.positionX) ||
      !Number.isFinite(created.positionY) ||
      typeof created.createdAt !== "string" ||
      typeof created.updatedAt !== "string"
    ) {
      throw new Error(
        "保存結果を確認できませんでした。マップを再読み込みして状態を確認してください。",
      );
    }

    setState((current) =>
      current.status === "success" && current.map.id === targetMapId
        ? {
            status: "success",
            map: {
              ...current.map,
              concepts: [...current.map.concepts, created],
            },
          }
        : current,
    );
    return created;
  }

  async function createLink(
    targetMapId: string,
    sourceConceptId: string,
    targetConceptId: string,
    label: string,
  ): Promise<string> {
    const response = await apiFetch(
      `/api/maps/${encodeURIComponent(targetMapId)}/links`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceConceptId,
          targetConceptId,
          label,
          clientTimestamp: new Date().toISOString(),
        }),
      },
    );

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      const message =
        response.status === 404
          ? "マップまたは選択したConceptが見つかりません。マップを再読み込みしてください。"
          : response.status === 422
            ? "sourceとtargetはこのマップ内のConceptを選んでください。"
            : typeof errorBody?.message === "string"
              ? uiText(errorBody.message)
              : "Linkを保存できませんでした。時間をおいて再度お試しください。";

      throw new Error(message);
    }

    const created = (await response.json()) as CreatedMapLink;
    if (
      typeof created.id !== "string" ||
      created.mapId !== targetMapId ||
      created.sourceConceptId !== sourceConceptId ||
      created.targetConceptId !== targetConceptId ||
      created.label !== label ||
      typeof created.createdAt !== "string"
    ) {
      throw new Error(
        "保存結果を確認できませんでした。マップを再読み込みして状態を確認してください。",
      );
    }

    setState((current) =>
      current.status === "success" && current.map.id === targetMapId
        ? {
            status: "success",
            map: {
              ...current.map,
              links: [...current.map.links, created],
            },
          }
        : current,
    );
    return created.id;
  }

  async function reconstructKitLink(
    targetMapId: string,
    kitLinkItemId: string,
    sourceConceptId: string,
    targetConceptId: string,
  ): Promise<string> {
    const kitLink =
      state.status === "success" && state.map.id === targetMapId
        ? state.map.kitLinks.find(
            (item) => item.kitLinkItemId === kitLinkItemId,
          )
        : undefined;
    if (!kitLink || kitLink.used) {
      throw new Error(
        "未使用のKit Linkを選択してください。マップを再読み込みしてください。",
      );
    }

    const response = await apiFetch(
      `/api/maps/${encodeURIComponent(targetMapId)}/kit-links/${encodeURIComponent(kitLinkItemId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceConceptId,
          targetConceptId,
          clientTimestamp: new Date().toISOString(),
        }),
      },
    );

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      throw new Error(
        typeof errorBody?.message === "string"
          ? uiText(errorBody.message)
          : "Kit LinkからLinkを作成できませんでした。マップを再読み込みしてください。",
      );
    }

    const created = (await response.json()) as CreatedMapLink & {
      kitLinkItemId?: unknown;
    };
    if (
      typeof created.id !== "string" ||
      created.mapId !== targetMapId ||
      created.sourceConceptId !== sourceConceptId ||
      created.targetConceptId !== targetConceptId ||
      created.label !== kitLink.label ||
      created.kitLinkItemId !== kitLinkItemId ||
      typeof created.createdAt !== "string"
    ) {
      throw new Error(
        "保存結果を確認できませんでした。マップを再読み込みして状態を確認してください。",
      );
    }

    setState((current) =>
      current.status === "success" && current.map.id === targetMapId
        ? {
            status: "success",
            map: {
              ...current.map,
              links: [...current.map.links, created],
              kitLinks: current.map.kitLinks.map((item) =>
                item.kitLinkItemId === kitLinkItemId
                  ? { ...item, used: true }
                  : item,
              ),
            },
          }
        : current,
    );
    return created.id;
  }

  async function importKitLink(
    targetMapId: string,
    kitLinkItemId: string,
    sourceConceptId: string,
    targetConceptId: string,
  ): Promise<string> {
    if (
      state.status !== "success" ||
      state.map.type !== "INTEGRATION"
    ) {
      throw new Error("Kit Importに対応したマップを読み込んでください。");
    }
    const kitLink = state.map.kitLinks.find(
      (item) => item.kitLinkItemId === kitLinkItemId,
    );
    if (!kitLink || kitLink.used) {
      throw new Error(
        "未ImportのKit Linkを選択してください。マップを再読み込みしてください。",
      );
    }

    const response = await apiFetch(
      `/api/maps/${encodeURIComponent(targetMapId)}/kit-links/${encodeURIComponent(kitLinkItemId)}/import`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceConceptId,
          targetConceptId,
          clientTimestamp: new Date().toISOString(),
        }),
      },
    );

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      if (response.status === 409) {
        await reloadMapFromServer().catch(() => undefined);
      }
      throw new Error(
        typeof errorBody?.message === "string"
          ? uiText(errorBody.message)
          : "Kit LinkをImportできませんでした。マップを再読み込みしてください。",
      );
    }

    const created = (await response.json()) as CreatedMapLink & {
      kitLinkItemId?: unknown;
    };
    if (
      typeof created.id !== "string" ||
      created.mapId !== targetMapId ||
      created.sourceConceptId !== sourceConceptId ||
      created.targetConceptId !== targetConceptId ||
      created.label !== kitLink.label ||
      created.kitLinkItemId !== kitLinkItemId ||
      typeof created.createdAt !== "string"
    ) {
      await reloadMapFromServer().catch(() => undefined);
      throw new Error(
        "Import結果を確認できませんでした。マップを再読み込みして状態を確認してください。",
      );
    }

    setState((current) =>
      current.status === "success" && current.map.id === targetMapId
        ? {
            status: "success",
            map: {
              ...current.map,
              links: [...current.map.links, created],
              kitLinks: current.map.kitLinks.map((item) =>
                item.kitLinkItemId === kitLinkItemId
                  ? { ...item, used: true }
                  : item,
              ),
            },
          }
        : current,
    );
    return created.id;
  }

  async function saveLinkLabel(link: MapLink, label: string) {
    const response = await apiFetch(
      `/api/links/${encodeURIComponent(link.id)}/label`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          clientTimestamp: new Date().toISOString(),
        }),
      },
    );

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      const message =
        response.status === 404
          ? "Linkが見つからないため、labelを保存できませんでした。マップを再読み込みしてください。"
          : typeof errorBody?.message === "string"
            ? uiText(errorBody.message)
            : "Link labelを保存できませんでした。時間をおいて再度お試しください。";

      throw new Error(message);
    }

    const updated = (await response.json()) as UpdatedMapLink;
    if (
      updated.id !== link.id ||
      updated.mapId !== link.mapId ||
      updated.sourceConceptId !== link.sourceConceptId ||
      updated.targetConceptId !== link.targetConceptId ||
      updated.label !== label ||
      typeof updated.updatedAt !== "string"
    ) {
      throw new Error(
        "保存結果を確認できませんでした。マップを再読み込みして状態を確認してください。",
      );
    }

    setState((current) =>
      current.status === "success"
        ? {
            status: "success",
            map: {
              ...current.map,
              links: current.map.links.map((currentLink) =>
                currentLink.id === link.id
                  ? { ...currentLink, label: updated.label }
                  : currentLink,
              ),
            },
          }
        : current,
    );
  }

  async function reconnectLink(
    link: MapLink,
    sourceConceptId: string,
    targetConceptId: string,
  ) {
    const response = await apiFetch(
      `/api/links/${encodeURIComponent(link.id)}/reconnect`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceConceptId,
          targetConceptId,
          clientTimestamp: new Date().toISOString(),
        }),
      },
    );

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      const message =
        response.status === 404
          ? "LinkまたはConceptが見つからないため、再接続できませんでした。マップを再読み込みしてください。"
          : typeof errorBody?.message === "string"
            ? uiText(errorBody.message)
            : "Linkを再接続できませんでした。時間をおいて再度お試しください。";

      throw new Error(message);
    }

    const updated = (await response.json()) as UpdatedMapLink;
    if (
      updated.id !== link.id ||
      updated.mapId !== link.mapId ||
      updated.sourceConceptId !== sourceConceptId ||
      updated.targetConceptId !== targetConceptId ||
      updated.label !== link.label ||
      typeof updated.updatedAt !== "string"
    ) {
      throw new Error(
        "再接続結果を確認できませんでした。マップを再読み込みして状態を確認してください。",
      );
    }

    setState((current) =>
      current.status === "success"
        ? {
            status: "success",
            map: {
              ...current.map,
              links: current.map.links.map((currentLink) =>
                currentLink.id === link.id
                  ? {
                      ...currentLink,
                      sourceConceptId: updated.sourceConceptId,
                      targetConceptId: updated.targetConceptId,
                    }
                  : currentLink,
              ),
            },
          }
        : current,
    );
  }

  async function deleteLink(linkId: string) {
    const response = await apiFetch(`/api/links/${encodeURIComponent(linkId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientTimestamp: new Date().toISOString() }),
    });

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      const message =
        response.status === 404
          ? "Linkが見つからないため、削除できませんでした。マップを再読み込みしてください。"
          : typeof errorBody?.message === "string"
            ? uiText(errorBody.message)
            : "Linkを削除できませんでした。時間をおいて再度お試しください。";

      throw new Error(message);
    }

    const deleted = (await response.json()) as { id?: unknown };
    if (deleted.id !== linkId) {
      throw new Error(
        "削除結果を確認できませんでした。マップを再読み込みして状態を確認してください。",
      );
    }

    setState((current) => {
      if (current.status !== "success") return current;
      const deletedLink = current.map.links.find((link) => link.id === linkId);
      return {
        status: "success",
        map: {
          ...current.map,
          links: current.map.links.filter((link) => link.id !== linkId),
          kitLinks: deletedLink?.kitLinkItemId
            ? current.map.kitLinks.map((item) =>
                item.kitLinkItemId === deletedLink.kitLinkItemId
                  ? { ...item, used: false }
                  : item,
              )
            : current.map.kitLinks,
        },
      };
    });
  }

  async function assignIntegrationKit(kitDefinitionId: string) {
    if (state.status !== "success" || state.map.type !== "INTEGRATION") {
      throw new Error("統合マップを読み込んでからKitを設定してください。");
    }

    const response = await apiFetch(
      `/api/maps/${encodeURIComponent(state.map.id)}/kit-definition`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kitDefinitionId }),
      },
    );
    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      throw new Error(
        typeof errorBody?.message === "string"
          ? uiText(errorBody.message)
          : "KitDefinitionを設定できませんでした。マップを再読み込みしてください。",
      );
    }

    const assigned = (await response.json()) as {
      mapId?: unknown;
      kitDefinitionId?: unknown;
      kitDefinitionName?: unknown;
    };
    if (
      assigned.mapId !== state.map.id ||
      assigned.kitDefinitionId !== kitDefinitionId ||
      typeof assigned.kitDefinitionName !== "string"
    ) {
      throw new Error(
        "Kit設定の結果を確認できませんでした。マップを再読み込みしてください。",
      );
    }

    await reloadMapFromServer();
  }

  async function importKitConcept(
    kitConceptItemId: string,
    position: ConceptPosition,
  ) {
    if (
      state.status !== "success" ||
      (state.map.type !== "KB" && state.map.type !== "INTEGRATION")
    ) {
      throw new Error("Kit Importに対応したマップを読み込んでください。");
    }
    const targetMapId = state.map.id;
    const response = await apiFetch(
      `/api/maps/${encodeURIComponent(targetMapId)}/kit-concepts/${encodeURIComponent(kitConceptItemId)}/import`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...position,
          clientTimestamp: new Date().toISOString(),
        }),
      },
    );

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      if (response.status === 409) {
        await reloadMapFromServer().catch(() => undefined);
      }
      throw new Error(
        typeof errorBody?.message === "string"
          ? uiText(errorBody.message)
          : "Kit ConceptをImportできませんでした。マップを再読み込みしてください。",
      );
    }

    const created = (await response.json()) as Concept & {
      mapId?: unknown;
      kitConceptItemId?: unknown;
    };
    if (
      created.kitConceptItemId !== kitConceptItemId ||
      created.mapId !== targetMapId ||
      typeof created.id !== "string" ||
      typeof created.label !== "string" ||
      !Number.isFinite(created.positionX) ||
      !Number.isFinite(created.positionY) ||
      typeof created.createdAt !== "string" ||
      typeof created.updatedAt !== "string"
    ) {
      throw new Error(
        "Import結果を確認できませんでした。マップを再読み込みして状態を確認してください。",
      );
    }

    setState((current) =>
      current.status === "success" && current.map.id === targetMapId
        ? {
            status: "success",
            map: {
              ...current.map,
              concepts: [...current.map.concepts, created],
              kitConcepts: current.map.kitConcepts.map((item) =>
                item.kitConceptItemId === kitConceptItemId
                  ? { ...item, imported: true }
                  : item,
              ),
            },
          }
        : current,
    );
  }

  useEffect(() => {
    const controller = new AbortController();

    async function loadMap() {
      setState({ status: "loading" });

      try {
        const response = await apiFetch(`/api/maps/${encodeURIComponent(mapId)}`, {
          signal: controller.signal,
        });

        if (response.status === 404) {
          if (isLearner && learnerSessionId) {
            window.location.replace(`/sessions/${encodeURIComponent(learnerSessionId)}`);
            return;
          }
          setState({ status: "not-found" });
          return;
        }

        if (!response.ok) {
          setState({
            status: "error",
            message:
              response.status === 400
                ? "マップ IDの形式が正しくありません。"
                : "マップを読み込めませんでした。時間をおいて再度お試しください。",
          });
          return;
        }

        const map = (await response.json()) as MapResponse;
        if (map.sessionStageId && map.sessionId) {
          const flowRequestedAt = performance.now();
          const flowResponse = await apiFetch(
            `/api/sessions/${encodeURIComponent(map.sessionId)}/flow`,
            { signal: controller.signal },
          );
          if (!flowResponse.ok) throw new Error("Session flow refresh failed");
          const flow = (await flowResponse.json()) as SessionFlowResponse;
          if (isLearner && map.type === "INTEGRATION" && flow.session.protocolKey === "STAGE1_6" && flow.currentStage?.id === map.sessionStageId && flow.currentStage.startedAt && flow.session.groupActivitySeconds !== null) {
            const deadline = flowRequestedAt + Date.parse(flow.currentStage.startedAt) + flow.session.groupActivitySeconds * 1000 - Date.parse(flow.serverNow);
            if (deadline <= performance.now()) {
              window.location.replace(`/sessions/${encodeURIComponent(learnerSessionId ?? map.sessionId)}`);
              return;
            }
            setIntegrationDeadline(deadline);
          }
          const stage = flow.stages.find(
            (item) => item.id === map.sessionStageId,
          );
          const submittedPastStage =
            map.status === "SUBMITTED" && stage?.status === "COMPLETED";
          const currentStageIsActive =
            flow.session.status === "IN_PROGRESS" &&
            flow.currentStage?.id === map.sessionStageId &&
            stage?.status === "IN_PROGRESS";
          if (!submittedPastStage && !currentStageIsActive) {
            setState({
              status: "stage-blocked",
              sessionId: map.sessionId,
              currentStageType: flow.currentStage?.stageType ?? null,
            });
            return;
          }
        }
        setState({ status: "success", map });
        await reloadUndoRedoState(map.id);
      } catch {
        if (!controller.signal.aborted) {
          setState({
            status: "error",
            message:
              "APIに接続できません。Docker Composeの状態を確認してください。",
          });
        }
      }
    }

    void loadMap();
    return () => controller.abort();
  }, [mapId, reloadUndoRedoState, isLearner, learnerSessionId]);

  useEffect(() => {
    if (!isLearner || !learnerSessionId || integrationDeadline === null) return;
    const leave = () => {
      setState({ status: "loading" });
      window.location.replace(`/sessions/${encodeURIComponent(learnerSessionId)}`);
    };
    const timer = window.setTimeout(leave, Math.max(0, integrationDeadline - performance.now()));
    const onVisible = () => { if (performance.now() >= integrationDeadline) leave(); };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", onVisible); document.removeEventListener("visibilitychange", onVisible); };
  }, [integrationDeadline, isLearner, learnerSessionId]);

  const isSubmittedMap = state.status === "success" && state.map.status === "SUBMITTED";

  useEffect(() => {
    if (!isLearner || !learnerSessionId || state.status !== "success") return;
    const controller = new AbortController();
    let checking = false;
    function leaveMap() {
      setState({ status: "loading" });
      window.location.replace(`/sessions/${encodeURIComponent(learnerSessionId!)}`);
    }
    async function checkAccess() {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      try {
        const response = await apiFetch(`/api/maps/${encodeURIComponent(mapId)}/access`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!controller.signal.aborted && !response.ok && (isSubmittedMap || [401, 403, 404].includes(response.status))) {
          leaveMap();
        }
      } catch {
        if (!controller.signal.aborted && isSubmittedMap) leaveMap();
      } finally {
        checking = false;
      }
    }
    const interval = window.setInterval(() => void checkAccess(), 5000);
    const recheck = () => void checkAccess();
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [isLearner, learnerSessionId, mapId, state.status, isSubmittedMap]);

  const checkedKitMapId = state.status === "success" && state.map.type === "KB"
    ? state.map.id : null;
  const checkedFeedbackSignature = kitBuildFeedback?.result.mapSignature;
  const checkedFeedbackRequestId = kitBuildFeedback?.requestId;
  useEffect(() => {
    if (!checkedKitMapId || !checkedFeedbackSignature || checkedFeedbackRequestId === undefined) return;
    const controller = new AbortController();
    let checking = false;
    async function refreshGraphSignature() {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      let signature: string | null = null;
      try {
        const response = await apiFetch(`/api/maps/${encodeURIComponent(checkedKitMapId!)}/kit-graph-signature`, {
          signal: controller.signal,
        });
        if (response.ok) {
          const result = (await response.json()) as { mapSignature?: unknown };
          if (typeof result.mapSignature === "string") signature = result.mapSignature;
        }
      } catch {
        // Without a graph signature, the previous result cannot be called current.
      } finally {
        checking = false;
      }
      if (!controller.signal.aborted) {
        setKitBuildFeedback((current) =>
          current && current.requestId === checkedFeedbackRequestId &&
          current.verifiedSignature !== signature
            ? { ...current, verifiedSignature: signature }
            : current,
        );
      }
    }
    const interval = window.setInterval(() => void refreshGraphSignature(), 5000);
    const recheck = () => void refreshGraphSignature();
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [checkedKitMapId, checkedFeedbackSignature, checkedFeedbackRequestId]);

  if (state.status === "loading") {
    return (
      <MapPageFrame>
        <p className="map-message" role="status" aria-live="polite">
          マップを読み込んでいます…
        </p>
      </MapPageFrame>
    );
  }

  if (state.status === "not-found") {
    return (
      <MapPageFrame>
        <section className="map-message is-error" role="alert">
          <h2>マップが見つかりません</h2>
          <p>指定されたIDのマップは存在しません。</p>
        </section>
      </MapPageFrame>
    );
  }

  if (state.status === "stage-blocked") {
    return (
      <MapPageFrame>
        <section className="map-message" role="status">
          <h2>この活動はまだ開けません</h2>
          <p>
            セッション画面から現在の活動を開始してください。
            {!isLearner && state.currentStageType
              ? ` 現在の活動: ${stageDisplayName(state.currentStageType)}`
              : null}
          </p>
          <a className="back-link" href={`/sessions/${state.sessionId}`}>
            セッション画面へ
          </a>
        </section>
      </MapPageFrame>
    );
  }

  if (state.status === "error") {
    return (
      <MapPageFrame>
        <section className="map-message is-error" role="alert">
          <h2>読み込みエラー</h2>
          <p>{state.message}</p>
        </section>
      </MapPageFrame>
    );
  }

  const isReadOnlyPriorMap =
    state.map.type === "PRIOR" && state.map.status === "SUBMITTED";
  const isReadOnlyKBMap =
    state.map.type === "KB" && state.map.status === "SUBMITTED";
  const isReadOnlyIntegrationMap =
    state.map.type === "INTEGRATION" && state.map.status === "SUBMITTED";
  const isRegisteredGoalMap =
    state.map.type === "GOAL" && state.map.kitDefinitionId !== null;
  const isReadOnlyMap =
    isReadOnlyPriorMap ||
    isReadOnlyKBMap ||
    isReadOnlyIntegrationMap ||
    isRegisteredGoalMap;
  const isKBMap = state.map.type === "KB";
  const isIntegrationMap = state.map.type === "INTEGRATION";
  const canEditConceptStructure = !isReadOnlyMap && !isKBMap;
  const canEditLinkLabel = !isReadOnlyMap && !isKBMap;
  const showIntegrationKitAssignment =
    isIntegrationMap && state.map.kitDefinitionId === null;
  const showIntegrationMerge = isIntegrationMap && state.map.status === "DRAFT";
  const integrationEditorSupplement =
    showIntegrationKitAssignment || showIntegrationMerge ? (
      <div className="map-editor-supplement-grid">
        {showIntegrationKitAssignment && (
          <IntegrationKitAssignmentPanel
            availableKitDefinitions={state.map.availableKitDefinitions}
            disabled={
              positionSaving ||
              submitting ||
              mergingConcepts ||
              state.map.status !== "DRAFT"
            }
            onAssignKit={(kitDefinitionId) =>
              trackMapEditorMutation(() =>
                assignIntegrationKit(kitDefinitionId),
              )
            }
          />
        )}
        {showIntegrationMerge && (
          <IntegrationConceptMergeForm
            concepts={state.map.concepts}
            disabled={positionSaving || submitting || mergingConcepts}
            onMerge={(conceptIds, label) =>
              trackMapEditorMutation(() =>
                mergeConcepts(state.map.id, conceptIds, label),
              )
            }
          />
        )}
      </div>
    ) : null;

  if (
    state.map.type === "PRIOR" ||
    state.map.type === "KB" ||
    state.map.type === "INTEGRATION"
  ) {
    return (
      <MapEditorShell
        map={state.map}
        isLearner={isLearner && state.map.sessionId !== null}
        readOnly={
          isReadOnlyMap || submitting || (isIntegrationMap && mergingConcepts)
        }
        canCreateConcept={!isKBMap}
        canCreateLink={!isKBMap}
        canEditConceptStructure={canEditConceptStructure}
        canEditLinkLabel={canEditLinkLabel}
        submitting={submitting}
        positionSaving={positionSaving}
        positionFeedback={positionFeedback}
        saveStatus={mapEditorSaveStatus}
        submitFeedback={submitFeedback}
        kitBuildFeedback={isKBMap ? kitBuildFeedback : null}
        kitFeedbackFreshness={kitFeedbackFreshness}
        kitFeedbackChecking={kitFeedbackChecking}
        kitFeedbackDialog={kitFeedbackDialog}
        onCheckKitFeedback={checkKitBuildFeedback}
        onShowKitFeedback={() => setKitFeedbackDialog({ status: "result", fromSubmission: false })}
        onCloseKitFeedback={() => setKitFeedbackDialog(null)}
        canSubmit={
          ["STAGE1_4", "STAGE1_6"].includes(state.map.sessionProtocolKey ?? "") &&
          state.map.sessionStageStatus === "IN_PROGRESS"
        }
        supplementalContent={integrationEditorSupplement}
        additionalBusy={mergingConcepts || undoRedoBusy}
        undoRedoState={
          ["STAGE1_4", "STAGE1_6"].includes(state.map.sessionProtocolKey ?? "") ? undoRedoState : null
        }
        undoRedoFeedback={undoRedoFeedback}
        onUndoRedo={performUndoRedo}
        onSubmit={submitMap}
        onCreateConcept={(label) =>
          trackMapEditorMutation(() => createMapConcept(state.map.id, label))
        }
        onSaveConceptLabel={(conceptId, label) =>
          trackMapEditorMutation(() => saveConceptLabel(conceptId, label))
        }
        onDeleteConcept={(conceptId) =>
          trackMapEditorMutation(() => deleteConcept(conceptId))
        }
        onCreateLink={(sourceConceptId, targetConceptId, label) =>
          trackMapEditorMutation(() =>
            createLink(state.map.id, sourceConceptId, targetConceptId, label),
          )
        }
        onSaveLinkLabel={(link, label) =>
          trackMapEditorMutation(() => saveLinkLabel(link, label))
        }
        onReconnectLink={(link, sourceConceptId, targetConceptId) =>
          trackMapEditorMutation(() =>
            reconnectLink(link, sourceConceptId, targetConceptId),
          )
        }
        onDeleteLink={(linkId) =>
          trackMapEditorMutation(() => deleteLink(linkId))
        }
        onKitConceptDrop={(kitConceptItemId, position) =>
          trackMapEditorMutation(() =>
            importKitConcept(kitConceptItemId, position),
          )
        }
        onKitLinkCreate={(targetMapId, kitLinkItemId, sourceId, targetId) =>
          trackMapEditorMutation(() =>
            (isKBMap ? reconstructKitLink : importKitLink)(
              targetMapId,
              kitLinkItemId,
              sourceId,
              targetId,
            ),
          )
        }
        onPositionSave={saveConceptPosition}
      />
    );
  }

  return (
    <MapPageFrame isKBMap={isKBMap}>
      <section className="map-information" aria-labelledby="map-title">
        <div>
          <p className="eyebrow">{mapDisplayName(state.map.type)}</p>
          <h2 id="map-title">{state.map.title || "概念マップ"}</h2>
        </div>
        <dl className="map-metadata">
          <div>
            <dt>マップ ID</dt>
            <dd>{state.map.id}</dd>
          </div>
          <div>
            <dt>状態</dt>
            <dd>{state.map.status}</dd>
          </div>
          {state.map.submittedAt && (
            <div>
              <dt>提出日時</dt>
              <dd>
                <time dateTime={state.map.submittedAt}>
                  {new Date(state.map.submittedAt).toLocaleString()}
                </time>
              </dd>
            </div>
          )}
        </dl>
        {state.map.sessionId && (
          <a className="back-link" href={`/sessions/${state.map.sessionId}`}>
            セッション画面へ戻る
          </a>
        )}
        {state.map.type === "GOAL" && (
          <a className="back-link" href="/research/goal-maps">
            ゴールマップ一覧へ戻る
          </a>
        )}
      </section>

      {isReadOnlyMap && (
        <p className="map-read-only-notice" role="status">
          {isRegisteredGoalMap
            ? `Kit「${state.map.kitDefinitionName ?? "登録済み"}」の原本です。Kit登録後はゴールマップを編集できません。`
            : `提出済みの${mapDisplayName(state.map.type)}です。内容は読み取り専用です。`}
        </p>
      )}

      {state.map.type === "GOAL" && !isRegisteredGoalMap && (
        <GoalKitRegistrationPanel
          title={state.map.title ?? ""}
          conceptCount={state.map.concepts.length}
          linkCount={state.map.links.length}
          disabled={positionSaving || mapEditorSaveStatus === "saving"}
          onRegister={async (name) => {
            const response = await apiFetch(
              `/api/maps/${encodeURIComponent(state.map.id)}/kits`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  name,
                  conceptIds: state.map.concepts.map((concept) => concept.id),
                  linkIds: state.map.links.map((link) => link.id),
                }),
              },
            );
            const result = (await response.json().catch(() => null)) as {
              message?: unknown;
            } | null;
            if (!response.ok) {
              throw new Error(
                typeof result?.message === "string"
                  ? uiText(result.message)
                  : "Kitを登録できませんでした。ゴールマップを確認して再試行してください。",
              );
            }
            await reloadMapFromServer();
          }}
        />
      )}

      {state.map.type === "GOAL" && isRegisteredGoalMap && (
        <p className="goal-kit-registered-note" role="status">
          このゴールマップから作成したKitを、活動 1 セッション作成時に選択できます。
        </p>
      )}

      {!isKBMap && (
        <>
          <AddConceptForm
            mapId={state.map.id}
            concepts={state.map.concepts}
            disabled={
              positionSaving || submitting || mergingConcepts || isReadOnlyMap
            }
            onCreated={(concept) => {
              setState((current) =>
                current.status === "success"
                  ? {
                      status: "success",
                      map: {
                        ...current.map,
                        concepts: [...current.map.concepts, concept],
                      },
                    }
                  : current,
              );
            }}
          />

          <AddLinkForm
            disabled={
              positionSaving ||
              submitting ||
              mergingConcepts ||
              isReadOnlyMap ||
              state.map.concepts.length === 0 ||
              canvasLinkCreation !== null
            }
            onStart={(label) =>
              setCanvasLinkCreation({ id: createTemporaryId(), label })
            }
          />
        </>
      )}

      {state.map.concepts.length === 0 && !state.map.kitDefinitionId ? (
        <p className="map-message">このマップにはConceptがありません。</p>
      ) : (
        <ConceptCanvas
          mapId={state.map.id}
          mapType={state.map.type}
          concepts={state.map.concepts}
          links={state.map.links}
          kitDefinitionName={state.map.kitDefinitionName}
          kitConcepts={state.map.kitConcepts}
          kitLinks={state.map.kitLinks}
          readOnly={isReadOnlyMap || submitting || mergingConcepts}
          canEditConceptStructure={canEditConceptStructure}
          canEditLinkLabel={canEditLinkLabel}
          positionSaving={positionSaving}
          positionFeedback={positionFeedback}
          onLabelSave={saveConceptLabel}
          onConceptDelete={deleteConcept}
          onLinkLabelSave={saveLinkLabel}
          onLinkReconnect={reconnectLink}
          onLinkDelete={deleteLink}
          onKitConceptDrop={importKitConcept}
          onKitLinkCreate={isKBMap ? reconstructKitLink : importKitLink}
          onDragStart={() => setPositionFeedback(null)}
          onPositionSave={saveConceptPosition}
          linkCreation={canvasLinkCreation}
          onMapLinkCreate={async (sourceConceptId, targetConceptId, label) => {
            const createdLinkId = await trackMapEditorMutation(() =>
              createLink(state.map.id, sourceConceptId, targetConceptId, label),
            );
            setCanvasLinkCreation(null);
            return createdLinkId;
          }}
          onMapLinkCreationCancel={(id) =>
            setCanvasLinkCreation((current) =>
              current?.id === id ? null : current,
            )
          }
        />
      )}
    </MapPageFrame>
  );
}

function GoalKitRegistrationPanel({
  title,
  conceptCount,
  linkCount,
  disabled,
  onRegister,
}: {
  title: string;
  conceptCount: number;
  linkCount: number;
  disabled: boolean;
  onRegister: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const kitName = name.trim();
    if (!kitName || saving || disabled || conceptCount === 0) return;
    setSaving(true);
    setError(null);
    try {
      await onRegister(kitName);
    } catch (registerError) {
      setError(
        registerError instanceof Error
          ? registerError.message
          : "Kitを登録できませんでした。",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="goal-kit-registration" aria-labelledby="goal-kit-title">
      <div>
        <p className="home-card-kicker">Kit-Buildの教材</p>
        <h2 id="goal-kit-title">このゴールマップをKitとして登録</h2>
        <p>
          登録すると現在のConceptとLinkを部品にし、ゴールマップ原本を読み取り専用にします。
          セッションで使うにはConceptを1つ以上登録してください。
        </p>
        <p className="goal-kit-counts">
          現在の内容：{conceptCount} Concept・{linkCount} Link
        </p>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="goal-kit-name">Kit名</label>
        <div className="goal-map-create-control">
          <input
            id="goal-kit-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            required
          />
          <button
            type="submit"
            className="home-primary-button"
            disabled={disabled || saving || conceptCount === 0}
          >
            {saving ? "登録中…" : "Kitとして登録"}
          </button>
        </div>
        {error && <p className="goal-map-error" role="alert">{error}</p>}
      </form>
    </section>
  );
}

type MapEditorDrawerState =
  | { kind: "closed" }
  | { kind: "add-concept" }
  | { kind: "add-link" }
  | { kind: "edit-concept"; conceptId: string }
  | { kind: "edit-link"; linkId: string };

function MapEditorShell({
  map,
  isLearner,
  readOnly,
  canCreateConcept,
  canCreateLink,
  canEditConceptStructure,
  canEditLinkLabel,
  submitting,
  positionSaving,
  positionFeedback,
  saveStatus,
  submitFeedback,
  kitBuildFeedback,
  kitFeedbackFreshness,
  kitFeedbackChecking,
  kitFeedbackDialog,
  onCheckKitFeedback,
  onShowKitFeedback,
  onCloseKitFeedback,
  canSubmit,
  supplementalContent,
  additionalBusy,
  undoRedoState,
  undoRedoFeedback,
  onUndoRedo,
  onSubmit,
  onCreateConcept,
  onSaveConceptLabel,
  onDeleteConcept,
  onCreateLink,
  onSaveLinkLabel,
  onReconnectLink,
  onDeleteLink,
  onKitConceptDrop,
  onKitLinkCreate,
  onPositionSave,
}: {
  map: MapResponse;
  isLearner: boolean;
  readOnly: boolean;
  canCreateConcept: boolean;
  canCreateLink: boolean;
  canEditConceptStructure: boolean;
  canEditLinkLabel: boolean;
  submitting: boolean;
  positionSaving: boolean;
  positionFeedback: PositionSaveFeedback | null;
  saveStatus: MapEditorSaveStatus;
  submitFeedback:
    { type: "success" | "error" | "saving"; message: string } | undefined;
  kitBuildFeedback: KitBuildFeedbackState | null;
  kitFeedbackFreshness: KitFeedbackFreshness;
  kitFeedbackChecking: boolean;
  kitFeedbackDialog: KitFeedbackDialog | null;
  onCheckKitFeedback: () => Promise<void>;
  onShowKitFeedback: () => void;
  onCloseKitFeedback: () => void;
  canSubmit: boolean;
  supplementalContent?: React.ReactNode;
  additionalBusy: boolean;
  undoRedoState?: UndoRedoState | null;
  undoRedoFeedback?: string | null;
  onUndoRedo?: (action: "UNDO" | "REDO") => Promise<void>;
  onSubmit: () => Promise<void>;
  onCreateConcept: (label: string) => Promise<Concept>;
  onSaveConceptLabel: (conceptId: string, label: string) => Promise<void>;
  onDeleteConcept: (conceptId: string) => Promise<void>;
  onCreateLink: (
    sourceConceptId: string,
    targetConceptId: string,
    label: string,
  ) => Promise<string>;
  onSaveLinkLabel: (link: MapLink, label: string) => Promise<void>;
  onReconnectLink: (
    link: MapLink,
    sourceConceptId: string,
    targetConceptId: string,
  ) => Promise<void>;
  onDeleteLink: (linkId: string) => Promise<void>;
  onKitConceptDrop?: (
    kitConceptItemId: string,
    position: ConceptPosition,
  ) => Promise<void>;
  onKitLinkCreate?: (
    mapId: string,
    kitLinkItemId: string,
    sourceConceptId: string,
    targetConceptId: string,
  ) => Promise<string | void>;
  onPositionSave: (
    conceptId: string,
    position: ConceptPosition,
    originalPosition: ConceptPosition,
  ) => Promise<ConceptPosition | null>;
}) {
  const [drawer, setDrawer] = useState<MapEditorDrawerState>({
    kind: "closed",
  });
  const [conceptLabel, setConceptLabel] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [drawerSaving, setDrawerSaving] = useState(false);
  const [drawerFeedback, setDrawerFeedback] = useState<{
    type: "error" | "success";
    message: string;
  } | null>(null);
  const [linkCreation, setLinkCreation] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [linkCreationSaving, setLinkCreationSaving] = useState(false);
  const [linkCreationFeedback, setLinkCreationFeedback] = useState<{
    type: "error" | "success";
    message: string;
  } | null>(null);

  const activeConcept =
    drawer.kind === "edit-concept"
      ? map.concepts.find((concept) => concept.id === drawer.conceptId)
      : undefined;
  const activeLink =
    drawer.kind === "edit-link"
      ? map.links.find((link) => link.id === drawer.linkId)
      : undefined;
  const isSaving =
    saveStatus === "saving" || positionSaving || drawerSaving || additionalBusy;
  const interactionLocked = readOnly || additionalBusy;
  const hasSaveError =
    saveStatus === "error" || positionFeedback?.type === "error";

  function closeDrawer() {
    if (drawerSaving) return;
    setDrawer({ kind: "closed" });
    setDrawerFeedback(null);
  }

  function openAddConcept() {
    if (!canCreateConcept) return;
    setLinkCreation(null);
    setLinkCreationFeedback(null);
    setConceptLabel("");
    setDrawerFeedback(null);
    setDrawer({ kind: "add-concept" });
  }

  function openAddLink() {
    if (!canCreateLink) return;
    setLinkCreation(null);
    setLinkCreationFeedback(null);
    setLinkLabel("");
    setDrawerFeedback(null);
    setDrawer({ kind: "add-link" });
  }

  function openConceptEditor(concept: Concept) {
    if (interactionLocked || !canEditConceptStructure || linkCreation) return;
    setConceptLabel(concept.label);
    setDrawerFeedback(null);
    setDrawer({ kind: "edit-concept", conceptId: concept.id });
  }

  function openLinkEditor(link: MapLink) {
    if (interactionLocked || linkCreation) return;
    setLinkLabel(link.label);
    setDrawerFeedback(null);
    setDrawer({ kind: "edit-link", linkId: link.id });
  }

  async function handleConceptCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = conceptLabel.trim();
    if (!label || drawerSaving || interactionLocked || !canCreateConcept) return;

    setDrawerSaving(true);
    setDrawerFeedback(null);
    try {
      await onCreateConcept(label);
      setConceptLabel("");
      setDrawer({ kind: "closed" });
    } catch (error) {
      setDrawerFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Conceptを追加できませんでした。時間をおいて再度お試しください。",
      });
    } finally {
      setDrawerSaving(false);
    }
  }

  async function handleConceptSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = conceptLabel.trim();
    if (
      !activeConcept ||
      !label ||
      drawerSaving ||
      interactionLocked ||
      !canEditConceptStructure
    ) {
      return;
    }

    setDrawerSaving(true);
    setDrawerFeedback(null);
    try {
      await onSaveConceptLabel(activeConcept.id, label);
      setDrawerFeedback({ type: "success", message: "概念名を保存しました。" });
    } catch (error) {
      setDrawerFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "概念名を保存できませんでした。時間をおいて再度お試しください。",
      });
    } finally {
      setDrawerSaving(false);
    }
  }

  async function handleConceptDelete() {
    if (
      !activeConcept ||
      drawerSaving ||
      interactionLocked ||
      !canEditConceptStructure
    ) {
      return;
    }
    if (!window.confirm(`「${activeConcept.label}」を削除しますか？`)) return;

    setDrawerSaving(true);
    setDrawerFeedback(null);
    try {
      await onDeleteConcept(activeConcept.id);
      setDrawer({ kind: "closed" });
    } catch (error) {
      setDrawerFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Conceptを削除できませんでした。時間をおいて再度お試しください。",
      });
    } finally {
      setDrawerSaving(false);
    }
  }

  function startLinkCreation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = linkLabel.trim();
    if (!label || drawerSaving || interactionLocked || !canCreateLink) return;
    if (map.concepts.length === 0) {
      setDrawerFeedback({
        type: "error",
        message: "接続する概念を先に追加してください。",
      });
      return;
    }

    setLinkCreation({ id: createTemporaryId(), label });
    setLinkCreationFeedback(null);
    setDrawer({ kind: "closed" });
  }

  async function handleMapLinkCreate(
    sourceConceptId: string,
    targetConceptId: string,
    label: string,
  ): Promise<string | void> {
    if (interactionLocked || !canCreateLink || linkCreationSaving) return;
    setLinkCreationSaving(true);
    setLinkCreationFeedback(null);
    try {
      const createdLinkId = await onCreateLink(
        sourceConceptId,
        targetConceptId,
        label,
      );
      setLinkCreation(null);
      setDrawer({ kind: "closed" });
      setLinkCreationFeedback({
        type: "success",
        message: "Linkを追加しました。",
      });
      return createdLinkId;
    } catch (error) {
      setLinkCreationFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Linkを作成できませんでした。両handleを確認して再度お試しください。",
      });
      throw error;
    } finally {
      setLinkCreationSaving(false);
    }
  }

  async function handleLinkLabelSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = linkLabel.trim();
    if (
      !activeLink ||
      !label ||
      drawerSaving ||
      interactionLocked ||
      !canEditLinkLabel
    ) {
      return;
    }

    setDrawerSaving(true);
    setDrawerFeedback(null);
    try {
      await onSaveLinkLabel(activeLink, label);
      setDrawerFeedback({
        type: "success",
        message: "リンクラベルを保存しました。",
      });
    } catch (error) {
      setDrawerFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "リンクラベルを保存できませんでした。時間をおいて再度お試しください。",
      });
    } finally {
      setDrawerSaving(false);
    }
  }

  async function handleLinkDelete() {
    if (!activeLink || drawerSaving || interactionLocked) return;
    if (!window.confirm(`「${activeLink.label}」を削除しますか？`)) return;

    setDrawerSaving(true);
    setDrawerFeedback(null);
    try {
      await onDeleteLink(activeLink.id);
      setDrawer({ kind: "closed" });
    } catch (error) {
      setDrawerFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Linkを削除できませんでした。時間をおいて再度お試しください。",
      });
    } finally {
      setDrawerSaving(false);
    }
  }

  async function handleSubmitMap() {
    await onSubmit();
    setDrawer({ kind: "closed" });
    setLinkCreation(null);
  }

  const sourceLabel = activeLink
    ? (map.concepts.find((concept) => concept.id === activeLink.sourceConceptId)
        ?.label ?? "概念が見つかりません")
    : "";
  const targetLabel = activeLink
    ? (map.concepts.find((concept) => concept.id === activeLink.targetConceptId)
        ?.label ?? "概念が見つかりません")
    : "";
  const mapTitle = isLearner
    ? map.type === "PRIOR"
      ? "STEP 2：Scratch-Build"
      : map.type === "KB"
        ? "STEP 3：Kit-Build"
        : map.sessionProtocolKey === "STAGE1_6"
          ? "STEP 5：統合マップ"
          : "STEP 4：統合"
    : map.type === "PRIOR"
      ? "学習者マップ（Scratch-Build）"
      : map.type === "INTEGRATION" ? "統合マップ" : "Kit-Build マップ";
  const submittedMapName = mapTitle;

  return (
    <main
      className={`map-editor-page is-${map.type.toLowerCase()}${isLearner ? " is-learner" : ""}`}
    >
      <header className="map-editor-header">
        <div className="map-editor-title">
          <h1>{mapTitle}</h1>
          {!isLearner && <span>{mapTitle}</span>}
        </div>
        <div className="map-editor-header-actions">
          <a
            className="map-editor-back-link"
            href={
              map.sessionId
                ? `/sessions/${encodeURIComponent(map.sessionId)}`
                : "/"
            }
          >
            ← {map.sessionId ? "セッション画面へ戻る" : "トップへ戻る"}
          </a>
          <p
            className={`map-editor-save-status${hasSaveError ? " is-error" : isSaving ? " is-saving" : ""}`}
            role="status"
            aria-live="polite"
          >
            {hasSaveError
              ? "保存エラー"
              : isSaving
                ? "保存中…"
                : readOnly
                  ? "提出済み"
                  : "保存済み"}
          </p>
          {undoRedoState && (
            <div className="map-editor-history-actions" aria-label="編集履歴">
              <button
                type="button"
                disabled={
                  readOnly || isSaving || submitting || drawer.kind !== "closed" ||
                  linkCreation !== null || !undoRedoState.canUndo
                }
                title={undoRedoState.undoOperation?.operationType}
                onClick={() => void onUndoRedo?.("UNDO")}
              >
                元に戻す
              </button>
              <button
                type="button"
                disabled={
                  readOnly || isSaving || submitting || drawer.kind !== "closed" ||
                  linkCreation !== null || !undoRedoState.canRedo
                }
                title={undoRedoState.redoOperation?.operationType}
                onClick={() => void onUndoRedo?.("REDO")}
              >
                やり直す
              </button>
              {(undoRedoFeedback || undoRedoState.reason) && (
                <span role="status">
                  {uiText(undoRedoFeedback ?? undoRedoState.reason ?? "")}
                </span>
              )}
            </div>
          )}
          {map.status === "DRAFT" && !(map.type === "INTEGRATION" && map.sessionProtocolKey === "STAGE1_6") && (
            <button
              className="map-editor-submit-button"
              type="button"
              disabled={
                readOnly ||
                isSaving ||
                submitting ||
                drawerSaving ||
                !canSubmit ||
                linkCreation !== null
              }
              onClick={() => void handleSubmitMap()}
            >
              {submitting ? "提出中…" : "提出"}
            </button>
          )}
          {submitFeedback && (
            <p
              className={`map-editor-submit-feedback is-${submitFeedback.type}`}
              role={submitFeedback.type === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {submitFeedback.message}
            </p>
          )}
        </div>
      </header>

      {readOnly && (
        <p className="map-editor-read-only" role="status">
          提出済みの{submittedMapName}です。内容は読み取り専用です。
        </p>
      )}

      {map.type === "KB" && (
        <section className="kit-feedback-actions" aria-label="ゴールマップとの一致確認">
          {isLearner && <p>部品をマップに配置して接続した後、ボタンで一致状況を確認できます。</p>}
          <button
            type="button"
            className="kit-feedback-check-button"
            disabled={isSaving || submitting || kitFeedbackChecking}
            onClick={() => void onCheckKitFeedback()}
          >
            {kitFeedbackChecking ? "確認中…" : "一致状況を確認"}
          </button>
          {kitBuildFeedback && (
            <>
              <p className="kit-feedback-summary" role="status">
                前回の結果：{kitBuildFeedback.result.matched ? "一致" : "不一致"}。
                {kitFeedbackFreshnessText(kitFeedbackFreshness)}
              </p>
              <button type="button" className="kit-feedback-review-button" onClick={onShowKitFeedback}>
                前回の結果を表示
              </button>
            </>
          )}
        </section>
      )}

      {supplementalContent}

      <section
        className={`map-editor-workspace${drawer.kind !== "closed" ? " has-drawer" : ""}`}
      >
        <div className="map-editor-canvas-column">
          {isLearner && !readOnly && <p className="map-editor-operation-hint">{map.type === "KB" ? "部品をマップへドラッグし、リンクの両端を概念へ接続します。" : "概念とリンクを追加し、リンクの両端を概念へドラッグして接続します。"} 矢印の先が関係先です。</p>}
          {!interactionLocked && (canCreateConcept || canCreateLink) && (
            <div className="map-editor-tools" aria-label="マップ操作">
              <span>追加</span>
              {canCreateConcept && (
                <button type="button" onClick={openAddConcept}>
                  ＋ 概念
                </button>
              )}
              {canCreateLink && (
                <button type="button" onClick={openAddLink}>
                  ＋ リンク
                </button>
              )}
            </div>
          )}

          {linkCreation && (
            <div className="map-editor-link-creation-status" role="status">
              <span>
                「{linkCreation.label}
                」の中央をドラッグして配置し、両端をConceptへ接続してください。
              </span>
              <button
                type="button"
                disabled={linkCreationSaving || additionalBusy}
                onClick={() => {
                  setLinkCreation(null);
                  setLinkCreationFeedback(null);
                }}
              >
                キャンセル
              </button>
            </div>
          )}
          {linkCreationFeedback && (
            <p
              className={`map-editor-inline-feedback is-${linkCreationFeedback.type}`}
              role={linkCreationFeedback.type === "error" ? "alert" : "status"}
            >
              {linkCreationFeedback.message}
            </p>
          )}

          <ConceptCanvas
            mapId={map.id}
            mapType={map.type}
            concepts={map.concepts}
            links={map.links}
            kitDefinitionName={map.kitDefinitionName}
            kitConcepts={map.kitConcepts}
            kitLinks={map.kitLinks}
            readOnly={interactionLocked}
            canEditConceptStructure={canEditConceptStructure}
            canEditLinkLabel={canEditLinkLabel}
            positionSaving={positionSaving || linkCreationSaving}
            positionFeedback={positionFeedback}
            onLabelSave={onSaveConceptLabel}
            onConceptDelete={onDeleteConcept}
            onLinkLabelSave={onSaveLinkLabel}
            onLinkReconnect={onReconnectLink}
            onLinkDelete={onDeleteLink}
            onKitConceptDrop={onKitConceptDrop ?? (async () => undefined)}
            onKitLinkCreate={onKitLinkCreate ?? (async () => undefined)}
            onDragStart={() => undefined}
            onPositionSave={onPositionSave}
            linkCreation={linkCreation}
            onMapLinkCreate={handleMapLinkCreate}
            onMapLinkCreationCancel={(id) => {
              setLinkCreation((current) =>
                current?.id === id ? null : current,
              );
              setLinkCreationFeedback(null);
            }}
            onMapConceptSelect={
              canEditConceptStructure ? openConceptEditor : undefined
            }
            onMapLinkSelect={openLinkEditor}
          />
        </div>

        {drawer.kind !== "closed" && (
          <aside className="map-editor-drawer" aria-label="マップ編集">
            <div className="map-editor-drawer-heading">
              <h2>
                {drawer.kind === "add-concept"
                  ? "概念を追加"
                  : drawer.kind === "add-link"
                    ? "リンクを追加"
                    : drawer.kind === "edit-concept"
                      ? "概念を編集"
                      : "リンクを編集"}
              </h2>
              <button
                type="button"
                aria-label="Drawerを閉じる"
                disabled={drawerSaving || additionalBusy}
                onClick={closeDrawer}
              >
                ×
              </button>
            </div>

            {drawer.kind === "add-concept" && (
              <form
                className="map-editor-drawer-form"
                onSubmit={(event) => void handleConceptCreate(event)}
              >
                <label htmlFor="map-editor-concept-name">概念名</label>
                <input
                  id="map-editor-concept-name"
                  type="text"
                  autoComplete="off"
                  autoFocus
                  value={conceptLabel}
                  onChange={(event) => setConceptLabel(event.target.value)}
                  disabled={drawerSaving || interactionLocked}
                  required
                />
                <div className="map-editor-drawer-actions">
                  <button
                    type="button"
                    className="is-secondary"
                    disabled={drawerSaving || additionalBusy}
                    onClick={closeDrawer}
                  >
                    キャンセル
                  </button>
                  <button
                    type="submit"
                    disabled={drawerSaving || interactionLocked || !conceptLabel.trim()}
                  >
                    {drawerSaving ? "追加中…" : "概念を追加"}
                  </button>
                </div>
              </form>
            )}

            {drawer.kind === "add-link" && (
              <form
                className="map-editor-drawer-form"
                onSubmit={startLinkCreation}
              >
                <label htmlFor="map-editor-link-label">リンクラベル</label>
                <input
                  id="map-editor-link-label"
                  type="text"
                  autoComplete="off"
                  autoFocus
                  value={linkLabel}
                  onChange={(event) => setLinkLabel(event.target.value)}
                  disabled={drawerSaving || interactionLocked}
                  required
                />
                <p className="map-editor-drawer-hint">
                  ラベルを入力して部品を追加した後、中央を配置し、両端を概念へドラッグして接続します。
                </p>
                <div className="map-editor-drawer-actions">
                  <button
                    type="button"
                    className="is-secondary"
                    disabled={drawerSaving || additionalBusy}
                    onClick={closeDrawer}
                  >
                    キャンセル
                  </button>
                  <button
                    type="submit"
                    disabled={drawerSaving || interactionLocked || !linkLabel.trim()}
                  >
                    接続を開始
                  </button>
                </div>
              </form>
            )}

            {drawer.kind === "edit-concept" &&
              activeConcept &&
              canEditConceptStructure && (
                <form
                  className="map-editor-drawer-form"
                  onSubmit={(event) => void handleConceptSave(event)}
                >
                  <label htmlFor="map-editor-concept-edit-label">概念名</label>
                  <input
                    id="map-editor-concept-edit-label"
                    type="text"
                    autoComplete="off"
                    value={conceptLabel}
                    onChange={(event) => setConceptLabel(event.target.value)}
                    disabled={drawerSaving || interactionLocked}
                    required
                  />
                  <div className="map-editor-drawer-actions">
                    <button
                      type="button"
                      className="is-danger"
                      disabled={
                        drawerSaving || interactionLocked || activeConcept.isMergeResult
                      }
                      onClick={() => void handleConceptDelete()}
                    >
                      削除
                    </button>
                    <button
                      type="submit"
                      disabled={
                        drawerSaving || interactionLocked || !conceptLabel.trim()
                      }
                    >
                      {drawerSaving ? "保存中…" : "保存"}
                    </button>
                  </div>
                  {activeConcept.isMergeResult && (
                    <p className="map-editor-drawer-hint">
                      Mergeの履歴を保持するため、このConceptは削除できません。
                    </p>
                  )}
                </form>
              )}

            {drawer.kind === "edit-link" && activeLink && (
              <form
                className="map-editor-drawer-form"
                onSubmit={(event) => void handleLinkLabelSave(event)}
              >
                {canEditLinkLabel ? (
                  <>
                    <label htmlFor="map-editor-link-edit-label">
                      リンクラベル
                    </label>
                    <input
                      id="map-editor-link-edit-label"
                      type="text"
                      autoComplete="off"
                      value={linkLabel}
                      onChange={(event) => setLinkLabel(event.target.value)}
                      disabled={drawerSaving || interactionLocked}
                      required
                    />
                  </>
                ) : (
                  <p className="link-label-fixed">
                    Kit Link由来のlabel: <strong>{activeLink.label}</strong>
                  </p>
                )}
                <dl className="map-editor-link-endpoints">
                  <div>
                    <dt>接続元</dt>
                    <dd>{sourceLabel}</dd>
                  </div>
                  <div>
                    <dt>接続先</dt>
                    <dd>{targetLabel}</dd>
                  </div>
                </dl>
                <p className="map-editor-drawer-hint">
                  接続元・接続先はCanvas上のLink
                  handleをドラッグして変更できます。
                </p>
                <div className="map-editor-drawer-actions">
                  <button
                    type="button"
                    className="is-danger"
                    disabled={drawerSaving || interactionLocked}
                    onClick={() => void handleLinkDelete()}
                  >
                    Linkを削除
                  </button>
                  {canEditLinkLabel && (
                    <button
                      type="submit"
                      disabled={drawerSaving || interactionLocked || !linkLabel.trim()}
                    >
                      {drawerSaving ? "保存中…" : "保存"}
                    </button>
                  )}
                </div>
              </form>
            )}

            {drawerFeedback && (
              <p
                className={`map-editor-drawer-feedback is-${drawerFeedback.type}`}
                role={drawerFeedback.type === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {drawerFeedback.message}
              </p>
            )}
          </aside>
        )}
      </section>
      {map.type === "KB" && (
        <KitBuildFeedbackDialog
          view={kitFeedbackDialog}
          feedback={kitBuildFeedback}
          freshness={kitFeedbackFreshness}
          onClose={onCloseKitFeedback}
        />
      )}
    </main>
  );
}

function kitFeedbackFreshnessText(freshness: KitFeedbackFreshness): string {
  switch (freshness) {
    case "current": return "前回の結果は最新です。";
    case "stale": return "前回の結果は古くなっています。";
    case "saving": return "保存中のため結果の新しさを確認できません。";
    case "unknown": return "マップの最新状態を確認できていません。";
  }
}

function KitBuildFeedbackDialog({
  view,
  feedback,
  freshness,
  onClose,
}: {
  view: KitFeedbackDialog | null;
  feedback: KitBuildFeedbackState | null;
  freshness: KitFeedbackFreshness;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const open = view !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      closeRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog className="kit-feedback-dialog" ref={dialogRef} onClose={onClose} aria-labelledby="kit-feedback-dialog-title">
      <h2 id="kit-feedback-dialog-title">ゴールマップとの一致確認</h2>
      <div className="kit-feedback-dialog-content" aria-live="polite" aria-atomic="true">
        {view?.status === "loading" && <p role="status">保存済みのマップの一致状況を確認しています…</p>}
        {view?.status === "error" && <p role="alert">{view.message}</p>}
        {view?.status === "result" && feedback && (
          <>
            {view.fromSubmission && <p>提出できませんでした。</p>}
            <p className="kit-feedback-result-heading">{feedback.result.matched ? "一致" : "不一致"}</p>
            <p>{uiText(feedback.result.message)}</p>
            <p>概念 {feedback.result.concepts.matched}/{feedback.result.concepts.total}、関係 {feedback.result.relations.matched}/{feedback.result.relations.total}</p>
            <p className={`kit-feedback-freshness is-${freshness}`}>{kitFeedbackFreshnessText(freshness)}</p>
          </>
        )}
      </div>
      <button type="button" ref={closeRef} onClick={() => dialogRef.current?.close()}>
        閉じる
      </button>
    </dialog>
  );
}

function MapPageFrame({
  children,
  isKBMap = false,
}: {
  children: React.ReactNode;
  isKBMap?: boolean;
}) {
  return (
    <main className="page map-page">
      <a className="back-link" href="/">
        ← 研究用MVP
      </a>
      <header className="map-page-heading">
        <p className="eyebrow">
          {isKBMap ? "KB Concept / Link再構成" : "概念マップ"}
        </p>
        <h1>Concept マップ</h1>
        <p className="description">
          {isKBMap
            ? "Kit PaletteからConceptとLinking Wordを配置し、handleで学習者自身が接続します。"
            : "Conceptの操作と、マップ内のLink作成・編集・削除・再接続ができます。"}
        </p>
      </header>
      {children}
    </main>
  );
}

export function ConceptCanvas({
  mapId,
  mapType,
  concepts,
  links,
  kitDefinitionName,
  kitConcepts,
  kitLinks,
  readOnly,
  canEditConceptStructure,
  canEditLinkLabel,
  positionSaving,
  positionFeedback,
  onLabelSave,
  onConceptDelete,
  onLinkLabelSave,
  onLinkReconnect,
  onLinkDelete,
  onKitConceptDrop,
  onKitLinkCreate,
  onDragStart,
  onPositionSave,
  onMapConceptSelect,
  onMapLinkSelect,
  linkCreation = null,
  onMapLinkCreate,
  onMapLinkCreationCancel,
  highlightedConceptIds,
  highlightedLinkIds,
}: {
  mapId: string;
  mapType: MapResponse["type"];
  concepts: Concept[];
  links: MapLink[];
  kitDefinitionName: string | null;
  kitConcepts: KitConceptItem[];
  kitLinks: KitLinkItem[];
  readOnly: boolean;
  highlightedConceptIds?: ReadonlySet<string>;
  highlightedLinkIds?: ReadonlySet<string>;
  canEditConceptStructure: boolean;
  canEditLinkLabel: boolean;
  positionSaving: boolean;
  positionFeedback: PositionSaveFeedback | null;
  onLabelSave: (conceptId: string, label: string) => Promise<void>;
  onConceptDelete: (conceptId: string) => Promise<void>;
  onLinkLabelSave: (link: MapLink, label: string) => Promise<void>;
  onLinkReconnect: (
    link: MapLink,
    sourceConceptId: string,
    targetConceptId: string,
  ) => Promise<void>;
  onLinkDelete: (linkId: string) => Promise<void>;
  onKitConceptDrop: (
    kitConceptItemId: string,
    position: ConceptPosition,
  ) => Promise<void>;
  onKitLinkCreate: (
    mapId: string,
    kitLinkItemId: string,
    sourceConceptId: string,
    targetConceptId: string,
  ) => Promise<string | void>;
  onDragStart: () => void;
  onPositionSave: (
    conceptId: string,
    position: ConceptPosition,
    originalPosition: ConceptPosition,
  ) => Promise<ConceptPosition | null>;
  onMapConceptSelect?: (concept: Concept) => void;
  onMapLinkSelect?: (link: MapLink) => void;
  linkCreation?: { id: string; label: string } | null;
  onMapLinkCreate?: (
    sourceConceptId: string,
    targetConceptId: string,
    label: string,
  ) => Promise<string | void>;
  onMapLinkCreationCancel?: (id: string) => void;
}) {
  const edges = useMemo(
    () => mapLinksToEdges(links, concepts, mapId),
    [concepts, links, mapId],
  );
  const conceptsById = useMemo(
    () => new Map(concepts.map((concept) => [concept.id, concept])),
    [concepts],
  );
  const [positionState, setPositionState] = useState(() => ({
    concepts,
    positions: new Map(
      concepts.map((concept) => [
        concept.id,
        { positionX: concept.positionX, positionY: concept.positionY },
      ]),
    ),
  }));
  const positions =
    positionState.concepts === concepts
      ? positionState.positions
      : new Map(
          concepts.map((concept) => [
            concept.id,
            { positionX: concept.positionX, positionY: concept.positionY },
          ]),
        );
  const [draggingConceptId, setDraggingConceptId] = useState<string | null>(
    null,
  );
  const [editingConceptId, setEditingConceptId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [labelSaving, setLabelSaving] = useState(false);
  const [labelFeedback, setLabelFeedback] = useState<LabelEditFeedback | null>(
    null,
  );
  const [deletingConceptId, setDeletingConceptId] = useState<string | null>(
    null,
  );
  const [confirmingDeleteConceptId, setConfirmingDeleteConceptId] = useState<
    string | null
  >(null);
  const [deleteFeedback, setDeleteFeedback] =
    useState<ConceptDeleteFeedback | null>(null);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [editingLinkLabel, setEditingLinkLabel] = useState("");
  const [linkLabelSaving, setLinkLabelSaving] = useState(false);
  const [linkLabelFeedback, setLinkLabelFeedback] =
    useState<LinkLabelEditFeedback | null>(null);
  const [reconnectSourceConceptId, setReconnectSourceConceptId] = useState("");
  const [reconnectTargetConceptId, setReconnectTargetConceptId] = useState("");
  const [reconnectingLinkId, setReconnectingLinkId] = useState<string | null>(
    null,
  );
  const [linkReconnectFeedback, setLinkReconnectFeedback] =
    useState<LinkReconnectFeedback | null>(null);
  const [confirmingDeleteLinkId, setConfirmingDeleteLinkId] = useState<
    string | null
  >(null);
  const [deletingLinkId, setDeletingLinkId] = useState<string | null>(null);
  const [linkDeleteFeedback, setLinkDeleteFeedback] =
    useState<LinkDeleteFeedback | null>(null);
  const [kitTemporaryConnectors, setKitTemporaryConnectors] = useState<
    TemporaryConnector[]
  >([]);
  const [mapTemporaryConnectorState, setMapTemporaryConnectorState] =
    useState<TemporaryConnector | null>(null);
  const [linkConnectorPositions, setLinkConnectorPositions] = useState(
    () => new Map<string, Point>(),
  );
  const [kitConceptSavingId, setKitConceptSavingId] = useState<string | null>(
    null,
  );
  const [paletteFeedback, setPaletteFeedback] = useState<{
    type: "success" | "error" | "saving";
    message: string;
  } | null>(null);
  const [kitPartQuery, setKitPartQuery] = useState("");
  const [connectionPreview, setConnectionPreview] = useState<{
    start: Point;
    current: Point;
    kind: "temporary" | "saved";
    id: string;
    endpoint: "source" | "target";
  } | null>(null);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const arrowMarkerId = `concept-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [canvasViewportWidth, setCanvasViewportWidth] = useState(960);
  const nodeElementsRef = useRef(new Map<string, HTMLElement>());
  const [nodeSizes, setNodeSizes] = useState(new Map<string, NodeSize>());
  const connectorElementsRef = useRef(new Map<string, HTMLElement>());
  const [connectorSizes, setConnectorSizes] = useState(new Map<string, NodeSize>());
  const deletingConceptRef = useRef<string | null>(null);
  const selectedLink = links.find((link) => link.id === selectedLinkId) ?? null;
  const selectedSourceConcept = selectedLink
    ? concepts.find((concept) => concept.id === selectedLink.sourceConceptId)
    : undefined;
  const selectedTargetConcept = selectedLink
    ? concepts.find((concept) => concept.id === selectedLink.targetConceptId)
    : undefined;
  const activeDragRef = useRef<{
    conceptId: string;
    pointerId: number;
    offsetX: number;
    offsetY: number;
    originalPosition: ConceptPosition;
  } | null>(null);
  const activeConnectionRef = useRef<{
    kind: "temporary" | "saved";
    id: string;
    endpoint: "source" | "target";
    pointerId: number;
    start: Point;
  } | null>(null);
  const activeConnectorDragRef = useRef<{
    kind: "temporary" | "saved";
    id: string;
    pointerId: number;
    offsetX: number;
    offsetY: number;
    startClientX: number;
    startClientY: number;
    originalPosition: Point;
    moved: boolean;
  } | null>(null);
  const suppressConnectorClickRef = useRef(false);
  const connectorDragCleanupRef = useRef<(() => void) | null>(null);
  const touchPaletteDragRef = useRef<{
    pointerId: number;
    part: KitPalettePart;
  } | null>(null);
  const mapTemporaryConnector = linkCreation
    ? mapTemporaryConnectorState?.id === linkCreation.id
      ? { ...mapTemporaryConnectorState, label: linkCreation.label }
      : {
          id: linkCreation.id,
          kind: "map" as const,
          kitLinkItemId: null,
          label: linkCreation.label,
          position: { x: 480, y: 280 },
          sourceConceptId: null,
          targetConceptId: null,
          saving: false,
          error: null,
        }
    : null;
  const temporaryConnectors = mapTemporaryConnector
    ? [...kitTemporaryConnectors, mapTemporaryConnector]
    : kitTemporaryConnectors;
  const pendingConnectors = temporaryConnectors.filter(connector => !connector.sourceConceptId || !connector.targetConceptId);
  const showConnectionGuidance = !readOnly && (connectionPreview !== null || pendingConnectors.length > 0);

  useEffect(() => () => {
    connectorDragCleanupRef.current?.();
    activeConnectorDragRef.current = null;
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === canvasViewportRef.current) {
          const width = Math.max(960, Math.ceil(entry.contentRect.width));
          setCanvasViewportWidth((previous) =>
            previous === width ? previous : width,
          );
        }
      }

      setNodeSizes((current) => {
        let next = current;

        for (const entry of entries) {
          const element = entry.target as HTMLElement;
          if (element === canvasViewportRef.current) continue;

          const conceptId = element.dataset.conceptId;
          if (!conceptId) continue;

          const bounds = element.getBoundingClientRect();
          const size = { width: bounds.width, height: bounds.height };
          const previous = next.get(conceptId);
          if (
            previous?.width === size.width &&
            previous.height === size.height
          ) {
            continue;
          }

          if (next === current) next = new Map(current);
          next.set(conceptId, size);
        }

        return next;
      });
    });

    const viewport = canvasViewportRef.current;
    if (viewport) observer.observe(viewport);
    nodeElementsRef.current.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [concepts]);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      setConnectorSizes(current => {
        let next = current;
        for (const entry of entries) {
          const element = entry.target as HTMLElement;
          const id = element.dataset.connectorId;
          if (!id) continue;
          const size = { width: element.offsetWidth, height: element.offsetHeight };
          const previous = next.get(id);
          if (previous?.width === size.width && previous.height === size.height) continue;
          if (next === current) next = new Map(current);
          next.set(id, size);
        }
        return next;
      });
    });
    connectorElementsRef.current.forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [links, kitTemporaryConnectors, mapTemporaryConnectorState, linkCreation]);

  const canvasWidth = Math.max(
    960,
    canvasViewportWidth,
    ...concepts.map((concept) => {
      const position = positions.get(concept.id) ?? concept;
      return (
        position.positionX + (nodeSizes.get(concept.id)?.width ?? 190) + 120
      );
    }),
    ...temporaryConnectors.map((connector) => connector.position.x + 140),
    ...Array.from(linkConnectorPositions.values(), (position) => position.x + 140),
  );

  const canvasHeight = Math.max(
    560,
    ...concepts.map((concept) => {
      const position = positions.get(concept.id) ?? {
        positionX: concept.positionX,
        positionY: concept.positionY,
      };
      return (
        position.positionY + (nodeSizes.get(concept.id)?.height ?? 150) + 100
      );
    }),
    ...temporaryConnectors.map((connector) => connector.position.y + 100),
    ...Array.from(linkConnectorPositions.values(), (position) => position.y + 100),
  );

  const supportsKitPalette = mapType === "KB" || mapType === "INTEGRATION";
  const normalizedKitPartQuery = kitPartQuery.trim().toLowerCase();
  const visibleKitConcepts = normalizedKitPartQuery
    ? kitConcepts.filter((item) =>
        item.label.toLowerCase().includes(normalizedKitPartQuery),
      )
    : kitConcepts;
  const visibleKitLinks = normalizedKitPartQuery
    ? kitLinks.filter((item) =>
        item.label.toLowerCase().includes(normalizedKitPartQuery),
      )
    : kitLinks;
  const usesMapEditorDrawers =
    mapType === "PRIOR" ||
    mapType === "KB" ||
    mapType === "INTEGRATION";
  const canOpenConceptDrawer =
    usesMapEditorDrawers &&
    !readOnly &&
    canEditConceptStructure &&
    onMapConceptSelect !== undefined;

  function clientToCanvasPoint(clientX: number, clientY: number): Point | null {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    return {
      x: Math.max(0, Math.round(clientX - bounds.left)),
      y: Math.max(0, Math.round(clientY - bounds.top)),
    };
  }

  function conceptAtPoint(clientX: number, clientY: number) {
    const element = document.elementFromPoint(clientX, clientY);
    const elementConceptId =
      element instanceof Element
        ? element.closest<HTMLElement>("[data-concept-id]")?.dataset.conceptId
        : undefined;
    if (elementConceptId) return elementConceptId;

    const point = clientToCanvasPoint(clientX, clientY);
    if (!point) return null;
    return (
      concepts.find((concept) => {
        const position = positions.get(concept.id) ?? concept;
        const size = nodeSizes.get(concept.id);
        return (
          size !== undefined &&
          point.x >= position.positionX &&
          point.x <= position.positionX + size.width &&
          point.y >= position.positionY &&
          point.y <= position.positionY + size.height
        );
      })?.id ?? null
    );
  }

  function updateTemporaryConnector(
    id: string,
    update: (connector: TemporaryConnector) => TemporaryConnector,
  ) {
    const connector = temporaryConnectors.find((item) => item.id === id);
    if (!connector) return;
    if (connector.kind === "kit") {
      setKitTemporaryConnectors((current) =>
        current.map((item) => (item.id === id ? update(item) : item)),
      );
    } else {
      setMapTemporaryConnectorState((current) =>
        update(current?.id === id ? current : connector),
      );
    }
  }

  async function dropKitPart(part: KitPalettePart, point: Point) {
    if (readOnly || !supportsKitPalette) return;
    setPaletteFeedback(null);

    if (part.kind === "concept") {
      const item = kitConcepts.find(
        (candidate) => candidate.kitConceptItemId === part.itemId,
      );
      if (!item || item.imported || kitConceptSavingId !== null) return;

      const position = {
        positionX: Math.max(0, point.x - 95),
        positionY: Math.max(0, point.y - 44),
      };
      setKitConceptSavingId(item.kitConceptItemId);
      setPaletteFeedback({
        type: "saving",
        message: `「${item.label}」を配置中…`,
      });
      try {
        await onKitConceptDrop(item.kitConceptItemId, position);
        setPaletteFeedback({
          type: "success",
          message: `「${item.label}」をdrop位置へ配置しました。`,
        });
      } catch (error) {
        setPaletteFeedback({
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "Kit Conceptを配置できませんでした。",
        });
      } finally {
        setKitConceptSavingId(null);
      }
      return;
    }

    const item = kitLinks.find(
      (candidate) => candidate.kitLinkItemId === part.itemId,
    );
    if (!item || item.used) return;
    setKitTemporaryConnectors((current) => {
      const existing = current.find(
        (connector) => connector.kitLinkItemId === item.kitLinkItemId,
      );
      if (existing) {
        return current.map((connector) =>
          connector.id === existing.id
            ? { ...connector, position: point, error: null }
            : connector,
        );
      }
      return [
        ...current,
        {
          id: `temporary-${item.kitLinkItemId}`,
          kind: "kit",
          kitLinkItemId: item.kitLinkItemId,
          label: item.label,
          position: point,
          sourceConceptId: null,
          targetConceptId: null,
          saving: false,
          error: null,
        },
      ];
    });
    setPaletteFeedback({
      type: "success",
      message: `「${item.label}」の中央を配置し、両handleをConceptへ接続してください。`,
    });
  }

  function handleCanvasDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (readOnly || !event.dataTransfer.types.includes(KIT_PALETTE_MIME)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleCanvasDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (readOnly) return;
    event.preventDefault();
    const point = clientToCanvasPoint(event.clientX, event.clientY);
    if (!point) return;
    try {
      const part = JSON.parse(
        event.dataTransfer.getData(KIT_PALETTE_MIME),
      ) as KitPalettePart;
      if (
        (part.kind === "concept" || part.kind === "link") &&
        typeof part.itemId === "string" &&
        typeof part.label === "string"
      ) {
        void dropKitPart(part, point);
      }
    } catch {
      setPaletteFeedback({
        type: "error",
        message: "Kit部品を読み取れませんでした。もう一度dragしてください。",
      });
    }
  }

  function beginConnection(
    event: ReactPointerEvent<HTMLButtonElement>,
    kind: "temporary" | "saved",
    id: string,
    endpoint: "source" | "target",
    start: Point,
  ) {
    if (readOnly || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handleBounds = event.currentTarget.getBoundingClientRect();
    const handleCenter = clientToCanvasPoint(handleBounds.left + handleBounds.width / 2, handleBounds.top + handleBounds.height / 2) ?? start;
    const connection = {
      kind,
      id,
      endpoint,
      pointerId: event.pointerId,
      start: handleCenter,
    } as const;
    activeConnectionRef.current = connection;
    setConnectionPreview({ start: handleCenter, current: handleCenter, kind, id, endpoint });

    const handleMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== connection.pointerId) return;
      const point = clientToCanvasPoint(
        pointerEvent.clientX,
        pointerEvent.clientY,
      );
      if (point)
        setConnectionPreview({ start: connection.start, current: point, kind: connection.kind, id: connection.id, endpoint: connection.endpoint });
    };
    const finish = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== connection.pointerId) return;
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      if (activeConnectionRef.current === connection) {
        activeConnectionRef.current = null;
        setConnectionPreview(null);
        void finishConnectionAt(
          connection,
          pointerEvent.clientX,
          pointerEvent.clientY,
        );
      }
    };
    const cancel = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== connection.pointerId) return;
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      activeConnectionRef.current = null;
      setConnectionPreview(null);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }

  async function finishConnectionAt(
    connection: NonNullable<typeof activeConnectionRef.current>,
    clientX: number,
    clientY: number,
  ) {
    const conceptId = conceptAtPoint(clientX, clientY);
    if (!conceptId || !conceptsById.has(conceptId)) return;

    if (connection.kind === "saved") {
      const link = links.find((candidate) => candidate.id === connection.id);
      if (!link) return;
      const sourceConceptId =
        connection.endpoint === "source" ? conceptId : link.sourceConceptId;
      const targetConceptId =
        connection.endpoint === "target" ? conceptId : link.targetConceptId;
      if (
        sourceConceptId === link.sourceConceptId &&
        targetConceptId === link.targetConceptId
      ) {
        return;
      }
      setReconnectingLinkId(link.id);
      setLinkReconnectFeedback({
        linkId: link.id,
        type: "saving",
        message: "Linkを再接続中…",
      });
      try {
        await onLinkReconnect(link, sourceConceptId, targetConceptId);
        setLinkReconnectFeedback({
          linkId: link.id,
          type: "success",
          message: "handle操作でLinkを再接続しました。",
        });
      } catch (error) {
        setLinkReconnectFeedback({
          linkId: link.id,
          type: "error",
          message:
            error instanceof Error ? error.message : "再接続できませんでした。",
        });
      } finally {
        setReconnectingLinkId(null);
      }
      return;
    }

    const connector = temporaryConnectors.find(
      (candidate) => candidate.id === connection.id,
    );
    if (!connector || connector.saving) return;
    const updated: TemporaryConnector = {
      ...connector,
      [connection.endpoint === "source"
        ? "sourceConceptId"
        : "targetConceptId"]: conceptId,
      error: null,
    };
    updateTemporaryConnector(connector.id, () => updated);
    if (!updated.sourceConceptId || !updated.targetConceptId) return;

    updateTemporaryConnector(connector.id, (candidate) => ({
      ...candidate,
      saving: true,
    }));
    try {
      let createdLinkId: string | void;
      if (updated.kind === "kit") {
        if (!updated.kitLinkItemId) {
          throw new Error("Kit Link部品を確認できませんでした。");
        }
        createdLinkId = await onKitLinkCreate(
          mapId,
          updated.kitLinkItemId,
          updated.sourceConceptId,
          updated.targetConceptId,
        );
      } else {
        if (!onMapLinkCreate) {
          throw new Error("Link作成処理を利用できませんでした。");
        }
        createdLinkId = await onMapLinkCreate(
          updated.sourceConceptId,
          updated.targetConceptId,
          updated.label,
        );
      }
      if (createdLinkId) {
        setLinkConnectorPositions((current) => {
          const next = new Map(current);
          next.set(createdLinkId, updated.position);
          return next;
        });
      }
      if (updated.kind === "kit") {
        setKitTemporaryConnectors((current) =>
          current.filter((candidate) => candidate.id !== connector.id),
        );
      } else {
        setMapTemporaryConnectorState((current) =>
          current?.id === connector.id ? null : current,
        );
      }
      if (updated.kind === "kit") {
        setPaletteFeedback({
          type: "success",
          message: `「${updated.label}」を保存しました。`,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Kit Linkを保存できませんでした。";
      updateTemporaryConnector(connector.id, (candidate) => ({
        ...candidate,
        saving: false,
        error: message,
      }));
    }
  }

  function beginTouchPaletteDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    part: KitPalettePart,
  ) {
    if (event.pointerType === "mouse" || readOnly) return;
    event.preventDefault();
    touchPaletteDragRef.current = { pointerId: event.pointerId, part };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPaletteFeedback({
      type: "saving",
      message: `「${part.label}」を押したままCanvasへ移動してください。`,
    });
  }

  function finishTouchPaletteDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = touchPaletteDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    touchPaletteDragRef.current = null;
    const point = clientToCanvasPoint(event.clientX, event.clientY);
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (
      !point ||
      !bounds ||
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    ) {
      setPaletteFeedback({
        type: "error",
        message: "Canvas内で指を離してください。部品はまだ使用されていません。",
      });
      return;
    }
    void dropKitPart(drag.part, point);
  }

  function setConceptPosition(conceptId: string, position: ConceptPosition) {
    setPositionState((current) => {
      const next = new Map(
        current.concepts === concepts
          ? current.positions
          : concepts.map((concept) => [
              concept.id,
              {
                positionX: concept.positionX,
                positionY: concept.positionY,
              },
            ]),
      );
      next.set(conceptId, position);
      return { concepts, positions: next };
    });
  }

  function beginLabelEdit(concept: Concept) {
    if (
      readOnly ||
      !canEditConceptStructure ||
      positionSaving ||
      labelSaving ||
      confirmingDeleteConceptId !== null ||
      editingConceptId !== null
    ) {
      return;
    }

    setEditingConceptId(concept.id);
    setEditingLabel(concept.label);
    setLabelFeedback(null);
  }

  function cancelLabelEdit() {
    if (labelSaving) return;

    setEditingConceptId(null);
    setEditingLabel("");
    setLabelFeedback(null);
  }

  function selectLink(link: MapLink) {
    if (
      positionSaving ||
      labelSaving ||
      deletingConceptId !== null ||
      confirmingDeleteConceptId !== null ||
      editingConceptId !== null ||
      linkLabelSaving ||
      reconnectingLinkId !== null ||
      deletingLinkId !== null
    ) {
      return;
    }

    setSelectedLinkId(link.id);
    setEditingLinkLabel(link.label);
    setLinkLabelFeedback(null);
    setReconnectSourceConceptId(link.sourceConceptId);
    setReconnectTargetConceptId(link.targetConceptId);
    setLinkReconnectFeedback(null);
    setConfirmingDeleteLinkId(null);
    setLinkDeleteFeedback(null);
    if (usesMapEditorDrawers) onMapLinkSelect?.(link);
  }

  function cancelLinkLabelEdit() {
    if (
      linkLabelSaving ||
      reconnectingLinkId !== null ||
      deletingLinkId !== null
    ) {
      return;
    }

    setSelectedLinkId(null);
    setEditingLinkLabel("");
    setLinkLabelFeedback(null);
    setReconnectSourceConceptId("");
    setReconnectTargetConceptId("");
    setLinkReconnectFeedback(null);
    setConfirmingDeleteLinkId(null);
    setLinkDeleteFeedback(null);
  }

  function cancelLinkReconnect(link: MapLink) {
    if (reconnectingLinkId !== null) return;

    setReconnectSourceConceptId(link.sourceConceptId);
    setReconnectTargetConceptId(link.targetConceptId);
    setLinkReconnectFeedback(null);
  }

  async function handleLinkReconnect(link: MapLink) {
    if (
      reconnectingLinkId !== null ||
      linkLabelSaving ||
      confirmingDeleteLinkId !== null ||
      deletingLinkId !== null ||
      (reconnectSourceConceptId === link.sourceConceptId &&
        reconnectTargetConceptId === link.targetConceptId)
    ) {
      return;
    }

    const sourceConceptId = reconnectSourceConceptId;
    const targetConceptId = reconnectTargetConceptId;
    setReconnectingLinkId(link.id);
    setLinkReconnectFeedback({
      linkId: link.id,
      type: "saving",
      message: "Linkを再接続中…",
    });

    try {
      await onLinkReconnect(link, sourceConceptId, targetConceptId);
      setReconnectSourceConceptId(sourceConceptId);
      setReconnectTargetConceptId(targetConceptId);
      setLinkReconnectFeedback({
        linkId: link.id,
        type: "success",
        message: "Linkを再接続しました。",
      });
    } catch (error) {
      setReconnectSourceConceptId(link.sourceConceptId);
      setReconnectTargetConceptId(link.targetConceptId);
      setLinkReconnectFeedback({
        linkId: link.id,
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Linkを再接続できませんでした。時間をおいて再度お試しください。",
      });
    } finally {
      setReconnectingLinkId(null);
    }
  }

  function beginLinkDeleteConfirmation(link: MapLink) {
    if (
      linkLabelSaving ||
      reconnectingLinkId !== null ||
      deletingLinkId !== null
    ) {
      return;
    }

    setConfirmingDeleteLinkId(link.id);
    setLinkDeleteFeedback(null);
  }

  function cancelLinkDeleteConfirmation() {
    if (deletingLinkId !== null) return;

    setConfirmingDeleteLinkId(null);
    setLinkDeleteFeedback(null);
  }

  async function handleLinkLabelSubmit(
    event: FormEvent<HTMLFormElement>,
    link: MapLink,
  ) {
    event.preventDefault();
    const label = editingLinkLabel.trim();

    if (
      positionSaving ||
      labelSaving ||
      linkLabelSaving ||
      reconnectingLinkId !== null ||
      deletingLinkId !== null
    ) {
      return;
    }
    if (!label) {
      setLinkLabelFeedback({
        linkId: link.id,
        type: "error",
        message: "Link labelを入力してください。",
      });
      return;
    }

    setLinkLabelSaving(true);
    setLinkLabelFeedback({
      linkId: link.id,
      type: "saving",
      message: "Link labelを保存中…",
    });

    try {
      await onLinkLabelSave(link, label);
      setEditingLinkLabel(label);
      setLinkLabelFeedback({
        linkId: link.id,
        type: "success",
        message: "Link labelを保存しました。",
      });
    } catch (error) {
      setLinkLabelFeedback({
        linkId: link.id,
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Link labelを保存できませんでした。時間をおいて再度お試しください。",
      });
    } finally {
      setLinkLabelSaving(false);
    }
  }

  async function handleLinkDelete(link: MapLink) {
    if (
      confirmingDeleteLinkId !== link.id ||
      linkLabelSaving ||
      reconnectingLinkId !== null ||
      deletingLinkId !== null
    ) {
      return;
    }

    setDeletingLinkId(link.id);
    setLinkDeleteFeedback({
      linkId: link.id,
      type: "deleting",
      message: "Linkを削除中…",
    });

    try {
      await onLinkDelete(link.id);
      setSelectedLinkId(null);
      setEditingLinkLabel("");
      setConfirmingDeleteLinkId(null);
      setLinkDeleteFeedback(null);
    } catch (error) {
      setLinkDeleteFeedback({
        linkId: link.id,
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Linkを削除できませんでした。時間をおいて再度お試しください。",
      });
    } finally {
      setDeletingLinkId(null);
    }
  }

  async function handleLabelSubmit(
    event: FormEvent<HTMLFormElement>,
    concept: Concept,
  ) {
    event.preventDefault();
    const label = editingLabel.trim();

    if (positionSaving || labelSaving) return;
    if (!label) {
      setLabelFeedback({
        conceptId: concept.id,
        type: "error",
        message: "Concept名を入力してください。",
      });
      return;
    }

    setLabelSaving(true);
    setLabelFeedback({
      conceptId: concept.id,
      type: "saving",
      message: "labelを保存中…",
    });

    try {
      await onLabelSave(concept.id, label);
      setEditingConceptId(null);
      setEditingLabel("");
      setLabelFeedback({
        conceptId: concept.id,
        type: "success",
        message: "labelを保存しました。",
      });
    } catch (error) {
      setLabelFeedback({
        conceptId: concept.id,
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Concept名を保存できませんでした。時間をおいて再度お試しください。",
      });
    } finally {
      setLabelSaving(false);
    }
  }

  function beginConceptDelete(concept: Concept) {
    if (
      !canEditConceptStructure ||
      concept.isMergeResult ||
      positionSaving ||
      labelSaving ||
      deletingConceptRef.current !== null ||
      confirmingDeleteConceptId !== null ||
      editingConceptId !== null
    ) {
      return;
    }

    setDeleteFeedback(null);
    setConfirmingDeleteConceptId(concept.id);
  }

  function cancelConceptDelete() {
    if (deletingConceptRef.current !== null) return;

    setConfirmingDeleteConceptId(null);
    setDeleteFeedback(null);
  }

  async function confirmConceptDelete(concept: Concept) {
    if (
      !canEditConceptStructure ||
      concept.isMergeResult ||
      confirmingDeleteConceptId !== concept.id ||
      positionSaving ||
      labelSaving ||
      deletingConceptRef.current !== null ||
      editingConceptId !== null
    ) {
      return;
    }

    deletingConceptRef.current = concept.id;
    setDeletingConceptId(concept.id);

    try {
      await onConceptDelete(concept.id);
    } catch (error) {
      setDeleteFeedback({
        conceptId: concept.id,
        message:
          error instanceof Error
            ? error.message
            : "Conceptを削除できませんでした。時間をおいて再度お試しください。",
      });
    } finally {
      deletingConceptRef.current = null;
      setDeletingConceptId(null);
      setConfirmingDeleteConceptId(null);
    }
  }

  function scrollCanvasAtPointer(clientX: number) {
    const viewport = canvasViewportRef.current;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const edgeSize = Math.min(56, bounds.width / 4);
    const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;

    if (clientX >= bounds.right - edgeSize) {
      viewport.scrollLeft = Math.min(maxScrollLeft, viewport.scrollLeft + 28);
    } else if (clientX <= bounds.left + edgeSize) {
      viewport.scrollLeft = Math.max(0, viewport.scrollLeft - 28);
    }
  }

  function positionForPointer(
    event: ReactPointerEvent<HTMLElement>,
    drag: NonNullable<typeof activeDragRef.current>,
  ): ConceptPosition {
    const canvasBounds = canvasRef.current?.getBoundingClientRect();
    if (!canvasBounds) return drag.originalPosition;

    return {
      positionX: Math.max(
        0,
        Math.round(event.clientX - canvasBounds.left - drag.offsetX),
      ),
      positionY: Math.max(
        0,
        Math.round(event.clientY - canvasBounds.top - drag.offsetY),
      ),
    };
  }

  function handlePointerDown(
    event: ReactPointerEvent<HTMLElement>,
    concept: Concept,
  ) {
    const target = event.target;
    if (
      readOnly ||
      positionSaving ||
      labelSaving ||
      deletingConceptId !== null ||
      confirmingDeleteConceptId !== null ||
      editingConceptId !== null ||
      !event.isPrimary ||
      event.button !== 0 ||
      (target instanceof HTMLElement && target.closest("button, input, form"))
    ) {
      return;
    }

    event.preventDefault();
    const nodeBounds = event.currentTarget.getBoundingClientRect();
    const originalPosition = positions.get(concept.id) ?? {
      positionX: concept.positionX,
      positionY: concept.positionY,
    };
    activeDragRef.current = {
      conceptId: concept.id,
      pointerId: event.pointerId,
      offsetX: event.clientX - nodeBounds.left,
      offsetY: event.clientY - nodeBounds.top,
      originalPosition,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingConceptId(concept.id);
    onDragStart();
  }

  function handlePointerMove(
    event: ReactPointerEvent<HTMLElement>,
    conceptId: string,
  ) {
    const drag = activeDragRef.current;
    if (readOnly) {
      if (drag?.conceptId === conceptId && drag.pointerId === event.pointerId) {
        activeDragRef.current = null;
        setDraggingConceptId(null);
        setConceptPosition(conceptId, drag.originalPosition);
      }
      return;
    }

    if (
      !drag ||
      drag.conceptId !== conceptId ||
      drag.pointerId !== event.pointerId
    ) {
      return;
    }

    scrollCanvasAtPointer(event.clientX);
    setConceptPosition(conceptId, positionForPointer(event, drag));
  }

  function handlePointerUp(
    event: ReactPointerEvent<HTMLElement>,
    conceptId: string,
  ) {
    const drag = activeDragRef.current;
    if (readOnly) {
      if (drag?.conceptId === conceptId && drag.pointerId === event.pointerId) {
        activeDragRef.current = null;
        setDraggingConceptId(null);
        setConceptPosition(conceptId, drag.originalPosition);
      }
      return;
    }

    if (
      !drag ||
      drag.conceptId !== conceptId ||
      drag.pointerId !== event.pointerId
    ) {
      return;
    }

    scrollCanvasAtPointer(event.clientX);
    const position = positionForPointer(event, drag);
    activeDragRef.current = null;
    setDraggingConceptId(null);
    setConceptPosition(conceptId, position);

    if (
      position.positionX === drag.originalPosition.positionX &&
      position.positionY === drag.originalPosition.positionY
    ) {
      if (canOpenConceptDrawer) {
        const concept = conceptsById.get(conceptId);
        if (concept) onMapConceptSelect?.(concept);
      }
      return;
    }

    void onPositionSave(conceptId, position, drag.originalPosition)
      .then((savedPosition) =>
        setConceptPosition(conceptId, savedPosition ?? drag.originalPosition),
      )
      .catch(() => setConceptPosition(conceptId, drag.originalPosition));
  }

  function handlePointerCancel(
    event: ReactPointerEvent<HTMLElement>,
    conceptId: string,
  ) {
    const drag = activeDragRef.current;
    if (
      !drag ||
      drag.conceptId !== conceptId ||
      drag.pointerId !== event.pointerId
    ) {
      return;
    }

    activeDragRef.current = null;
    setDraggingConceptId(null);
    setConceptPosition(conceptId, drag.originalPosition);
  }

  function geometryForEdge(edge: LinkEdge) {
    const parallelEdges = edges.filter(
      (candidate) =>
        candidate.source === edge.source && candidate.target === edge.target,
    );
    const parallelIndex = parallelEdges.findIndex(
      (candidate) => candidate.id === edge.id,
    );
    const offset = (parallelIndex - (parallelEdges.length - 1) / 2) * 24;
    return getEdgeGeometry(edge, offset, positions, nodeSizes);
  }

  function updateConnectorPosition(
    kind: "temporary" | "saved",
    id: string,
    position: Point,
  ) {
    if (kind === "temporary") {
      updateTemporaryConnector(id, (connector) => ({
        ...connector,
        position,
      }));
      return;
    }

    setLinkConnectorPositions((current) => {
      const next = new Map(current);
      next.set(id, position);
      return next;
    });
  }

  function beginConnectorDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    kind: "temporary" | "saved",
    id: string,
    position: Point,
  ) {
    if (
      readOnly ||
      activeConnectorDragRef.current !== null ||
      !event.isPrimary ||
      event.button !== 0 ||
      (kind === "temporary" &&
        temporaryConnectors.find((connector) => connector.id === id)?.saving)
    ) {
      return;
    }
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return;
    event.stopPropagation();
    activeConnectorDragRef.current = {
      kind,
      id,
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left - position.x,
      offsetY: event.clientY - bounds.top - position.y,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originalPosition: position,
      moved: false,
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", moveConnectorWithPointer);
      window.removeEventListener("pointerup", finishConnectorDrag);
      window.removeEventListener("pointercancel", cancelConnectorDrag);
      if (connectorDragCleanupRef.current === cleanup) connectorDragCleanupRef.current = null;
    };
    connectorDragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", moveConnectorWithPointer);
    window.addEventListener("pointerup", finishConnectorDrag);
    window.addEventListener("pointercancel", cancelConnectorDrag);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Window listeners continue tracking if the browser cannot capture the pointer.
    }
  }

  function moveConnectorWithPointer(
    event: PointerEvent,
  ) {
    const drag = activeConnectorDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (
      !drag.moved &&
      Math.hypot(
        event.clientX - drag.startClientX,
        event.clientY - drag.startClientY,
      ) < 3
    ) {
      return;
    }
    drag.moved = true;
    const point = clientToCanvasPoint(event.clientX, event.clientY);
    if (!point) return;
    updateConnectorPosition(drag.kind, drag.id, {
      x: Math.max(0, point.x - drag.offsetX),
      y: Math.max(0, point.y - drag.offsetY),
    });
  }

  function finishConnectorDrag(event: PointerEvent) {
    const drag = activeConnectorDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    moveConnectorWithPointer(event);
    connectorDragCleanupRef.current?.();
    activeConnectorDragRef.current = null;
    if (drag.moved) {
      suppressConnectorClickRef.current = true;
      window.setTimeout(() => {
        suppressConnectorClickRef.current = false;
      }, 0);
    }
  }

  function cancelConnectorDrag(event: PointerEvent) {
    const drag = activeConnectorDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    connectorDragCleanupRef.current?.();
    activeConnectorDragRef.current = null;
    updateConnectorPosition(drag.kind, drag.id, drag.originalPosition);
  }

  function connectorEndpointPoints(edge: LinkEdge, center: Point) {
    const sourcePosition = positions.get(edge.source);
    const targetPosition = positions.get(edge.target);
    const sourceSize = nodeSizes.get(edge.source);
    const targetSize = nodeSizes.get(edge.target);
    if (!sourcePosition || !targetPosition || !sourceSize || !targetSize) {
      return null;
    }

    if (edge.source === edge.target) {
      const left = sourcePosition.positionX;
      const bottom = sourcePosition.positionY + sourceSize.height;
      return {
        source: { x: left + sourceSize.width * 0.68, y: bottom },
        target: { x: left + sourceSize.width * 0.32, y: bottom },
      };
    }

    return {
      source: rectangleBoundaryPoint(sourcePosition, sourceSize, center),
      target: rectangleBoundaryPoint(targetPosition, targetSize, center),
    };
  }

  function temporaryEndpoint(
    conceptId: string | null,
    connectorPosition: Point,
  ) {
    if (!conceptId) return null;
    const position = positions.get(conceptId);
    const size = nodeSizes.get(conceptId);
    if (!position || !size) return null;
    return rectangleBoundaryPoint(position, size, connectorPosition);
  }

  return (
    <section
      className={`concept-canvas-section${usesMapEditorDrawers ? " is-map-editor-canvas" : ""}`}
      aria-label="Concept マップ表示領域"
    >
      {supportsKitPalette && kitDefinitionName && (
        <section className="kit-palette" aria-label="Kit Palette">
          <div className="kit-palette-heading">
            <div>
              <p className="eyebrow">Kit Palette</p>
              <h2>{kitDefinitionName}</h2>
            </div>
            <p>ConceptまたはLinking WordをCanvasへドラッグしてください。</p>
          </div>
          <label className="kit-palette-search">
            <span>Kit部品を検索</span>
            <input
              type="search"
              value={kitPartQuery}
              onChange={(event) => setKitPartQuery(event.target.value)}
              placeholder="概念名・関係語"
              aria-label="Kit部品を検索"
            />
          </label>
          <div className="kit-palette-groups">
            <div>
              <h3>
                Concept parts ({visibleKitConcepts.length}/{kitConcepts.length})
              </h3>
              <ul className="kit-palette-list">
                {visibleKitConcepts.map((item) => {
                  const part: KitPalettePart = {
                    kind: "concept",
                    itemId: item.kitConceptItemId,
                    label: item.label,
                  };
                  return (
                    <li key={item.kitConceptItemId}>
                      <button
                        type="button"
                        className="kit-palette-part is-concept"
                        draggable={!readOnly && !item.imported}
                        disabled={
                          readOnly ||
                          item.imported ||
                          kitConceptSavingId === item.kitConceptItemId
                        }
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "copy";
                          event.dataTransfer.setData(
                            KIT_PALETTE_MIME,
                            JSON.stringify(part),
                          );
                        }}
                        onPointerDown={(event) =>
                          beginTouchPaletteDrag(event, part)
                        }
                        onPointerUp={finishTouchPaletteDrag}
                      >
                        <span>{item.label}</span>
                        <small>
                          {kitConceptSavingId === item.kitConceptItemId
                            ? "配置中"
                            : item.imported
                              ? "使用済み"
                              : "未使用"}
                        </small>
                      </button>
                    </li>
                  );
                })}
                {visibleKitConcepts.length === 0 && (
                  <li className="kit-palette-empty" role="status">
                    該当するConcept部品はありません。
                  </li>
                )}
              </ul>
            </div>
            <div>
              <h3>
                Linking Word parts ({visibleKitLinks.length}/{kitLinks.length})
              </h3>
              <ul className="kit-palette-list">
                {visibleKitLinks.map((item) => {
                  const temporary = temporaryConnectors.some(
                    (connector) =>
                      connector.kitLinkItemId === item.kitLinkItemId,
                  );
                  const part: KitPalettePart = {
                    kind: "link",
                    itemId: item.kitLinkItemId,
                    label: item.label,
                  };
                  return (
                    <li key={item.kitLinkItemId}>
                      <button
                        type="button"
                        className="kit-palette-part is-link"
                        draggable={!readOnly && !item.used}
                        disabled={readOnly || item.used}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "copy";
                          event.dataTransfer.setData(
                            KIT_PALETTE_MIME,
                            JSON.stringify(part),
                          );
                        }}
                        onPointerDown={(event) =>
                          beginTouchPaletteDrag(event, part)
                        }
                        onPointerUp={finishTouchPaletteDrag}
                      >
                        <span>{item.label}</span>
                        <small>
                          {item.used
                            ? "使用済み"
                            : temporary
                              ? "接続中"
                              : "未使用"}
                        </small>
                      </button>
                    </li>
                  );
                })}
                {visibleKitLinks.length === 0 && (
                  <li className="kit-palette-empty" role="status">
                    該当するLinking Word部品はありません。
                  </li>
                )}
              </ul>
            </div>
          </div>
          {paletteFeedback && (
            <p
              className={`kit-palette-feedback is-${paletteFeedback.type}`}
              role={paletteFeedback.type === "error" ? "alert" : "status"}
            >
              {paletteFeedback.message}
            </p>
          )}
        </section>
      )}
      {!readOnly && <div className="canvas-connection-area">
      {showConnectionGuidance && <p className="canvas-direction-hint">関係は「始点のConcept → Link → 矢印の先のConcept」の向きにつながります。</p>}
      <div className="canvas-connection-guidance" role="status" aria-live="polite">
        {connectionPreview ? <p>「{connectionPreview.endpoint === "source" ? "始点" : "矢印の先"}」を接続するConceptへドラッグしてください。</p> : pendingConnectors.map(connector => <p key={connector.id}>
          「{connector.label}」：始点 {connector.sourceConceptId ? conceptsById.get(connector.sourceConceptId)?.label ?? "接続済み" : "未接続"} → 矢印の先 {connector.targetConceptId ? conceptsById.get(connector.targetConceptId)?.label ?? "接続済み" : "未接続"}。
          {!connector.sourceConceptId || !connector.targetConceptId ? ` ${!connector.sourceConceptId && !connector.targetConceptId ? "始点と矢印の先" : !connector.sourceConceptId ? "始点" : "矢印の先"}のハンドルを対応するConceptへドラッグしてください。` : " 保存中です。"}
        </p>)}
      </div></div>}
      <div
        className="concept-canvas-viewport"
        ref={canvasViewportRef}
        role="region"
        aria-label="Concept Canvas。横スクロールして右側へ移動できます。"
        tabIndex={0}
      >
        <div
          className={`concept-canvas${readOnly ? " is-read-only" : ""}`}
          role="list"
          aria-label="Concept一覧"
          style={{ width: `${canvasWidth}px`, height: `${canvasHeight}px` }}
          ref={canvasRef}
          onDragOver={handleCanvasDragOver}
          onDrop={handleCanvasDrop}
        >
          <svg
            className="concept-edges"
            role="group"
            aria-label="Concept間のLink"
            width={canvasWidth}
            height={canvasHeight}
            viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
          >
            <defs>
              <marker
                id={`${arrowMarkerId}-normal`}
                viewBox="0 0 14 12"
                markerWidth="14"
                markerHeight="12"
                refX="15"
                refY="6"
                orient="auto"
                markerUnits="userSpaceOnUse"
                overflow="visible"
              >
                <path className="concept-arrowhead" d="M 1 1 L 13 6 L 1 11 L 4 6 Z" />
              </marker>
              <marker
                id={`${arrowMarkerId}-selected`}
                viewBox="0 0 14 12"
                markerWidth="14"
                markerHeight="12"
                refX="15"
                refY="6"
                orient="auto"
                markerUnits="userSpaceOnUse"
                overflow="visible"
              >
                <path className="concept-arrowhead is-selected" d="M 1 1 L 13 6 L 1 11 L 4 6 Z" />
              </marker>
            </defs>
            {edges.map((edge) => {
              const geometry = geometryForEdge(edge);

              if (!geometry) return null;
              const center = linkConnectorPositions.get(edge.id) ?? {
                x: geometry.labelX,
                y: geometry.labelY,
              };
              const endpoints = connectorEndpointPoints(edge, center);

              const sourceLabel =
                conceptsById.get(edge.source)?.label ?? edge.source;
              const targetLabel =
                conceptsById.get(edge.target)?.label ?? edge.target;

              return (
                <g key={edge.id} className={highlightedLinkIds?.has(edge.id) ? "is-history-changed" : undefined}>
                  <path
                    className="concept-edge-hit-target"
                    d={geometry.path}
                    role="button"
                    tabIndex={0}
                    aria-label={`Link ${edge.id}: ${sourceLabel} → ${edge.label} → ${targetLabel}`}
                    aria-pressed={selectedLinkId === edge.id}
                    onClick={() => {
                      const link = links.find(
                        (candidate) => candidate.id === edge.id,
                      );
                      if (link) selectLink(link);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        const link = links.find(
                          (candidate) => candidate.id === edge.id,
                        );
                        if (link) selectLink(link);
                      }
                    }}
                  />
                  {endpoints ? (
                    <>
                      {!(connectionPreview?.kind === "saved" && connectionPreview.id === edge.id && connectionPreview.endpoint === "source") && <path
                        className={`concept-edge-path${selectedLinkId === edge.id ? " is-selected" : ""}`}
                        d={`M ${endpoints.source.x} ${endpoints.source.y} L ${center.x - 10} ${center.y}`}
                        aria-hidden="true"
                      />}
                      {!(connectionPreview?.kind === "saved" && connectionPreview.id === edge.id && connectionPreview.endpoint === "target") && <path
                        className={`concept-edge-path${selectedLinkId === edge.id ? " is-selected" : ""}`}
                        d={`M ${center.x + 10} ${center.y} L ${endpoints.target.x} ${endpoints.target.y}`}
                        markerEnd={`url(#${arrowMarkerId}-${selectedLinkId === edge.id ? "selected" : "normal"})`}
                        aria-hidden="true"
                      />}
                    </>
                  ) : (
                    <path
                      className={`concept-edge-path${selectedLinkId === edge.id ? " is-selected" : ""}`}
                      d={geometry.path}
                      markerEnd={`url(#${arrowMarkerId}-${selectedLinkId === edge.id ? "selected" : "normal"})`}
                      aria-hidden="true"
                    />
                  )}
                </g>
              );
            })}
            {temporaryConnectors.map((connector) => {
              const source = temporaryEndpoint(
                connector.sourceConceptId,
                connector.position,
              );
              const target = temporaryEndpoint(
                connector.targetConceptId,
                connector.position,
              );
              const halfWidth = (connectorSizes.get(connector.id)?.width ?? 48) / 2;
              return (
                <g key={`${connector.id}-paths`}>
                  {source && !(connectionPreview?.kind === "temporary" && connectionPreview.id === connector.id && connectionPreview.endpoint === "source") && (
                    <path
                      className="temporary-connector-path"
                      d={`M ${source.x} ${source.y} L ${connector.position.x - 10} ${connector.position.y}`}
                    />
                  )}
                  {target && !(connectionPreview?.kind === "temporary" && connectionPreview.id === connector.id && connectionPreview.endpoint === "target") && (
                    <path
                      className="temporary-connector-path"
                      d={`M ${connector.position.x + 10} ${connector.position.y} L ${target.x} ${target.y}`}
                      markerEnd={`url(#${arrowMarkerId}-normal)`}
                    />
                  )}
                  {!source && !(connectionPreview?.kind === "temporary" && connectionPreview.id === connector.id && connectionPreview.endpoint === "source") && <path className="connection-preview-path" d={`M ${connector.position.x - halfWidth - 46} ${connector.position.y} L ${connector.position.x - halfWidth - 8} ${connector.position.y}`} markerEnd={`url(#${arrowMarkerId}-normal)`} aria-hidden="true" />}
                  {!target && !(connectionPreview?.kind === "temporary" && connectionPreview.id === connector.id && connectionPreview.endpoint === "target") && <path className="connection-preview-path" d={`M ${connector.position.x + halfWidth + 8} ${connector.position.y} L ${connector.position.x + halfWidth + 46} ${connector.position.y}`} markerEnd={`url(#${arrowMarkerId}-normal)`} aria-hidden="true" />}
                </g>
              );
            })}
            {connectionPreview && (
              <path
                className="connection-preview-path"
                d={(() => {
                  const from = connectionPreview.endpoint === "source" ? connectionPreview.current : connectionPreview.start;
                  const to = connectionPreview.endpoint === "source" ? connectionPreview.start : connectionPreview.current;
                  const middle = { x: from.x + (to.x - from.x) * 0.72, y: from.y + (to.y - from.y) * 0.72 };
                  return `M ${from.x} ${from.y} L ${middle.x} ${middle.y} L ${to.x} ${to.y}`;
                })()}
                markerMid={`url(#${arrowMarkerId}-normal)`}
                aria-hidden="true"
              />
            )}
            {!readOnly && connectionPreview?.kind === "saved" && edges.filter(edge => edge.id === connectionPreview.id).map(edge => {
              const geometry = geometryForEdge(edge);
              if (!geometry) return null;
              const center = linkConnectorPositions.get(edge.id) ?? { x: geometry.labelX, y: geometry.labelY };
              const size = connectorSizes.get(edge.id);
              if (!size) return null;
              return <g key={`${edge.id}-endpoint-labels`} aria-hidden="true"><text className="connector-endpoint-label" x={center.x - size.width / 2} y={center.y + size.height / 2 + 14} textAnchor="end">始点</text><text className="connector-endpoint-label" x={center.x + size.width / 2} y={center.y + size.height / 2 + 14}>矢印の先</text></g>;
            })}
            {!readOnly && pendingConnectors.map(connector => {
              const size = connectorSizes.get(connector.id);
              if (!size) return null;
              return <g key={`${connector.id}-endpoint-labels`} aria-hidden="true"><text className="connector-endpoint-label" x={connector.position.x - size.width / 2} y={connector.position.y + size.height / 2 + 14} textAnchor="end">始点</text><text className="connector-endpoint-label" x={connector.position.x + size.width / 2} y={connector.position.y + size.height / 2 + 14}>矢印の先</text></g>;
            })}
          </svg>
          {edges.map((edge) => {
            const geometry = geometryForEdge(edge);
            if (!geometry) return null;
            const link = links.find((candidate) => candidate.id === edge.id);
            if (!link) return null;
            const center = linkConnectorPositions.get(edge.id) ?? {
              x: geometry.labelX,
              y: geometry.labelY,
            };
            return (
              <div
                className={`link-connector${selectedLinkId === edge.id ? " is-selected" : ""}${highlightedLinkIds?.has(edge.id) ? " is-history-changed" : ""}`}
                key={`${edge.id}-connector`}
                data-connector-id={edge.id}
                ref={element => { if (element) connectorElementsRef.current.set(edge.id, element); else connectorElementsRef.current.delete(edge.id); }}
                style={{
                  left: `${center.x}px`,
                  top: `${center.y}px`,
                }}
              >
                <button
                  type="button"
                  className="link-connector-handle is-source"
                  data-endpoint-label="始点"
                  aria-label={`${edge.label}の始点を再接続`}
                  disabled={readOnly || reconnectingLinkId === edge.id}
                  onPointerDown={(event) =>
                    beginConnection(event, "saved", edge.id, "source", {
                      x: center.x - 12,
                      y: center.y,
                    })
                  }
                />
                <button
                  type="button"
                  className="link-connector-label"
                  aria-label={`Link ${edge.label}の中央をドラッグして移動。クリックで選択`}
                  title={readOnly ? edge.label : "ドラッグで位置を移動、クリックで選択"}
                  onPointerDown={(event) =>
                    beginConnectorDrag(event, "saved", edge.id, center)
                  }
                  onClick={() => {
                    if (suppressConnectorClickRef.current) {
                      suppressConnectorClickRef.current = false;
                      return;
                    }
                    selectLink(link);
                  }}
                >
                  {edge.label}
                </button>
                <button
                  type="button"
                  className="link-connector-handle is-target"
                  data-endpoint-label="矢印の先"
                  aria-label={`${edge.label}の矢印の先を再接続`}
                  disabled={readOnly || reconnectingLinkId === edge.id}
                  onPointerDown={(event) =>
                    beginConnection(event, "saved", edge.id, "target", {
                      x: center.x + 12,
                      y: center.y,
                    })
                  }
                />
              </div>
            );
          })}
          {temporaryConnectors.map((connector) => (
            <div
              className={`link-connector is-temporary${connector.saving ? " is-saving" : ""}`}
              key={connector.id}
              data-connector-id={connector.id}
              ref={element => { if (element) connectorElementsRef.current.set(connector.id, element); else connectorElementsRef.current.delete(connector.id); }}
              style={{
                left: `${connector.position.x}px`,
                top: `${connector.position.y}px`,
              }}
            >
              <button
                type="button"
                className={`link-connector-handle is-source${connector.sourceConceptId ? " is-connected" : ""}`}
                data-endpoint-label="始点"
                aria-label={`${connector.label}の始点を接続${connector.sourceConceptId ? "済み" : "、未接続"}`}
                disabled={connector.saving}
                onPointerDown={(event) =>
                  beginConnection(event, "temporary", connector.id, "source", {
                    x: connector.position.x - 12,
                    y: connector.position.y,
                  })
                }
              />
              <button
                type="button"
                className="link-connector-label"
                aria-label={`${connector.label}の中央をドラッグして移動`}
                disabled={connector.saving}
                onPointerDown={(event) =>
                  beginConnectorDrag(
                    event,
                    "temporary",
                    connector.id,
                    connector.position,
                  )
                }
              >
                {connector.saving ? "保存中…" : connector.label}
              </button>
              <button
                type="button"
                className={`link-connector-handle is-target${connector.targetConceptId ? " is-connected" : ""}`}
                data-endpoint-label="矢印の先"
                aria-label={`${connector.label}の矢印の先を接続${connector.targetConceptId ? "済み" : "、未接続"}`}
                disabled={connector.saving}
                onPointerDown={(event) =>
                  beginConnection(event, "temporary", connector.id, "target", {
                    x: connector.position.x + 12,
                    y: connector.position.y,
                  })
                }
              />
              <button
                type="button"
                className="temporary-connector-cancel"
                aria-label={`${connector.label}をキャンセル`}
                disabled={connector.saving}
                onClick={() => {
                  if (connector.kind === "map") {
                    setMapTemporaryConnectorState((current) =>
                      current?.id === connector.id ? null : current,
                    );
                    onMapLinkCreationCancel?.(connector.id);
                  } else {
                    setKitTemporaryConnectors((current) =>
                      current.filter(
                        (candidate) => candidate.id !== connector.id,
                      ),
                    );
                  }
                }}
              >
                ×
              </button>
              {connector.error && (
                <span className="temporary-connector-error" role="alert">
                  {connector.error}
                </span>
              )}
            </div>
          ))}
          {concepts.map((concept) => {
            const position = positions.get(concept.id) ?? {
              positionX: concept.positionX,
              positionY: concept.positionY,
            };
            const isDragging = draggingConceptId === concept.id;

            return (
              <article
                className={`concept-node${isDragging ? " is-dragging" : ""}${editingConceptId === concept.id ? " is-editing" : ""}${positionSaving ? " is-position-saving" : ""}${highlightedConceptIds?.has(concept.id) ? " is-history-changed" : ""}`}
                key={concept.id}
                role="listitem"
                tabIndex={canOpenConceptDrawer ? 0 : undefined}
                aria-label={
                  canOpenConceptDrawer ? `${concept.label} 概念` : undefined
                }
                data-concept-id={concept.id}
                ref={(element) => {
                  if (element) {
                    nodeElementsRef.current.set(concept.id, element);
                  } else {
                    nodeElementsRef.current.delete(concept.id);
                  }
                }}
                style={{
                  left: `${position.positionX}px`,
                  top: `${position.positionY}px`,
                }}
                onPointerDown={(event) => handlePointerDown(event, concept)}
                onPointerMove={(event) => handlePointerMove(event, concept.id)}
                onPointerUp={(event) => handlePointerUp(event, concept.id)}
                onPointerCancel={(event) =>
                  handlePointerCancel(event, concept.id)
                }
                onKeyDown={(event) => {
                  if (
                    canOpenConceptDrawer &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    onMapConceptSelect?.(concept);
                  }
                }}
              >
                {!usesMapEditorDrawers && (
                  <span className="concept-node-label">Concept</span>
                )}
                {usesMapEditorDrawers ? (
                  <h3>{concept.label}</h3>
                ) : readOnly || !canEditConceptStructure ? (
                  <h3>{concept.label}</h3>
                ) : editingConceptId === concept.id ? (
                  <form
                    className="concept-label-edit-form"
                    onSubmit={(event) => void handleLabelSubmit(event, concept)}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <input
                      type="text"
                      aria-label={`${concept.label}のlabel`}
                      value={editingLabel}
                      autoComplete="off"
                      autoFocus
                      disabled={labelSaving || positionSaving}
                      onChange={(event) => setEditingLabel(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelLabelEdit();
                        }
                      }}
                    />
                    <div className="concept-label-edit-actions">
                      <button
                        type="submit"
                        disabled={labelSaving || positionSaving}
                      >
                        {labelSaving ? "保存中…" : "保存"}
                      </button>
                      <button
                        type="button"
                        disabled={labelSaving || positionSaving}
                        onClick={cancelLabelEdit}
                      >
                        キャンセル
                      </button>
                    </div>
                  </form>
                ) : confirmingDeleteConceptId === concept.id ? (
                  <div
                    className="concept-delete-confirmation"
                    role="group"
                    aria-label={`${concept.label}の削除確認`}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <p>このConceptを削除しますか？</p>
                    <p className="concept-delete-id">
                      ID末尾: {concept.id.slice(-6)}
                    </p>
                    <div className="concept-node-actions">
                      <button
                        className="concept-delete-confirm-button"
                        type="button"
                        disabled={
                          positionSaving ||
                          labelSaving ||
                          deletingConceptId !== null ||
                          editingConceptId !== null
                        }
                        onClick={() => void confirmConceptDelete(concept)}
                      >
                        {deletingConceptId === concept.id
                          ? "削除中…"
                          : "削除する"}
                      </button>
                      <button
                        className="concept-delete-cancel-button"
                        type="button"
                        disabled={deletingConceptId !== null}
                        onClick={cancelConceptDelete}
                      >
                        キャンセル
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <h3>{concept.label}</h3>
                    <div className="concept-node-actions">
                      <button
                        className="concept-edit-button"
                        type="button"
                        disabled={
                          positionSaving ||
                          labelSaving ||
                          deletingConceptId !== null ||
                          confirmingDeleteConceptId !== null ||
                          editingConceptId !== null
                        }
                        onClick={() => beginLabelEdit(concept)}
                      >
                        編集
                      </button>
                      <button
                        className="concept-delete-button"
                        type="button"
                        aria-label={`「${concept.label}」を削除`}
                        title={
                          concept.isMergeResult
                            ? "Merge lineageを保持するため削除できません。"
                            : undefined
                        }
                        disabled={
                          positionSaving ||
                          labelSaving ||
                          deletingConceptId !== null ||
                          confirmingDeleteConceptId !== null ||
                          editingConceptId !== null ||
                          concept.isMergeResult === true
                        }
                        onClick={() => beginConceptDelete(concept)}
                      >
                        {concept.isMergeResult
                          ? "削除不可"
                          : deletingConceptId === concept.id
                            ? "削除中…"
                            : "削除"}
                      </button>
                    </div>
                    {concept.isMergeResult && (
                      <p className="concept-merge-protected-notice">
                        Mergeの履歴を保持するため、このConceptは削除できません。
                      </p>
                    )}
                  </>
                )}
                {labelFeedback?.conceptId === concept.id && (
                  <p
                    className={`concept-label-feedback is-${labelFeedback.type}`}
                    role={labelFeedback.type === "error" ? "alert" : "status"}
                    aria-live="polite"
                  >
                    {labelFeedback.message}
                  </p>
                )}
                {deleteFeedback?.conceptId === concept.id && (
                  <p
                    className="concept-delete-feedback"
                    role="alert"
                    aria-live="polite"
                  >
                    {deleteFeedback.message}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      </div>
      {!usesMapEditorDrawers && edges.length > 0 && !readOnly && (
        <label className="link-selection-control" htmlFor="link-selection">
          Link選択
          <select
            id="link-selection"
            value={selectedLinkId ?? ""}
            disabled={
              linkLabelSaving ||
              positionSaving ||
              reconnectingLinkId !== null ||
              deletingLinkId !== null
            }
            onChange={(event) => {
              const link = links.find(
                (candidate) => candidate.id === event.target.value,
              );
              if (link) selectLink(link);
              else cancelLinkLabelEdit();
            }}
          >
            <option value="">Linkを選択してください</option>
            {edges.map((edge) => (
              <option key={edge.id} value={edge.id}>
                {conceptsById.get(edge.source)?.label ?? edge.source} →{" "}
                {edge.label} →{" "}
                {conceptsById.get(edge.target)?.label ?? edge.target}（ID末尾{" "}
                {edge.id.slice(-8)}）
              </option>
            ))}
          </select>
        </label>
      )}
      {!usesMapEditorDrawers && selectedLink && !readOnly && (
        <form
          className="link-label-edit-panel"
          aria-label="Link label編集"
          onSubmit={(event) => {
            if (!canEditLinkLabel) {
              event.preventDefault();
              return;
            }
            void handleLinkLabelSubmit(event, selectedLink);
          }}
        >
          <div className="link-label-edit-context">
            <p className="eyebrow">選択中のLink</p>
            <p className="link-label-edit-summary">
              {selectedSourceConcept?.label ?? selectedLink.sourceConceptId}
              <span aria-hidden="true"> → </span>
              {selectedTargetConcept?.label ?? selectedLink.targetConceptId}
            </p>
            <p className="link-label-edit-id">Link ID: {selectedLink.id}</p>
          </div>
          {canEditLinkLabel ? (
            <>
              <label htmlFor="link-label-edit-input">Link label</label>
              <input
                id="link-label-edit-input"
                type="text"
                autoComplete="off"
                value={editingLinkLabel}
                disabled={
                  linkLabelSaving ||
                  reconnectingLinkId === selectedLink.id ||
                  deletingLinkId === selectedLink.id
                }
                onChange={(event) => setEditingLinkLabel(event.target.value)}
              />
            </>
          ) : (
            <p className="link-label-fixed">
              Kit Link由来のlabel: <strong>{selectedLink.label}</strong>
            </p>
          )}
          <div className="link-label-edit-actions">
            {canEditLinkLabel && (
              <>
                <button
                  type="submit"
                  disabled={
                    linkLabelSaving ||
                    reconnectingLinkId === selectedLink.id ||
                    deletingLinkId === selectedLink.id ||
                    !editingLinkLabel.trim()
                  }
                >
                  {linkLabelSaving ? "保存中…" : "保存"}
                </button>
                <button
                  type="button"
                  disabled={
                    linkLabelSaving ||
                    reconnectingLinkId === selectedLink.id ||
                    deletingLinkId === selectedLink.id
                  }
                  onClick={cancelLinkLabelEdit}
                >
                  キャンセル
                </button>
              </>
            )}
            <button
              className="link-delete-button"
              type="button"
              disabled={
                linkLabelSaving ||
                reconnectingLinkId === selectedLink.id ||
                deletingLinkId === selectedLink.id
              }
              onClick={() => beginLinkDeleteConfirmation(selectedLink)}
            >
              Linkを削除
            </button>
          </div>
          {linkLabelFeedback?.linkId === selectedLink.id && (
            <p
              className={`link-label-edit-feedback is-${linkLabelFeedback.type}`}
              role={linkLabelFeedback.type === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {linkLabelFeedback.message}
            </p>
          )}
          <section className="link-reconnect-panel" aria-label="Link再接続">
            <h3>接続先変更</h3>
            <div className="link-reconnect-fields">
              <label htmlFor="link-reconnect-source">
                始点
                <select
                  id="link-reconnect-source"
                  value={reconnectSourceConceptId}
                  disabled={
                    linkLabelSaving ||
                    reconnectingLinkId === selectedLink.id ||
                    confirmingDeleteLinkId === selectedLink.id ||
                    deletingLinkId === selectedLink.id
                  }
                  onChange={(event) => {
                    setReconnectSourceConceptId(event.target.value);
                    setLinkReconnectFeedback(null);
                  }}
                >
                  {concepts.map((concept) => (
                    <option key={concept.id} value={concept.id}>
                      {concept.label}（ID末尾 {concept.id.slice(-8)}）
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="link-reconnect-target">
                矢印の先
                <select
                  id="link-reconnect-target"
                  value={reconnectTargetConceptId}
                  disabled={
                    linkLabelSaving ||
                    reconnectingLinkId === selectedLink.id ||
                    confirmingDeleteLinkId === selectedLink.id ||
                    deletingLinkId === selectedLink.id
                  }
                  onChange={(event) => {
                    setReconnectTargetConceptId(event.target.value);
                    setLinkReconnectFeedback(null);
                  }}
                >
                  {concepts.map((concept) => (
                    <option key={concept.id} value={concept.id}>
                      {concept.label}（ID末尾 {concept.id.slice(-8)}）
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="link-label-edit-actions">
              <button
                className="link-reconnect-save-button"
                type="button"
                disabled={
                  linkLabelSaving ||
                  reconnectingLinkId === selectedLink.id ||
                  confirmingDeleteLinkId === selectedLink.id ||
                  deletingLinkId === selectedLink.id ||
                  (reconnectSourceConceptId === selectedLink.sourceConceptId &&
                    reconnectTargetConceptId === selectedLink.targetConceptId)
                }
                onClick={() => void handleLinkReconnect(selectedLink)}
              >
                {reconnectingLinkId === selectedLink.id
                  ? "再接続中…"
                  : "再接続を保存"}
              </button>
              <button
                type="button"
                disabled={
                  reconnectingLinkId === selectedLink.id ||
                  deletingLinkId === selectedLink.id
                }
                onClick={() => cancelLinkReconnect(selectedLink)}
              >
                接続変更をキャンセル
              </button>
            </div>
            {linkReconnectFeedback?.linkId === selectedLink.id && (
              <p
                className={`link-label-edit-feedback is-${linkReconnectFeedback.type}`}
                role={
                  linkReconnectFeedback.type === "error" ? "alert" : "status"
                }
                aria-live="polite"
              >
                {linkReconnectFeedback.message}
              </p>
            )}
          </section>
          {confirmingDeleteLinkId === selectedLink.id && (
            <div
              className="link-delete-confirmation"
              role="group"
              aria-label="Link削除確認"
            >
              <p>このLinkを削除しますか？削除後は取り消せません。</p>
              <div className="link-label-edit-actions">
                <button
                  className="link-delete-confirm-button"
                  type="button"
                  disabled={deletingLinkId === selectedLink.id}
                  onClick={() => void handleLinkDelete(selectedLink)}
                >
                  {deletingLinkId === selectedLink.id ? "削除中…" : "削除する"}
                </button>
                <button
                  type="button"
                  disabled={deletingLinkId === selectedLink.id}
                  onClick={cancelLinkDeleteConfirmation}
                >
                  キャンセル
                </button>
              </div>
            </div>
          )}
          {linkDeleteFeedback?.linkId === selectedLink.id && (
            <p
              className={`link-label-edit-feedback is-${linkDeleteFeedback.type}`}
              role={linkDeleteFeedback.type === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {linkDeleteFeedback.message}
            </p>
          )}
        </form>
      )}
      {positionFeedback && (
        <p
          className={`canvas-feedback is-${positionFeedback.type}`}
          role={positionFeedback.type === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {positionFeedback.message}
        </p>
      )}
      <p className="canvas-caption">
        {readOnly
          ? "提出済みマップは読み取り専用です。"
          : "Conceptをドラッグすると、移動後のpositionX / positionYを保存します。"}
      </p>
    </section>
  );
}

export function ReadOnlyMapSnapshot({
  snapshot,
  title,
  allowZoom = false,
  highlightedConceptIds,
  highlightedLinkIds,
}: {
  snapshot: HistoricalMapSnapshot;
  title: string;
  allowZoom?: boolean;
  highlightedConceptIds?: ReadonlySet<string>;
  highlightedLinkIds?: ReadonlySet<string>;
}) {
  const [zoom, setZoom] = useState(1);
  const concepts: Concept[] = snapshot.concepts.map((item) => ({
    ...item,
    createdAt: "",
    updatedAt: "",
  }));
  const links: MapLink[] = snapshot.links;
  return (
    <section className={`map-history-preview${allowZoom ? " map-study-preview" : ""}`} aria-label={title} style={allowZoom ? ({ "--snapshot-zoom": zoom } as CSSProperties) : undefined}>
      <h4>{title}</h4>
      {allowZoom && <div className="map-study-controls" aria-label={`${title}の表示操作`}>
        <button type="button" className="session-secondary-button" disabled={zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, Math.round((value - 0.1) * 10) / 10))} aria-label={`${title}を縮小`}>−</button>
        <span aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button type="button" className="session-secondary-button" disabled={zoom >= 1.5} onClick={() => setZoom(value => Math.min(1.5, Math.round((value + 0.1) * 10) / 10))} aria-label={`${title}を拡大`}>＋</button>
      </div>}
      {allowZoom && <p className="map-study-instructions">スクロールバーで上下左右に移動できます。</p>}
      <ConceptCanvas
        mapId={snapshot.mapId}
        mapType={snapshot.mapType}
        concepts={concepts}
        links={links}
        highlightedConceptIds={highlightedConceptIds}
        highlightedLinkIds={highlightedLinkIds}
        kitDefinitionName={null}
        kitConcepts={[]}
        kitLinks={[]}
        readOnly
        canEditConceptStructure={false}
        canEditLinkLabel={false}
        positionSaving={false}
        positionFeedback={null}
        onLabelSave={async () => undefined}
        onConceptDelete={async () => undefined}
        onLinkLabelSave={async () => undefined}
        onLinkReconnect={async () => undefined}
        onLinkDelete={async () => undefined}
        onKitConceptDrop={async () => undefined}
        onKitLinkCreate={async () => undefined}
        onDragStart={() => undefined}
        onPositionSave={async () => null}
      />
    </section>
  );
}

function IntegrationConceptMergeForm({
  concepts,
  disabled,
  onMerge,
}: {
  concepts: Concept[];
  disabled: boolean;
  onMerge: (conceptIds: [string, string], label: string) => Promise<void>;
}) {
  const [firstConceptId, setFirstConceptId] = useState("");
  const [secondConceptId, setSecondConceptId] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<
    { type: "success" | "error" | "saving"; message: string } | undefined
  >();

  const firstConcept = concepts.find(
    (concept) => concept.id === firstConceptId,
  );
  const secondConcept = concepts.find(
    (concept) => concept.id === secondConceptId,
  );
  const canMerge =
    concepts.length >= 2 &&
    firstConcept !== undefined &&
    secondConcept !== undefined &&
    firstConcept.id !== secondConcept.id &&
    label.trim().length > 0;

  function updateFirstConcept(conceptId: string) {
    const nextFirst = concepts.find((concept) => concept.id === conceptId);
    setFirstConceptId(conceptId);
    setLabel(
      nextFirst && secondConcept && nextFirst.label === secondConcept.label
        ? nextFirst.label
        : "",
    );
    setFeedback(undefined);
  }

  function updateSecondConcept(conceptId: string) {
    const nextSecond = concepts.find((concept) => concept.id === conceptId);
    setSecondConceptId(conceptId);
    setLabel(
      firstConcept && nextSecond && firstConcept.label === nextSecond.label
        ? firstConcept.label
        : "",
    );
    setFeedback(undefined);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || disabled || !canMerge || !firstConcept || !secondConcept) {
      return;
    }

    const finalLabel = label.trim();
    const confirmed = window.confirm(
      `「${firstConcept.label}」と「${secondConcept.label}」をMergeし、「${finalLabel}」として表示します。\n元のConceptはMerge済み状態で保持されます。確定しますか？`,
    );
    if (!confirmed) return;

    setSaving(true);
    setFeedback({ type: "saving", message: "ConceptをMerge中…" });
    try {
      await onMerge([firstConcept.id, secondConcept.id], finalLabel);
      setFirstConceptId("");
      setSecondConceptId("");
      setLabel("");
      setFeedback({ type: "success", message: "ConceptをMergeしました。" });
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "ConceptをMergeできませんでした。マップを再読み込みしてください。",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="integration-concept-merge" aria-label="Concept Merge">
      <div className="integration-concept-merge-heading">
        <h3>ConceptをMerge</h3>
        <p>
          2つのConceptを選択し、新しいConceptとして統合します。候補の自動選択は行いません。
        </p>
      </div>
      {concepts.length < 2 ? (
        <p className="integration-concept-merge-empty">
          MergeにはactiveなConceptが2件以上必要です。
        </p>
      ) : (
        <form
          className="integration-concept-merge-form"
          onSubmit={handleSubmit}
        >
          <label>
            Concept A
            <select
              value={firstConceptId}
              onChange={(event) => updateFirstConcept(event.target.value)}
              disabled={saving || disabled}
              required
            >
              <option value="">Conceptを選択</option>
              {concepts.map((concept) => (
                <option
                  key={concept.id}
                  value={concept.id}
                  disabled={concept.id === secondConceptId}
                >
                  {concept.label}（ID末尾 {concept.id.slice(-8)}）
                </option>
              ))}
            </select>
          </label>
          <label>
            Concept B
            <select
              value={secondConceptId}
              onChange={(event) => updateSecondConcept(event.target.value)}
              disabled={saving || disabled}
              required
            >
              <option value="">Conceptを選択</option>
              {concepts.map((concept) => (
                <option
                  key={concept.id}
                  value={concept.id}
                  disabled={concept.id === firstConceptId}
                >
                  {concept.label}（ID末尾 {concept.id.slice(-8)}）
                </option>
              ))}
            </select>
          </label>
          <label className="integration-concept-merge-label">
            Merge後のlabel
            <input
              type="text"
              value={label}
              onChange={(event) => {
                setLabel(event.target.value);
                setFeedback(undefined);
              }}
              autoComplete="off"
              disabled={saving || disabled || !firstConcept || !secondConcept}
              required
            />
          </label>
          {firstConcept && secondConcept && (
            <p className="integration-concept-merge-summary">
              「{firstConcept.label}」と「{secondConcept.label}
              」から新しいConceptを作成します。
              元ConceptとProvenanceはDBに保持されます。
            </p>
          )}
          <button type="submit" disabled={saving || disabled || !canMerge}>
            {saving ? "Merge中…" : "Merge"}
          </button>
        </form>
      )}
      {feedback && (
        <p
          className={`integration-concept-merge-feedback is-${feedback.type}`}
          role={feedback.type === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {feedback.message}
        </p>
      )}
    </section>
  );
}

function AddConceptForm({
  mapId,
  concepts,
  disabled = false,
  onCreated,
}: {
  mapId: string;
  concepts: Concept[];
  disabled?: boolean;
  onCreated: (concept: Concept) => void;
}) {
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<
    { type: "success" | "error"; message: string } | undefined
  >();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedLabel = label.trim();

    if (!trimmedLabel || saving) return;

    setSaving(true);
    setFeedback(undefined);
    const position = getNextPosition(concepts);

    try {
      const response = await apiFetch(
        `/api/maps/${encodeURIComponent(mapId)}/concepts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: trimmedLabel,
            ...position,
            clientTimestamp: new Date().toISOString(),
          }),
        },
      );

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as {
          message?: unknown;
        } | null;
        const message =
          response.status === 404
            ? "マップが見つからないため、Conceptを保存できませんでした。"
            : typeof errorBody?.message === "string"
              ? uiText(errorBody.message)
              : "Conceptを保存できませんでした。時間をおいて再度お試しください。";

        setFeedback({ type: "error", message });
        return;
      }

      const concept = (await response.json()) as Concept;
      onCreated(concept);
      setLabel("");
      setFeedback({ type: "success", message: "Conceptを追加しました。" });
    } catch {
      setFeedback({
        type: "error",
        message:
          "保存結果を確認できませんでした。接続を確認してからマップを再読み込みしてください。",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="add-concept-form" onSubmit={handleSubmit}>
      <label htmlFor="concept-label">Conceptを追加</label>
      <div className="add-concept-controls">
        <input
          id="concept-label"
          name="label"
          type="text"
          autoComplete="off"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Concept名を入力"
          disabled={saving || disabled}
          required
        />
        <button type="submit" disabled={saving || disabled || !label.trim()}>
          {saving ? "保存中…" : "追加"}
        </button>
      </div>
      {feedback && (
        <p
          className={`form-feedback is-${feedback.type}`}
          role={feedback.type === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {feedback.message}
        </p>
      )}
    </form>
  );
}

function AddLinkForm({
  disabled,
  onStart,
}: {
  disabled: boolean;
  onStart: (label: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [feedback, setFeedback] = useState<
    { type: "success" | "error"; message: string } | undefined
  >();

  function cancel() {
    setIsOpen(false);
    setLabel("");
    setFeedback(undefined);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;

    if (!label.trim()) {
      setFeedback({ type: "error", message: "Link labelを入力してください。" });
      return;
    }

    onStart(label.trim());
    setIsOpen(false);
    setLabel("");
    setFeedback({
      type: "success",
      message:
        "Link部品をCanvasへ追加しました。中央を配置し、両端をConceptへ接続してください。",
    });
  }

  return (
    <section className="add-link-section" aria-label="Link作成">
      {!isOpen && (
        <button
          className="add-link-open-button"
          type="button"
          disabled={disabled}
          onClick={() => {
            setFeedback(undefined);
            setIsOpen(true);
          }}
        >
          Linkを追加
        </button>
      )}
      {isOpen && (
        <form className="add-link-form" onSubmit={handleSubmit}>
          <div className="add-link-fields">
            <label htmlFor="link-label">
              Link label
              <input
                id="link-label"
                name="label"
                type="text"
                autoComplete="off"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="例: 行う"
                disabled={disabled}
                required
              />
            </label>
          </div>
          <div className="add-link-actions">
            <button
              className="add-link-submit-button"
              type="submit"
              disabled={disabled || !label.trim()}
            >
              Link部品を追加
            </button>
            <button
              className="add-link-cancel-button"
              type="button"
              onClick={cancel}
              disabled={disabled}
            >
              キャンセル
            </button>
          </div>
          {feedback && (
            <p
              className={`form-feedback is-${feedback.type}`}
              role={feedback.type === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {feedback.message}
            </p>
          )}
        </form>
      )}
      {!isOpen && feedback && (
        <p
          className={`form-feedback is-${feedback.type}`}
          role={feedback.type === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {feedback.message}
        </p>
      )}
    </section>
  );
}

function IntegrationKitAssignmentPanel({
  availableKitDefinitions,
  disabled,
  onAssignKit,
}: {
  availableKitDefinitions: KitDefinitionOption[];
  disabled: boolean;
  onAssignKit: (kitDefinitionId: string) => Promise<void>;
}) {
  const [selectedKitDefinitionId, setSelectedKitDefinitionId] = useState(
    availableKitDefinitions[0]?.id ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<
    { type: "success" | "error" | "saving"; message: string } | undefined
  >();

  async function handleAssignKit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedKitDefinitionId || saving || disabled) return;

    setSaving(true);
    setFeedback({ type: "saving", message: "KitDefinitionを設定中…" });
    try {
      await onAssignKit(selectedKitDefinitionId);
      setFeedback({
        type: "success",
        message: "KitDefinitionを設定しました。",
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "KitDefinitionを設定できませんでした。",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="integration-kit-concepts" aria-label="Kit選択">
      <div className="integration-kit-heading">
        <div>
          <h3>活動で使うKit</h3>
          <p>Kitを設定すると、ConceptとLinking WordのPaletteが表示されます。</p>
        </div>
      </div>
      {availableKitDefinitions.length === 0 ? (
        <p className="integration-kit-empty">
          選択できるKitDefinitionがありません。Goal
          マップからKitを作成してください。
        </p>
      ) : (
        <form
          className="integration-kit-select-form"
          onSubmit={handleAssignKit}
        >
          <label htmlFor="integration-kit-definition">
            KitDefinition
            <select
              id="integration-kit-definition"
              value={selectedKitDefinitionId}
              onChange={(event) =>
                setSelectedKitDefinitionId(event.target.value)
              }
              disabled={saving || disabled}
              required
            >
              {availableKitDefinitions.map((kit) => (
                <option key={kit.id} value={kit.id}>
                  {kit.name}（{kit.id}）
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={saving || disabled || !selectedKitDefinitionId}
          >
            {saving ? "設定中…" : "Kitを設定"}
          </button>
        </form>
      )}
      {feedback && (
        <p
          className={`integration-kit-feedback is-${feedback.type}`}
          role={feedback.type === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {feedback.message}
        </p>
      )}
    </section>
  );
}

function getNextPosition(concepts: Concept[]) {
  const maxSlots = concepts.length * 3 + 3;

  for (let slot = 0; slot < maxSlots; slot += 1) {
    const positionX = 80 + (slot % 3) * 300;
    const positionY = 100 + Math.floor(slot / 3) * 140;
    const isOccupied = concepts.some(
      (concept) =>
        Math.abs(concept.positionX - positionX) < 200 &&
        Math.abs(concept.positionY - positionY) < 110,
    );

    if (!isOccupied) return { positionX, positionY };
  }

  return { positionX: 80, positionY: 100 + concepts.length * 140 };
}

function getInitialConceptPosition(concepts: Concept[]): ConceptPosition {
  const candidates: ConceptPosition[] = [
    { positionX: 380, positionY: 220 },
    { positionX: 80, positionY: 100 },
    { positionX: 680, positionY: 100 },
    { positionX: 80, positionY: 380 },
    { positionX: 680, positionY: 380 },
    { positionX: 380, positionY: 60 },
    { positionX: 380, positionY: 390 },
  ];
  const openPosition = candidates.find(
    (candidate) =>
      !concepts.some(
        (concept) =>
          Math.abs(concept.positionX - candidate.positionX) < 200 &&
          Math.abs(concept.positionY - candidate.positionY) < 110,
      ),
  );

  return openPosition ?? getNextPosition(concepts);
}
