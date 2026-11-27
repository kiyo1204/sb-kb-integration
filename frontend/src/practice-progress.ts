import { useCallback, useRef, useState } from "react";
import { getAccessToken } from "./auth-client";
import { requestDigest } from "./client-identity";

export type PracticeStep = "PRIOR" | "KB" | "INTEGRATION";
export type PracticeRecordStep = PracticeStep | "navigation";

export type PracticeConcept = {
  id: string;
  label: string;
  positionX: number;
  positionY: number;
  createdAt: string;
  updatedAt: string;
};

export type PracticeLink = {
  id: string;
  mapId: string;
  sourceConceptId: string;
  targetConceptId: string;
  label: string;
};

export type SbPracticeProgress = {
  taskSetVersion?: 2;
  concepts: PracticeConcept[];
  links: PracticeLink[];
  completedTasks: Array<"concept.add" | "concept.move" | "concept.rename" | "link.add">;
  linkCreation: { id: string; label: string } | null;
};

export type KitConceptPlacement = {
  kitConceptItemId: string;
  concept: PracticeConcept;
};

export type KitLinkPlacement = {
  kitLinkItemId: string;
  link: PracticeLink;
};

export type KitPracticeResult = {
  matched: boolean;
  concepts: { matched: number; total: number };
  relations: { matched: number; total: number };
};

export type KitPracticeProgress = {
  placedConcepts: KitConceptPlacement[];
  placedLinks: KitLinkPlacement[];
  completedTasks: Array<"kit.place" | "kit.judge" | "kit.correct" | "kit.rejudge">;
  hasFullPlacementMismatch: boolean;
  correctedAfterMismatch: boolean;
  successfulRejudge: boolean;
  lastResult: { result: KitPracticeResult; mapSignature: string } | null;
};

export type IntegrationPracticeConcept = PracticeConcept & {
  isMergeResult?: boolean;
  practiceOrigin: "SB" | "KB" | "MERGED";
  mergedSourceIds?: [string, string];
};

export type IntegrationPracticeProgress = {
  concepts: IntegrationPracticeConcept[];
  completed: Array<"identify" | "merge" | "submit">;
  submitted: boolean;
};

export type PracticeNavigation = { mode: PracticeStep };

export const photosynthesisKitConcepts = [
  { kitConceptItemId: "77777777-7777-4777-8777-777777777781", label: "植物" },
  { kitConceptItemId: "77777777-7777-4777-8777-777777777782", label: "光合成" },
  { kitConceptItemId: "77777777-7777-4777-8777-777777777783", label: "二酸化炭素" },
] as const;

export const photosynthesisKitLinks = [
  { kitLinkItemId: "88888888-8888-4888-8888-888888888882", label: "行う" },
  { kitLinkItemId: "88888888-8888-4888-8888-888888888883", label: "必要とする" },
] as const;

export const practiceIntegrationMapId = "practice-integration";
export const practiceSbPhotosynthesisId = "practice-sb-photosynthesis";
export const practiceKbPhotosynthesisId = "practice-kb-photosynthesis";

const storagePrefix = "sbkb-practice-progress-v1:";
const maxSerializedLength = 1_000_000;
const legacySbTaskKeys = ["concept.add", "concept.move", "link.add"] as const;
const sbTaskKeys = new Set([ ...legacySbTaskKeys, "concept.rename"]);
const kitTaskKeys = new Set(["kit.place", "kit.judge", "kit.correct", "kit.rejudge"]);
const integrationTaskKeys = new Set(["identify", "merge", "submit"]);
const stepKeys = new Set<PracticeStep>(["PRIOR", "KB", "INTEGRATION"]);
const conceptItems = new Map<string, string>(photosynthesisKitConcepts.map((item) => [item.kitConceptItemId, item.label]));
const linkItems = new Map<string, string>(photosynthesisKitLinks.map((item) => [item.kitLinkItemId, item.label]));

export function createInitialSbPracticeProgress(): SbPracticeProgress {
  return { taskSetVersion: 2, concepts: [], links: [], completedTasks: [], linkCreation: null };
}

export function createInitialKitPracticeProgress(): KitPracticeProgress {
  return {
    placedConcepts: [
      {
        kitConceptItemId: photosynthesisKitConcepts[0].kitConceptItemId,
        concept: {
          id: "practice-kit-plant",
          label: "植物",
          positionX: 100,
          positionY: 120,
          createdAt: "",
          updatedAt: "",
        },
      },
      {
        kitConceptItemId: photosynthesisKitConcepts[1].kitConceptItemId,
        concept: {
          id: "practice-kit-photosynthesis",
          label: "光合成",
          positionX: 420,
          positionY: 220,
          createdAt: "",
          updatedAt: "",
        },
      },
    ],
    placedLinks: [
      {
        kitLinkItemId: photosynthesisKitLinks[0].kitLinkItemId,
        link: {
          id: "practice-kit-perform",
          mapId: "tutorial-photosynthesis-kb",
          sourceConceptId: "practice-kit-plant",
          targetConceptId: "practice-kit-photosynthesis",
          label: "行う",
        },
      },
    ],
    completedTasks: [],
    hasFullPlacementMismatch: false,
    correctedAfterMismatch: false,
    successfulRejudge: false,
    lastResult: null,
  };
}

export function createInitialIntegrationPracticeProgress(): IntegrationPracticeProgress {
  return {
    concepts: [
      {
        id: practiceSbPhotosynthesisId,
        label: "光合成",
        positionX: 100,
        positionY: 100,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        practiceOrigin: "SB",
      },
      {
        id: practiceKbPhotosynthesisId,
        label: "光合成",
        positionX: 440,
        positionY: 170,
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        practiceOrigin: "KB",
      },
    ],
    completed: [],
    submitted: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isUniqueStringArray(value: unknown, allowed: Set<string>): value is string[] {
  return Array.isArray(value) && value.length <= allowed.size &&
    value.every((item) => typeof item === "string" && allowed.has(item)) &&
    new Set(value).size === value.length;
}

function isPracticeId(value: unknown) {
  return typeof value === "string" && /^practice-[A-Za-z0-9-]{1,100}$/.test(value);
}

function isFinitePosition(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

function isPracticeConcept(value: unknown): value is PracticeConcept {
  if (!isRecord(value) || !hasKeys(value, ["id", "label", "positionX", "positionY", "createdAt", "updatedAt"])) return false;
  return isPracticeId(value.id) && typeof value.label === "string" && value.label.length <= 2_000 &&
    isFinitePosition(value.positionX) && isFinitePosition(value.positionY) &&
    typeof value.createdAt === "string" && value.createdAt.length <= 100 &&
    typeof value.updatedAt === "string" && value.updatedAt.length <= 100;
}

function isPracticeLink(value: unknown, mapId: string): value is PracticeLink {
  if (!isRecord(value) || !hasKeys(value, ["id", "mapId", "sourceConceptId", "targetConceptId", "label"])) return false;
  return isPracticeId(value.id) && value.mapId === mapId && isPracticeId(value.sourceConceptId) &&
    isPracticeId(value.targetConceptId) && typeof value.label === "string" && value.label.length <= 2_000;
}

export function isValidSbPracticeProgress(value: unknown): value is SbPracticeProgress {
  const legacyKeys = ["concepts", "links", "completedTasks", "linkCreation"];
  if (!isRecord(value) || !(hasKeys(value, legacyKeys) || hasKeys(value, [...legacyKeys, "taskSetVersion"]))) return false;
  if (Object.hasOwn(value, "taskSetVersion") && value.taskSetVersion !== 2) return false;
  if (!Array.isArray(value.concepts) || value.concepts.length > 200 || !value.concepts.every(isPracticeConcept)) return false;
  if (!Array.isArray(value.links) || value.links.length > 500 || !value.links.every((link) => isPracticeLink(link, "practice"))) return false;
  const conceptIds = new Set(value.concepts.map((concept) => (concept as PracticeConcept).id));
  if (conceptIds.size !== value.concepts.length) return false;
  const linkIds = new Set(value.links.map((link) => (link as PracticeLink).id));
  if (linkIds.size !== value.links.length || value.links.some((link) => {
    const item = link as PracticeLink;
    return !conceptIds.has(item.sourceConceptId) || !conceptIds.has(item.targetConceptId);
  })) return false;
  if (!isUniqueStringArray(value.completedTasks, sbTaskKeys)) return false;
  if (value.taskSetVersion === undefined && value.completedTasks.includes("concept.rename")) return false;
  if (value.linkCreation !== null) {
    if (!isRecord(value.linkCreation) || !hasKeys(value.linkCreation, ["id", "label"])) return false;
    const draftId = value.linkCreation.id;
    if (typeof draftId !== "string" || !isPracticeId(draftId) || typeof value.linkCreation.label !== "string" ||
      value.linkCreation.label.length > 2_000 || linkIds.has(draftId)) return false;
  }
  return true;
}

function isKitResult(value: unknown): value is KitPracticeResult {
  if (!isRecord(value) || !hasKeys(value, ["matched", "concepts", "relations"]) || typeof value.matched !== "boolean") return false;
  const validCount = (count: unknown, total: number) => isRecord(count) && hasKeys(count, ["matched", "total"]) &&
    count.total === total && Number.isInteger(count.matched) && (count.matched as number) >= 0 && (count.matched as number) <= total;
  if (!validCount(value.concepts, 3) || !validCount(value.relations, 2)) return false;
  const concepts = value.concepts as { matched: number; total: number };
  const relations = value.relations as { matched: number; total: number };
  return !value.matched || (concepts.matched === 3 && relations.matched === 2);
}

export function kitPracticeMapSignature(progress: Pick<KitPracticeProgress, "placedConcepts" | "placedLinks">) {
  return JSON.stringify({
    concepts: progress.placedConcepts.map(({ kitConceptItemId, concept }) => ({ kitConceptItemId, concept }))
      .sort((a, b) => a.kitConceptItemId.localeCompare(b.kitConceptItemId)),
    links: progress.placedLinks.map(({ kitLinkItemId, link }) => ({ kitLinkItemId, link }))
      .sort((a, b) => a.kitLinkItemId.localeCompare(b.kitLinkItemId)),
  });
}

export function isValidKitPracticeProgress(value: unknown): value is KitPracticeProgress {
  if (!isRecord(value) || !hasKeys(value, [
    "placedConcepts", "placedLinks", "completedTasks", "hasFullPlacementMismatch",
    "correctedAfterMismatch", "successfulRejudge", "lastResult",
  ])) return false;
  if (!Array.isArray(value.placedConcepts) || value.placedConcepts.length > 3 ||
    !Array.isArray(value.placedLinks) || value.placedLinks.length > 2) return false;
  const concepts = value.placedConcepts as unknown[];
  const links = value.placedLinks as unknown[];
  const conceptIds = new Set<string>();
  const conceptParts = new Set<string>();
  for (const item of concepts) {
    if (!isRecord(item) || !hasKeys(item, ["kitConceptItemId", "concept"]) ||
      typeof item.kitConceptItemId !== "string" || !conceptItems.has(item.kitConceptItemId) ||
      !isPracticeConcept(item.concept)) return false;
    const concept = item.concept;
    if (concept.label !== conceptItems.get(item.kitConceptItemId) || conceptIds.has(concept.id) || conceptParts.has(item.kitConceptItemId)) return false;
    conceptIds.add(concept.id);
    conceptParts.add(item.kitConceptItemId);
  }
  const linkIds = new Set<string>();
  const linkParts = new Set<string>();
  for (const item of links) {
    if (!isRecord(item) || !hasKeys(item, ["kitLinkItemId", "link"]) ||
      typeof item.kitLinkItemId !== "string" || !linkItems.has(item.kitLinkItemId) ||
      !isPracticeLink(item.link, "tutorial-photosynthesis-kb")) return false;
    const link = item.link;
    if (link.label !== linkItems.get(item.kitLinkItemId) || linkIds.has(link.id) || linkParts.has(item.kitLinkItemId) ||
      !conceptIds.has(link.sourceConceptId) || !conceptIds.has(link.targetConceptId)) return false;
    linkIds.add(link.id);
    linkParts.add(item.kitLinkItemId);
  }
  if (!isUniqueStringArray(value.completedTasks, kitTaskKeys) ||
    typeof value.hasFullPlacementMismatch !== "boolean" || typeof value.correctedAfterMismatch !== "boolean" ||
    typeof value.successfulRejudge !== "boolean") return false;
  const completed = new Set(value.completedTasks as string[]);
  if ((value.hasFullPlacementMismatch && !completed.has("kit.judge")) ||
    completed.has("kit.correct") !== value.correctedAfterMismatch ||
    completed.has("kit.rejudge") !== value.successfulRejudge ||
    (value.correctedAfterMismatch && !value.hasFullPlacementMismatch) ||
    (value.successfulRejudge && !value.correctedAfterMismatch)) return false;
  if (value.lastResult !== null) {
    if (!isRecord(value.lastResult) || !hasKeys(value.lastResult, ["result", "mapSignature"]) ||
      !isKitResult(value.lastResult.result) || typeof value.lastResult.mapSignature !== "string" ||
      value.lastResult.mapSignature.length > 100_000) return false;
  }
  return true;
}

export function isValidIntegrationPracticeProgress(value: unknown): value is IntegrationPracticeProgress {
  if (!isRecord(value) || !hasKeys(value, ["concepts", "completed", "submitted"]) ||
    !Array.isArray(value.concepts) || value.concepts.length < 1 || value.concepts.length > 3 ||
    !isUniqueStringArray(value.completed, integrationTaskKeys) || typeof value.submitted !== "boolean") return false;
  const concepts = value.concepts as unknown[];
  const ids = new Set<string>();
  const sources = new Set<string>();
  let merged: IntegrationPracticeConcept | null = null;
  for (const item of concepts) {
    if (!isRecord(item)) return false;
    const mergedShape = Object.hasOwn(item, "isMergeResult") || Object.hasOwn(item, "mergedSourceIds");
    if (!hasKeys(item, mergedShape
      ? ["id", "label", "positionX", "positionY", "createdAt", "updatedAt", "practiceOrigin", "isMergeResult", "mergedSourceIds"]
      : ["id", "label", "positionX", "positionY", "createdAt", "updatedAt", "practiceOrigin"])) return false;
    if (!isPracticeId(item.id) || typeof item.label !== "string" || item.label.length > 2_000 ||
      !isFinitePosition(item.positionX) || !isFinitePosition(item.positionY) ||
      typeof item.createdAt !== "string" || typeof item.updatedAt !== "string" ||
      !["SB", "KB", "MERGED"].includes(String(item.practiceOrigin)) || ids.has(String(item.id))) return false;
    ids.add(String(item.id));
    const concept = item as IntegrationPracticeConcept;
    if (concept.practiceOrigin === "MERGED") {
      if (concept.id === practiceSbPhotosynthesisId || concept.id === practiceKbPhotosynthesisId ||
        concept.isMergeResult !== true || !Array.isArray(concept.mergedSourceIds) ||
        concept.mergedSourceIds.length !== 2 || !concept.mergedSourceIds.includes(practiceSbPhotosynthesisId) ||
        !concept.mergedSourceIds.includes(practiceKbPhotosynthesisId)) return false;
      merged = concept;
    } else {
      const expectedId = concept.practiceOrigin === "SB" ? practiceSbPhotosynthesisId : practiceKbPhotosynthesisId;
      if (concept.id !== expectedId || concept.label !== "光合成" || sources.has(concept.practiceOrigin)) return false;
      sources.add(concept.practiceOrigin);
    }
  }
  const completed = new Set(value.completed as string[]);
  if (completed.has("merge") !== (merged !== null) || completed.has("identify") !== (completed.has("merge") || sources.size === 2) ||
    completed.has("submit") !== value.submitted ||
    (value.submitted && (!merged || !completed.has("identify") || !completed.has("merge"))) ||
    (!merged && sources.size !== 2)) return false;
  return true;
}

export function isValidPracticeNavigation(value: unknown): value is PracticeNavigation {
  return isRecord(value) && hasKeys(value, ["mode"]) &&
    typeof value.mode === "string" && stepKeys.has(value.mode as PracticeStep);
}

export function isPracticeStepComplete(step: PracticeStep, value: unknown) {
  if (step === "PRIOR") {
    if (!isValidSbPracticeProgress(value)) return false;
    const requiredTasks = value.taskSetVersion === undefined
      ? legacySbTaskKeys
      : [...legacySbTaskKeys.slice(0, 2), "concept.rename", legacySbTaskKeys[2]];
    return requiredTasks.every((key) => value.completedTasks.includes(key as SbPracticeProgress["completedTasks"][number]));
  }
  if (step === "KB") return isValidKitPracticeProgress(value) && value.successfulRejudge &&
    ["kit.place", "kit.judge", "kit.correct", "kit.rejudge"].every((key) => value.completedTasks.includes(key as KitPracticeProgress["completedTasks"][number]));
  return isValidIntegrationPracticeProgress(value) && value.submitted &&
    ["identify", "merge", "submit"].every((key) => value.completed.includes(key as IntegrationPracticeProgress["completed"][number]));
}

export type PracticeStorageStatus = "ready" | "disabled" | "corrupt" | "unavailable" | "write-error";
export type PracticeRecordRead<T> = { value: T; status: PracticeStorageStatus; stored: boolean };

export function getPracticeOwnerDigest() {
  try {
    const token = getAccessToken();
    return token ? requestDigest(token) : null;
  } catch {
    return null;
  }
}

function storageKey(sessionId: string, step: PracticeRecordStep, ownerDigest: string | null) {
  return ownerDigest ? `${storagePrefix}${sessionId}:${ownerDigest}:${step}` : null;
}

export function readPracticeRecord<T>(
  sessionId: string | undefined,
  step: PracticeRecordStep,
  initial: () => T,
  validate: (value: unknown) => value is T,
  ownerDigest = getPracticeOwnerDigest(),
): PracticeRecordRead<T> {
  if (!sessionId) return { value: initial(), status: "disabled", stored: false };
  const key = storageKey(sessionId, step, ownerDigest);
  if (!key) return { value: initial(), status: "unavailable", stored: false };
  let serialized: string | null;
  try {
    serialized = sessionStorage.getItem(key);
  } catch {
    return { value: initial(), status: "unavailable", stored: false };
  }
  if (serialized === null) return { value: initial(), status: "ready", stored: false };
  if (serialized.length > maxSerializedLength) return { value: initial(), status: "corrupt", stored: true };
  let envelope: unknown;
  try {
    envelope = JSON.parse(serialized);
  } catch {
    return { value: initial(), status: "corrupt", stored: true };
  }
  if (!isRecord(envelope) || !hasKeys(envelope, ["version", "sessionId", "step", "value"]) ||
    envelope.version !== 1 || envelope.sessionId !== sessionId || envelope.step !== step ||
    !validate(envelope.value)) return { value: initial(), status: "corrupt", stored: true };
  return { value: envelope.value, status: "ready", stored: true };
}

export function writePracticeRecord<T>(
  sessionId: string | undefined,
  step: PracticeRecordStep,
  value: T,
  ownerDigest = getPracticeOwnerDigest(),
) {
  if (!sessionId) return true;
  try {
    const key = storageKey(sessionId, step, ownerDigest);
    if (!key) return false;
    const serialized = JSON.stringify({ version: 1, sessionId, step, value });
    if (serialized.length > maxSerializedLength) return false;
    sessionStorage.setItem(key, serialized);
    return true;
  } catch {
    return false;
  }
}

export function removePracticeRecord(
  sessionId: string | undefined,
  step: PracticeRecordStep,
  ownerDigest = getPracticeOwnerDigest(),
) {
  if (!sessionId) return true;
  try {
    const key = storageKey(sessionId, step, ownerDigest);
    if (!key) return false;
    sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function usePracticeProgress<T>(
  sessionId: string | undefined,
  step: PracticeRecordStep,
  initial: () => T,
  validate: (value: unknown) => value is T,
) {
  const [ownerDigest] = useState(getPracticeOwnerDigest);
  const [loaded] = useState(() => readPracticeRecord(sessionId, step, initial, validate, ownerDigest));
  const [value, setValue] = useState(loaded.value);
  const valueRef = useRef(loaded.value);
  const [status, setStatus] = useState<PracticeStorageStatus>(loaded.status);

  const update = useCallback((change: T | ((current: T) => T)) => {
    const next = typeof change === "function"
      ? (change as (current: T) => T)(valueRef.current)
      : change;
    if (sessionId) {
      if (status === "corrupt" || status === "unavailable") return false;
      if (getPracticeOwnerDigest() !== ownerDigest || !validate(next) || !writePracticeRecord(sessionId, step, next, ownerDigest)) {
        setStatus("write-error");
        return false;
      }
    }
    valueRef.current = next;
    setValue(next);
    if (sessionId) setStatus("ready");
    return true;
  }, [sessionId, step, status, validate, ownerDigest]);

  const retry = useCallback(() => {
    if (getPracticeOwnerDigest() !== ownerDigest) {
      setStatus("unavailable");
      return false;
    }
    const latest = readPracticeRecord(sessionId, step, initial, validate, ownerDigest);
    valueRef.current = latest.value;
    setValue(latest.value);
    setStatus(latest.status);
    return latest.status === "ready" || latest.status === "disabled";
  }, [sessionId, step, initial, validate, ownerDigest]);

  const storageBlocked = status === "corrupt" || status === "unavailable";
  return { value, valueRef, update, status, storageBlocked, retry };
}
