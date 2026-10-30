import { validateMapStateV5, validMapCoordinate } from "./research-event-map-v5.js";
import {EventExportService} from "./event-export-service.js";
import {registerDataManagement} from "./data-management.js";
import {registerEventExportRoutes} from "./event-export-routes.js";
import { registerDeliveryReports } from "./delivery-reports.js";
import { operationCommitted,reliableOperation, registerOperationContext } from "./delivery-reliability.js";
import { safeServerErrorCode } from "./safe-server-error.js";
import express, { type Request, type Response } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";
import {
  assertStageIsCurrent,
  createStage1Session,
  STAGE1_PROTOCOL_KEY,
  getSession,
  getSessionFlow,
  lockSessionStageForMap,
  lockSessionStageProgress,
  SESSION_STAGE_TYPES_BY_MAP_TYPE,
  type CurrentStageValidation,
  type SessionStageMapValidation,
} from "./sessions.js";
import { buildSessionRawExport } from "./research-export.js";
import { registerStage1AnalysisRoutes } from "./stage1-analysis.js";
import { registerAssessmentRoutes } from "./assessments.js";
import { eventTargets, insertResearchEventBestEffort, insertResearchEvent, InvalidEventError, registerResearchEventRoutes, type EventActor, type EventType } from "./research-events.js";
import { accessControl, createLearnerToken, principalOf, storeLearnerToken, tokenHash } from "./access-control.js";
import { validMapLabel } from "./research-event-map-v2.js";
import { deriveUndoRedoAvailability, historySnapshotsEqual, historyStateDelta } from "./map-undo-redo.js";
import type {
  ConceptProvenanceSnapshot,
  HistoryOperation,
  LinkProvenanceSnapshot,
  MapHistorySnapshot,
} from "./map-history.js";
import { replayMapAt } from "./map-history.js";
import { replayMixedMapHistory, type MapHistoryEventV2 } from "./map-mixed-history.js";

import { registerAudit, auditCurrent, auditCommitted, recordAudit } from "./server-audit.js";
import { observeExpiredStages } from "./system-submission.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const app = express();
const deadlineContext = new AsyncLocalStorage<{ mapIds: Set<string>; stageIds: Set<string>; actor: EventActor }>();
const transactionBefore = new WeakMap<PoolClient, Map<string, MapHistorySnapshot>>();
const pool = new Pool({ connectionString: databaseUrl });
const port = Number(process.env.PORT ?? 3000);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RETIRED_DEVELOPMENT_KIT_ID = "66666666-6666-4666-8666-666666666661";

type MapType = "GOAL" | "PRIOR" | "KB" | "INTEGRATION";
type MapStatus = "DRAFT" | "SUBMITTED";
type LockedMapState = {
  mapId: string;
  mapType: MapType;
  mapStatus: MapStatus;
  submittedAt: Date | null;
  sessionStageId: string | null;
  sessionStatus: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | null;
  sessionStageStatus: "PENDING" | "IN_PROGRESS" | "COMPLETED" | null;
  currentStageId: string | null;
  hasKitDefinition: boolean;
};
type SubmittedMapRow = {
  id: string;
  type: MapType;
  status: MapStatus;
  submittedAt: Date;
};
type MapSubmitOutcome =
  | { kind: "submitted"; map: SubmittedMapRow; activityLogSaved: boolean | null }
  | { kind: "automatic_submission_required" }
  | { kind: "time_expired" }
  | { kind: "map_not_found" }
  | { kind: "map_type_not_supported"; mapType: MapType }
  | { kind: "kit_build_not_matched"; feedback: KitBuildFeedbackWithSignature; logSaved: boolean | null }
  | { kind: "session_stage_not_found" }
  | {
      kind: "session_stage_type_mismatch";
      expectedStageType: string;
      actualStageType: string;
    }
  | { kind: "session_not_in_progress"; sessionStatus: string }
  | { kind: "session_stage_not_in_progress"; stageStatus: string }
  | { kind: "session_stage_not_current"; currentStageId: string | null }
  | {
      kind: "map_already_submitted";
      mapType: "PRIOR" | "KB" | "INTEGRATION";
      submittedAt: Date | null;
    };
type IntegrationMapRow = {
  id: string;
  type: "INTEGRATION";
  status: MapStatus;
  basedOnMapId: string;
  sessionStageId: string | null;
  submittedAt: Date | null;
};
type PriorConceptToClone = {
  id: string;
  label: string;
  positionX: number;
  positionY: number;
};
type PriorLinkToClone = {
  id: string;
  sourceConceptId: string;
  targetConceptId: string;
  label: string;
};
type IntegrationCreateOutcome =
  | { kind: "created"; map: IntegrationMapRow }
  | { kind: "existing"; map: IntegrationMapRow }
  | { kind: "time_expired" }
  | { kind: "map_not_found" }
  | { kind: "session_stage_not_found" }
  | { kind: "session_stage_type_mismatch"; stageType: string }
  | { kind: "session_stage_already_assigned" }
  | { kind: "prior_session_stage_required" }
  | { kind: "integration_stage_required" }
  | { kind: "prior_session_stage_invalid" }
  | { kind: "session_mismatch" }
  | { kind: "existing_integration_conflict" }
  | { kind: "map_type_not_supported"; mapType: MapType }
  | { kind: "prior_map_not_submitted" }
  | { kind: "session_not_in_progress"; sessionStatus: string }
  | { kind: "session_stage_not_current"; currentStageId: string | null }
  | { kind: "session_stage_not_in_progress"; status: string }
  | { kind: "invalid_prior_graph" };

class SubmittedPriorMapError extends Error {
  constructor() {
    super("Submitted Prior Maps are read-only");
    this.name = "SubmittedPriorMapError";
  }
}

class SubmittedKBMapError extends Error {
  constructor() {
    super("Submitted KB Maps are read-only");
    this.name = "SubmittedKBMapError";
  }
}

class SubmittedIntegrationMapError extends Error {
  constructor() {
    super("Submitted Integration Maps are read-only");
    this.name = "SubmittedIntegrationMapError";
  }
}

class SessionFlowGuardError extends Error {
  constructor() {
    super("This Session Stage is not currently available");
    this.name = "SessionFlowGuardError";
  }
}

class KitSourceGoalMapError extends Error {
  constructor() {
    super("Goal Maps referenced by a Kit are read-only");
    this.name = "KitSourceGoalMapError";
  }
}

class KBMapPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "KBMapPolicyError";
  }
}

class MergedConceptError extends Error {
  constructor() {
    super("Merged Concepts cannot be edited or used as Link endpoints");
    this.name = "MergedConceptError";
  }
}

class MergeResultProtectedError extends Error {
  constructor() {
    super("Concepts referenced by a Merge cannot be deleted");
    this.name = "MergeResultProtectedError";
  }
}

class ConceptMergeConflictError extends Error {
  constructor() {
    super("A Concept selected for Merge is no longer active");
    this.name = "ConceptMergeConflictError";
  }
}

class HistoryTransitionError extends Error {}

function ensureMapIsEditable(map: LockedMapState) {
  if (map.mapType === "PRIOR" && map.mapStatus === "SUBMITTED") {
    throw new SubmittedPriorMapError();
  }

  if (map.mapType === "KB" && map.mapStatus === "SUBMITTED") {
    throw new SubmittedKBMapError();
  }

  if (map.mapType === "INTEGRATION" && map.mapStatus === "SUBMITTED") {
    throw new SubmittedIntegrationMapError();
  }

  if (
    map.sessionStageId !== null &&
    (map.sessionStatus !== "IN_PROGRESS" ||
      map.sessionStageStatus !== "IN_PROGRESS" ||
      map.currentStageId !== map.sessionStageId)
  ) {
    throw new SessionFlowGuardError();
  }

  if (map.mapType === "GOAL" && map.hasKitDefinition) {
    throw new KitSourceGoalMapError();
  }
}

function ensureConceptStructureEditable(map: LockedMapState) {
  ensureMapIsEditable(map);
  if (map.mapType === "KB") {
    throw new KBMapPolicyError(
      "kb_concept_structure_read_only",
      "KB MapではConceptを追加・編集・削除できません。",
    );
  }
}

function ensureFreeLinkCreationAllowed(map: LockedMapState) {
  ensureMapIsEditable(map);
  if (map.mapType === "KB") {
    throw new KBMapPolicyError(
      "kb_kit_link_required",
      "KB MapではKit Link部品からLinkを作成してください。",
    );
  }
}

function ensureLinkLabelEditable(map: LockedMapState) {
  ensureMapIsEditable(map);
  if (map.mapType === "KB") {
    throw new KBMapPolicyError(
      "kb_link_label_read_only",
      "KB MapのLink labelはKit由来のため編集できません。",
    );
  }
}

function readOnlyMapResponse(response: Response, error: unknown) {
  if (error instanceof HistoryTransitionError) return response.status(409).json({ error: "map_history_unavailable", message: error.message });
  if (error instanceof InvalidEventError) return response.status(400).json({ error: "invalid_map_state", message: "マップの内容を確認してください。URLや認証情報を名前に含めることはできません。" });
  if (error instanceof SessionFlowGuardError) {
    return response.status(409).json({
      error: "session_stage_not_current",
      message: "現在のStageではないため、このMapを変更できません。",
    });
  }
  if (error instanceof MergedConceptError) {
    return response.status(409).json({
      error: "concept_merged",
      message:
        "Merge済みのConceptは通常操作できません。Mapを再読み込みしてください。",
    });
  }

  if (error instanceof MergeResultProtectedError) {
    return response.status(409).json({
      error: "concept_merge_result_protected",
      message: "Merge lineageを保持するため、このConceptは削除できません。",
    });
  }

  if (error instanceof ConceptMergeConflictError) {
    return response.status(409).json({
      error: "concept_merge_conflict",
      message:
        "選択したConceptは既にMergeされています。Mapを再読み込みしてください。",
    });
  }

  if (error instanceof SubmittedPriorMapError) {
    return response.status(409).json({
      error: "prior_map_read_only",
      message: "提出済みのPrior Mapは変更できません。",
    });
  }

  if (error instanceof SubmittedKBMapError) {
    return response.status(409).json({
      error: "kb_map_read_only",
      message: "提出済みのKB Mapは変更できません。",
    });
  }

  if (error instanceof SubmittedIntegrationMapError) {
    return response.status(409).json({
      error: "integration_map_read_only",
      message: "提出済みのIntegration Mapは変更できません。",
    });
  }

  if (error instanceof KitSourceGoalMapError) {
    return response.status(409).json({
      error: "goal_map_kit_source_read_only",
      message: "Kitの参照元になっているGoal Mapは変更できません。",
    });
  }

  if (error instanceof KBMapPolicyError) {
    return response.status(409).json({
      error: error.code,
      message: error.message,
    });
  }

  return null;
}

function sessionStageMapResponse(
  response: Response,
  outcome:
    | SessionStageMapValidation
    | { kind: "session_stage_not_found" }
    | { kind: "session_stage_type_mismatch"; stageType: string }
    | { kind: "session_stage_already_assigned" },
) {
  if (
    outcome.kind === "session_stage_not_found" ||
    outcome.kind === "not_found"
  ) {
    return response.status(404).json({
      error: "session_stage_not_found",
      message: "SessionStageが見つかりません。",
    });
  }
  if (
    outcome.kind === "session_stage_type_mismatch" ||
    outcome.kind === "type_mismatch"
  ) {
    return response.status(422).json({
      error: "session_stage_type_mismatch",
      message: "このMapを作成できるSessionStageではありません。",
      stageType: outcome.stageType,
    });
  }
  if (
    outcome.kind === "session_stage_already_assigned" ||
    outcome.kind === "already_assigned"
  ) {
    return response.status(409).json({
      error: "session_stage_already_assigned",
      message: "このSessionStageには既にMapが紐付いています。",
    });
  }
  if (outcome.kind === "session_not_in_progress") {
    return response.status(409).json({
      error: "session_not_in_progress",
      message: "Sessionを開始してからMapを作成してください。",
      status: outcome.sessionStatus,
    });
  }
  if (outcome.kind === "stage_not_current") {
    return response.status(409).json({
      error: "session_stage_not_current",
      message: "現在のStageではないためMapを作成できません。",
      currentStageId: outcome.currentStageId,
    });
  }
  if (outcome.kind === "stage_not_in_progress") {
    return response.status(409).json({
      error: "session_stage_not_in_progress",
      message: "Stageを開始してからMapを作成してください。",
      status: outcome.status,
    });
  }
  return response.status(500).json({
    error: "unexpected_session_stage_validation",
  });
}

function currentStageConflictResponse(
  response: Response,
  outcome: Exclude<CurrentStageValidation, { kind: "ready" }>,
) {
  if (outcome.kind === "session_not_in_progress") {
    return response.status(409).json({
      error: "session_not_in_progress",
      message: "Sessionを開始してからStageを操作してください。",
      status: outcome.sessionStatus,
    });
  }
  return response.status(409).json({
    error: "session_stage_not_current",
    message: "現在のStageではありません。前のStageを完了してください。",
    currentStageId: outcome.currentStageId,
  });
}

type MapConceptRow = {
  mapId: string;
  mapType: MapType;
  mapStatus: MapStatus;
  mapTitle: string | null;
  mapCreatedAt: Date;
  mapSubmittedAt: Date | null;
  basedOnMapId: string | null;
  kitDefinitionId: string | null;
  kitDefinitionName: string | null;
  sessionStageId: string | null;
  sessionId: string | null;
  sessionStageStatus: string | null;
  sessionProtocolKey: string | null;
  conceptId: string | null;
  label: string | null;
  positionX: number | null;
  positionY: number | null;
  conceptCreatedAt: Date | null;
  conceptUpdatedAt: Date | null;
  isMergeResult: boolean;
};

type MapLinkRow = {
  labelPositionX?: number | null;
  labelPositionY?: number | null;
  id: string;
  mapId: string;
  sourceConceptId: string;
  targetConceptId: string;
  label: string;
  kitLinkItemId?: string | null;
};

type MapKitLinkRow = {
  kitLinkItemId: string;
  label: string;
  used: boolean;
};

type MapKitConceptRow = {
  kitConceptItemId: string;
  label: string;
  imported: boolean;
};

type KitDefinitionOption = {
  id: string;
  name: string;
};

type KitDefinitionRow = {
  id: string;
  goalMapId: string;
  name: string;
  createdAt: Date;
};

type KBMapRow = {
  id: string;
  type: "KB";
  status: "DRAFT";
  kitDefinitionId: string;
  basedOnMapId: string | null;
  sessionStageId: string | null;
  submittedAt: Date | null;
};

type KBInitializeOutcome =
  | { kind: "created"; map: KBMapRow; conceptCount: number }
  | { kind: "kit_not_found" }
  | { kind: "invalid_kit_source" }
  | SessionStageMapValidation;

type PriorMapRow = {
  id: string;
  type: "PRIOR";
  status: "DRAFT";
  basedOnMapId: null;
  sessionStageId: string;
  submittedAt: null;
};

type PriorMapCreateOutcome =
  { kind: "created"; map: PriorMapRow } | SessionStageMapValidation;



type CreatedLinkRow = MapLinkRow & { createdAt: Date };

type UpdatedLinkRow = MapLinkRow & { updatedAt: Date };

type LinkCreateOutcome =
  | { kind: "created"; link: CreatedLinkRow }
  | { kind: "map_not_found" }
  | { kind: "source_concept_not_found" }
  | { kind: "target_concept_not_found" }
  | { kind: "concept_map_mismatch" };

type LinkReconnectOutcome =
  | { kind: "updated"; link: UpdatedLinkRow }
  | { kind: "link_not_found" }
  | { kind: "source_concept_not_found" }
  | { kind: "target_concept_not_found" }
  | { kind: "concept_map_mismatch" };

type CreatedConceptRow = {
  id: string;
  mapId: string;
  label: string;
  positionX: number;
  positionY: number;
  createdAt: Date;
  updatedAt: Date;
};

type LockedConceptRow = CreatedConceptRow & {
  mergedIntoConceptId: string | null;
};

type ConceptSnapshot = Pick<
  CreatedConceptRow,
  "id" | "mapId" | "label" | "positionX" | "positionY"
>;

type LinkSnapshot = Pick<
  MapLinkRow,
  "id" | "mapId" | "sourceConceptId" | "targetConceptId" | "label"
>;

type OperationType =
  | "ADD_CONCEPT"
  | "IMPORT_KIT_CONCEPT"
  | "MERGE_CONCEPT"
  | "EDIT_CONCEPT"
  | "MOVE_CONCEPT"
  | "DELETE_CONCEPT"
  | "ADD_LINK"
  | "IMPORT_KIT_LINK"
  | "EDIT_LINK"
  | "DELETE_LINK"
  | "RECONNECT_LINK"
  | "MOVE_LINK"
  | "UNDO"
  | "REDO"
  | "MAP_SUBMIT"
  | "MAP_AUTO_SUBMIT"
  | "MAP_KIT_ASSIGN";

type OperationTargetType = "CONCEPT" | "LINK" | "MAP";
type OperationSnapshot = unknown;

function validateClientTimestamp(value: unknown) {
  if (value === undefined || value === null) {
    return { valid: true as const, value: null };
  }

  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
      value,
    )
  ) {
    return { valid: false as const };
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return { valid: false as const };

  return { valid: true as const, value: new Date(timestamp).toISOString() };
}

async function withTransaction<T>(
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionBefore.set(client, new Map());
    transactionStarted = true;
    const result = await reliableOperation(client, () => operation(client));
    const guarded = deadlineContext.getStore();
    if (guarded && (guarded.mapIds.size || guarded.stageIds.size)) {
      const expired = await client.query(`SELECT 1 FROM session_stages st JOIN sessions s ON s.id=st.session_id
        LEFT JOIN maps m ON m.session_stage_id=st.id AND m.type='INTEGRATION'
        WHERE s.protocol_key='STAGE1_6' AND st.stage_type='INTEGRATION_MAP'
          AND (m.id = ANY($1::uuid[]) OR st.id = ANY($2::uuid[]))
          AND clock_timestamp() >= st.started_at + s.group_activity_seconds * interval '1 second' LIMIT 1`,
        [[...guarded.mapIds], [...guarded.stageIds]]);
      if (expired.rowCount) throw new SessionFlowGuardError();
    }
    await client.query("COMMIT");
    operationCommitted();
    transactionStarted = false;
    auditCommitted();
    return result;
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    transactionBefore.delete(client);
    client.release();
  }
}

async function refreshKitDefinitionFlag(
  client: PoolClient,
  map: LockedMapState,
): Promise<LockedMapState> {
  deadlineContext.getStore()?.mapIds.add(map.mapId);
  const snapshots = transactionBefore.get(client);
  if (snapshots && map.sessionStageId && map.mapType !== "GOAL" && !snapshots.has(map.mapId)) {
    const snapshot = await readCurrentMapHistorySnapshot(client, map.mapId);
    if (snapshot) snapshots.set(map.mapId, snapshot);
  }
  const result = await client.query<{ hasKitDefinition: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM kit_definitions
        WHERE goal_map_id = $1::uuid
      ) AS "hasKitDefinition"
    `,
    [map.mapId],
  );

  return {
    ...map,
    hasKitDefinition: result.rows[0]?.hasKitDefinition ?? false,
  };
}

async function lockMapForConcept(
  client: PoolClient,
  conceptId: string,
): Promise<LockedMapState | null> {
  const result = await client.query<LockedMapState>(
    `
      SELECT
        map.id AS "mapId",
        map.type AS "mapType",
        map.status AS "mapStatus",
        map.submitted_at AS "submittedAt",
        map.session_stage_id AS "sessionStageId",
        session.status AS "sessionStatus",
        stage.status AS "sessionStageStatus",
        current_stage.id AS "currentStageId",
        EXISTS (
          SELECT 1
          FROM kit_definitions AS kit
          WHERE kit.goal_map_id = map.id
        ) AS "hasKitDefinition"
      FROM maps AS map
      INNER JOIN concepts AS concept ON concept.map_id = map.id
      LEFT JOIN session_stages AS stage ON stage.id = map.session_stage_id
      LEFT JOIN sessions AS session ON session.id = stage.session_id
      LEFT JOIN LATERAL (
        SELECT candidate.id
        FROM session_stages AS candidate
        WHERE candidate.session_id = stage.session_id
          AND candidate.status <> 'COMPLETED'
        ORDER BY candidate.order_index
        LIMIT 1
      ) AS current_stage ON true
      WHERE concept.id = $1::uuid
        AND (map.type = 'GOAL' OR (
          map.type IN ('PRIOR', 'KB', 'INTEGRATION')
          AND session.protocol_key IN ('STAGE1_4', 'STAGE1_6')
        ))
      FOR UPDATE OF map
    `,
    [conceptId],
  );

  const map = result.rows[0];
  return map ? refreshKitDefinitionFlag(client, map) : null;
}

async function lockMapForLink(
  client: PoolClient,
  linkId: string,
): Promise<LockedMapState | null> {
  const result = await client.query<LockedMapState>(
    `
      SELECT
        map.id AS "mapId",
        map.type AS "mapType",
        map.status AS "mapStatus",
        map.submitted_at AS "submittedAt",
        map.session_stage_id AS "sessionStageId",
        session.status AS "sessionStatus",
        stage.status AS "sessionStageStatus",
        current_stage.id AS "currentStageId",
        EXISTS (
          SELECT 1
          FROM kit_definitions AS kit
          WHERE kit.goal_map_id = map.id
        ) AS "hasKitDefinition"
      FROM maps AS map
      INNER JOIN links AS link ON link.map_id = map.id
      LEFT JOIN session_stages AS stage ON stage.id = map.session_stage_id
      LEFT JOIN sessions AS session ON session.id = stage.session_id
      LEFT JOIN LATERAL (
        SELECT candidate.id
        FROM session_stages AS candidate
        WHERE candidate.session_id = stage.session_id
          AND candidate.status <> 'COMPLETED'
        ORDER BY candidate.order_index
        LIMIT 1
      ) AS current_stage ON true
      WHERE link.id = $1::uuid
        AND (map.type = 'GOAL' OR (
          map.type IN ('PRIOR', 'KB', 'INTEGRATION')
          AND session.protocol_key IN ('STAGE1_4', 'STAGE1_6')
        ))
      FOR UPDATE OF map
    `,
    [linkId],
  );

  const map = result.rows[0];
  return map ? refreshKitDefinitionFlag(client, map) : null;
}

async function lockMapById(
  client: PoolClient,
  mapId: string,
): Promise<LockedMapState | null> {
  const result = await client.query<LockedMapState>(
    `
      SELECT
        map.id AS "mapId",
        map.type AS "mapType",
        map.status AS "mapStatus",
        map.submitted_at AS "submittedAt",
        map.session_stage_id AS "sessionStageId",
        session.status AS "sessionStatus",
        stage.status AS "sessionStageStatus",
        current_stage.id AS "currentStageId",
        EXISTS (
          SELECT 1
          FROM kit_definitions AS kit
          WHERE kit.goal_map_id = map.id
        ) AS "hasKitDefinition"
      FROM maps AS map
      LEFT JOIN session_stages AS stage ON stage.id = map.session_stage_id
      LEFT JOIN sessions AS session ON session.id = stage.session_id
      LEFT JOIN LATERAL (
        SELECT candidate.id
        FROM session_stages AS candidate
        WHERE candidate.session_id = stage.session_id
          AND candidate.status <> 'COMPLETED'
        ORDER BY candidate.order_index
        LIMIT 1
      ) AS current_stage ON true
      WHERE map.id = $1::uuid
        AND (map.type = 'GOAL' OR (
          map.type IN ('PRIOR', 'KB', 'INTEGRATION')
          AND session.protocol_key IN ('STAGE1_4', 'STAGE1_6')
        ))
      FOR UPDATE OF map
    `,
    [mapId],
  );

  const map = result.rows[0];
  return map ? refreshKitDefinitionFlag(client, map) : null;
}

type KitBuildFeedback = {
  configurationComplete: boolean;
  matched: boolean;
  concepts: { matched: number; total: number };
  relations: { matched: number; total: number };
  message: string;
};

type KitBuildFeedbackWithSignature = KitBuildFeedback & { mapSignature: string };

async function readKitBuildFeedback(
  client: PoolClient,
  mapId: string,
): Promise<KitBuildFeedback | null> {
  const result = await client.query<{
    kitDefinitionId: string | null;
    expectedConcepts: number;
    assignedConcepts: number;
    validAssignedConcepts: number;
    matchedConcepts: number;
    activeConcepts: number;
    expectedLinks: number;
    assignedLinks: number;
    validAssignedLinks: number;
    matchedLinks: number;
    activeLinks: number;
  }>(
    `
      SELECT
        map.kit_definition_id AS "kitDefinitionId",
        (SELECT count(*)::int
         FROM kit_definitions AS kit
         INNER JOIN concepts AS goal_concept
           ON goal_concept.map_id = kit.goal_map_id
           AND goal_concept.merged_into_concept_id IS NULL
         WHERE kit.id = map.kit_definition_id) AS "expectedConcepts",
        (SELECT count(*)::int FROM kit_concept_items AS item
         WHERE item.kit_definition_id = map.kit_definition_id) AS "assignedConcepts",
        (SELECT count(*)::int
         FROM kit_concept_items AS item
         INNER JOIN kit_definitions AS kit ON kit.id = item.kit_definition_id
         INNER JOIN concepts AS goal_concept
           ON goal_concept.id = item.source_concept_id
           AND goal_concept.map_id = kit.goal_map_id
           AND goal_concept.merged_into_concept_id IS NULL
         WHERE item.kit_definition_id = map.kit_definition_id) AS "validAssignedConcepts",
        (SELECT count(*)::int
         FROM kit_definitions AS kit
         INNER JOIN concepts AS goal_concept
           ON goal_concept.map_id = kit.goal_map_id
           AND goal_concept.merged_into_concept_id IS NULL
         WHERE kit.id = map.kit_definition_id
           AND EXISTS (
             SELECT 1 FROM kit_concept_items AS item
             WHERE item.kit_definition_id = kit.id
               AND item.source_concept_id = goal_concept.id
           )
           AND EXISTS (
             SELECT 1
             FROM concepts AS built_concept
             INNER JOIN concept_provenance AS provenance
               ON provenance.target_concept_id = built_concept.id
               AND provenance.source_concept_id = goal_concept.id
               AND provenance.relation_type = 'CLONED_FROM'
             WHERE built_concept.map_id = map.id
               AND built_concept.merged_into_concept_id IS NULL
               AND built_concept.label = goal_concept.label
           )) AS "matchedConcepts",
        (SELECT count(*)::int FROM concepts AS built_concept
         WHERE built_concept.map_id = map.id
           AND built_concept.merged_into_concept_id IS NULL) AS "activeConcepts",
        (SELECT count(*)::int
         FROM kit_definitions AS kit
         INNER JOIN links AS goal_link ON goal_link.map_id = kit.goal_map_id
         INNER JOIN concepts AS goal_source
           ON goal_source.id = goal_link.source_concept_id
           AND goal_source.map_id = kit.goal_map_id
           AND goal_source.merged_into_concept_id IS NULL
         INNER JOIN concepts AS goal_target
           ON goal_target.id = goal_link.target_concept_id
           AND goal_target.map_id = kit.goal_map_id
           AND goal_target.merged_into_concept_id IS NULL
         WHERE kit.id = map.kit_definition_id) AS "expectedLinks",
        (SELECT count(*)::int FROM kit_link_items AS item
         WHERE item.kit_definition_id = map.kit_definition_id) AS "assignedLinks",
        (SELECT count(*)::int
         FROM kit_link_items AS item
         INNER JOIN kit_definitions AS kit ON kit.id = item.kit_definition_id
         INNER JOIN links AS goal_link
           ON goal_link.id = item.source_link_id
           AND goal_link.map_id = kit.goal_map_id
         INNER JOIN concepts AS goal_source
           ON goal_source.id = goal_link.source_concept_id
           AND goal_source.map_id = kit.goal_map_id
           AND goal_source.merged_into_concept_id IS NULL
         INNER JOIN concepts AS goal_target
           ON goal_target.id = goal_link.target_concept_id
           AND goal_target.map_id = kit.goal_map_id
           AND goal_target.merged_into_concept_id IS NULL
         WHERE item.kit_definition_id = map.kit_definition_id) AS "validAssignedLinks",
        (SELECT count(*)::int
         FROM kit_definitions AS kit
         INNER JOIN links AS goal_link
           ON goal_link.map_id = kit.goal_map_id
         INNER JOIN concepts AS goal_source
           ON goal_source.id = goal_link.source_concept_id
           AND goal_source.map_id = kit.goal_map_id
           AND goal_source.merged_into_concept_id IS NULL
         INNER JOIN concepts AS goal_target
           ON goal_target.id = goal_link.target_concept_id
           AND goal_target.map_id = kit.goal_map_id
           AND goal_target.merged_into_concept_id IS NULL
         WHERE kit.id = map.kit_definition_id
           AND EXISTS (
             SELECT 1 FROM kit_link_items AS item
             WHERE item.kit_definition_id = kit.id
               AND item.source_link_id = goal_link.id
           )
           AND EXISTS (
             SELECT 1
             FROM links AS built_link
             INNER JOIN link_provenance AS link_source
               ON link_source.target_link_id = built_link.id
               AND link_source.source_link_id = goal_link.id
               AND link_source.relation_type = 'RECONSTRUCTED_FROM'
             WHERE built_link.map_id = map.id
               AND built_link.label = goal_link.label
               AND EXISTS (
                 SELECT 1
                 FROM concept_provenance AS source_provenance
                 INNER JOIN concepts AS built_source
                   ON built_source.id = source_provenance.target_concept_id
                   AND built_source.map_id = map.id
                   AND built_source.merged_into_concept_id IS NULL
                 WHERE built_source.id = built_link.source_concept_id
                   AND source_provenance.source_concept_id = goal_link.source_concept_id
                   AND source_provenance.relation_type = 'CLONED_FROM'
               )
               AND EXISTS (
                 SELECT 1
                 FROM concept_provenance AS target_provenance
                 INNER JOIN concepts AS built_target
                   ON built_target.id = target_provenance.target_concept_id
                   AND built_target.map_id = map.id
                   AND built_target.merged_into_concept_id IS NULL
                 WHERE built_target.id = built_link.target_concept_id
                   AND target_provenance.source_concept_id = goal_link.target_concept_id
                   AND target_provenance.relation_type = 'CLONED_FROM'
               )
           )) AS "matchedLinks",
        (SELECT count(*)::int
         FROM links AS built_link
         INNER JOIN concepts AS source_concept
           ON source_concept.id = built_link.source_concept_id
           AND source_concept.map_id = map.id
           AND source_concept.merged_into_concept_id IS NULL
         INNER JOIN concepts AS target_concept
           ON target_concept.id = built_link.target_concept_id
           AND target_concept.map_id = map.id
           AND target_concept.merged_into_concept_id IS NULL
         WHERE built_link.map_id = map.id) AS "activeLinks"
      FROM maps AS map
      WHERE map.id = $1::uuid AND map.type = 'KB'
    `,
    [mapId],
  );
  const counts = result.rows[0];
  if (!counts) return null;

  const conceptsMatch =
    counts.expectedConcepts > 0 &&
    counts.expectedConcepts === counts.matchedConcepts &&
    counts.expectedConcepts === counts.activeConcepts;
  const relationsMatch =
    counts.expectedLinks === counts.matchedLinks &&
    counts.expectedLinks === counts.activeLinks;
  const configurationComplete =
    counts.kitDefinitionId !== null &&
    counts.expectedConcepts > 0 &&
    counts.expectedConcepts === counts.assignedConcepts &&
    counts.assignedConcepts === counts.validAssignedConcepts &&
    counts.expectedLinks === counts.assignedLinks &&
    counts.assignedLinks === counts.validAssignedLinks;
  const matched =
    configurationComplete && conceptsMatch && relationsMatch;
  const issues: string[] = [];
  if (!conceptsMatch) issues.push("概念部品の配置を見直してください。");
  if (!relationsMatch) issues.push("関係部品の接続先を見直してください。");

  return {
    configurationComplete,
    matched,
    concepts: {
      matched: counts.matchedConcepts,
      total: counts.expectedConcepts,
    },
    relations: {
      matched: counts.matchedLinks,
      total: counts.expectedLinks,
    },
    message: !configurationComplete
      ? "このKitはGoal Map全体を含んでいません。研究者に確認してください。"
      : matched
        ? "Kit-Buildがゴールマップと一致しました。内容を見直して提出できます。"
        : `一致している部品：概念 ${counts.matchedConcepts}/${counts.expectedConcepts}、関係 ${counts.matchedLinks}/${counts.expectedLinks}。${issues.join("")}`,
  };
}

// Callers hold a Map row lock; positions do not affect matching.
async function readKitBuildMapSignature(
  client: PoolClient,
  mapId: string,
): Promise<string | null> {
  const map = await client.query<{ kitDefinitionId: string | null }>(
    `SELECT kit_definition_id AS "kitDefinitionId" FROM maps WHERE id = $1::uuid`,
    [mapId],
  );
  if (!map.rows[0]) return null;
  const concepts = await client.query<{ id: string; label: string }>(
    `SELECT id, label FROM concepts
     WHERE map_id = $1::uuid AND merged_into_concept_id IS NULL ORDER BY id`,
    [mapId],
  );
  const links = await client.query<{
    id: string; label: string; sourceConceptId: string; targetConceptId: string;
  }>(
    `SELECT link.id, link.label, link.source_concept_id AS "sourceConceptId",
            link.target_concept_id AS "targetConceptId"
     FROM links link
     JOIN concepts source ON source.id = link.source_concept_id
       AND source.map_id = link.map_id AND source.merged_into_concept_id IS NULL
     JOIN concepts target ON target.id = link.target_concept_id
       AND target.map_id = link.map_id AND target.merged_into_concept_id IS NULL
     WHERE link.map_id = $1::uuid ORDER BY link.id`,
    [mapId],
  );
  return JSON.stringify([
    mapId,
    map.rows[0].kitDefinitionId,
    concepts.rows.map(({ id, label }) => [id, label]),
    links.rows.map(({ id, label, sourceConceptId, targetConceptId }) => [
      id, label, sourceConceptId, targetConceptId,
    ]),
  ]);
}

// The feedback and its signature describe the same saved graph under the Map lock.
async function readKitBuildFeedbackWithSignature(
  client: PoolClient,
  mapId: string,
): Promise<KitBuildFeedbackWithSignature | null> {
  const feedback = await readKitBuildFeedback(client, mapId);
  if (!feedback) return null;
  const mapSignature = await readKitBuildMapSignature(client, mapId);
  return mapSignature === null ? null : { ...feedback, mapSignature };
}

async function getConceptForUpdate(
  client: PoolClient,
  conceptId: string,
  mapId: string,
): Promise<LockedConceptRow | null> {
  const result = await client.query<LockedConceptRow>(
    `
      SELECT
        id,
        map_id AS "mapId",
        label,
        position_x AS "positionX",
        position_y AS "positionY",
        merged_into_concept_id AS "mergedIntoConceptId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM concepts
      WHERE id = $1::uuid AND map_id = $2::uuid
      FOR UPDATE
    `,
    [conceptId, mapId],
  );

  return result.rows[0] ?? null;
}

function ensureConceptActive(concept: LockedConceptRow) {
  ensureConceptNotMerged(concept.mergedIntoConceptId);
}

function ensureConceptNotMerged(mergedIntoConceptId: string | null) {
  if (mergedIntoConceptId !== null) {
    throw new MergedConceptError();
  }
}

async function getLinkForUpdate(
  client: PoolClient,
  linkId: string,
  mapId: string,
): Promise<UpdatedLinkRow | null> {
  const result = await client.query<UpdatedLinkRow>(
    `
      SELECT
        id,
        map_id AS "mapId",
        source_concept_id AS "sourceConceptId",
        target_concept_id AS "targetConceptId",
        label, label_position_x AS "labelPositionX",label_position_y AS "labelPositionY",
        updated_at AS "updatedAt"
      FROM links
      WHERE id = $1::uuid AND map_id = $2::uuid
      FOR UPDATE
    `,
    [linkId, mapId],
  );

  return result.rows[0] ?? null;
}

function toConceptSnapshot(concept: ConceptSnapshot): ConceptSnapshot {
  return {
    id: concept.id,
    mapId: concept.mapId,
    label: concept.label,
    positionX: concept.positionX,
    positionY: concept.positionY,
  };
}

function toLinkSnapshot(link: LinkSnapshot): LinkSnapshot {
  return {
    id: link.id,
    mapId: link.mapId,
    sourceConceptId: link.sourceConceptId,
    targetConceptId: link.targetConceptId,
    label: link.label,
  };
}

async function appendMapOperationLog(
  client: PoolClient,
  input: {
    mapId: string;
    operationType: OperationType;
    targetType: OperationTargetType;
    targetId: string;
    before: OperationSnapshot | null;
    after: OperationSnapshot | null;
    clientTimestamp: string | null;
    relatedOperationLogId?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<{ id: string; sequenceNumber: string }> {
  const before = transactionBefore.get(client)?.get(input.mapId);
  const installed = (await client.query<{ name: string | null }>("SELECT to_regclass('map_history_boundaries')::text AS name")).rows[0]?.name;
  if (await isStage1LearnerMap(client, input.mapId)) {
    if (!installed) throw new HistoryTransitionError("操作履歴のDB変更が未適用です。研究者に連絡してください。");
    if (!before) throw new HistoryTransitionError("変更前のマップ状態を取得できません。");
    const after = await readCurrentMapHistorySnapshot(client, input.mapId);
    if (!after) throw new HistoryTransitionError("マップ状態を取得できません。");
    if (!validateMapStateV5(before, input.mapId) || !validateMapStateV5(after, input.mapId)) throw new HistoryTransitionError(`マップ ${input.mapId} の内容を確認してください。名前は512文字以内、概念は1000個以内、リンクは2000個以内、座標は絶対値10000000以内、状態は4000000バイト以内とし、URLや認証情報を含めないでください。`);
    const initial = (await client.query<{ snapshot: MapHistorySnapshot }>("SELECT snapshot FROM map_initial_snapshots WHERE map_id=$1::uuid AND snapshot_version=1", [input.mapId])).rows[0]?.snapshot;
    if (!initial) throw new HistoryTransitionError("初期スナップショットがないため履歴を記録できません。");
    const old = await client.query<HistoryOperation>(`SELECT id,map_id AS "mapId",sequence_number AS "sequenceNumber",operation_type AS "operationType",target_type AS "targetType",target_id AS "targetId",before,after,related_operation_log_id AS "relatedOperationLogId" FROM map_operation_logs WHERE map_id=$1::uuid ORDER BY sequence_number`, [input.mapId]);
    const boundary = (await client.query<{ legacyCount: string; legacyLastId: string | null; snapshot: MapHistorySnapshot }>(`SELECT legacy_count AS "legacyCount",legacy_last_id AS "legacyLastId",boundary_snapshot AS snapshot FROM map_history_boundaries WHERE map_id=$1::uuid`, [input.mapId])).rows[0];
    const next = await client.query<MapHistoryEventV2>(`SELECT event_id AS "eventId",map_id AS "mapId",schema_version AS "schemaVersion",event_type AS "eventType",related_event_id AS "relatedEventId",related_legacy_operation_log_id AS "relatedLegacyOperationLogId",sequence_number AS "sequenceNumber",outcome,before_state AS before,after_state AS after FROM research_events WHERE map_id=$1::uuid AND schema_version IN (2,5) ORDER BY sequence_number`, [input.mapId]);
    if (!boundary && next.rows.length) throw new HistoryTransitionError("新イベントの切替境界がありません。");
    const definition = { legacyCount: boundary ? Number(boundary.legacyCount) : old.rows.length, legacyLastId: boundary ? boundary.legacyLastId : old.rows.at(-1)?.id ?? null };
    const oldState = replayMixedMapHistory(initial, definition, old.rows, []);
    if (oldState.status !== "REPLAYABLE" || boundary && !historySnapshotsEqual(oldState.state, boundary.snapshot)) throw new HistoryTransitionError("旧履歴と切替境界が一致しません。");
    const current = replayMixedMapHistory(initial, definition, old.rows, next.rows);
    if (current.status !== "REPLAYABLE" || !historySnapshotsEqual(current.state, before)) throw new HistoryTransitionError("履歴と変更前のマップが一致しません。");
    if (!boundary) await client.query("INSERT INTO map_history_boundaries(map_id,legacy_count,legacy_last_id,boundary_snapshot) VALUES($1::uuid,$2,$3::uuid,$4::jsonb)", [input.mapId, old.rows.length, definition.legacyLastId, JSON.stringify(before)]);
    const session = (await client.query<{ id: string }>("SELECT st.session_id AS id FROM maps m JOIN session_stages st ON st.id=m.session_stage_id WHERE m.id=$1::uuid", [input.mapId])).rows[0];
    if (!session) throw new HistoryTransitionError("セッションを確認できません。");
    const operation = input.operationType as EventType;
    const undo = operation === "UNDO" || operation === "REDO";
    const relatedLegacy = undo && old.rows.some(item => item.id === input.relatedOperationLogId);
    let event: Awaited<ReturnType<typeof insertResearchEvent>>;
    try { event = await insertResearchEvent(client, session.id, deadlineContext.getStore()?.actor ?? "SYSTEM", {
      schemaVersion: 5, eventType: operation, targetType: eventTargets[operation], mapId: input.mapId,
      targetId: undo ? input.mapId : input.targetId, outcome: "SUCCESS", clientTimeQuality: input.clientTimestamp ? "OBSERVED" : "MISSING",
      ...(input.clientTimestamp ? { clientTimestamp: input.clientTimestamp } : {}),
      ...(input.relatedOperationLogId ? relatedLegacy ? { relatedLegacyOperationLogId: input.relatedOperationLogId } : { relatedEventId: input.relatedOperationLogId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}), before, after,
    }); } catch (error) {
      if (error instanceof InvalidEventError) throw error;
      throw new HistoryTransitionError("マップの操作履歴を保存できません。入力内容を保持してもう一度お試しください。");
    }
    if (!event) throw new HistoryTransitionError("マップの操作履歴を保存できません。");
    transactionBefore.get(client)?.set(input.mapId, after);
    return { id: event.eventId, sequenceNumber: String(old.rows.length + next.rows.filter(item => item.outcome === "SUCCESS").length + 1) };
  }
  const sequenceResult = await client.query<{ sequenceNumber: string }>(
    `
      SELECT COALESCE(MAX(sequence_number), 0) + 1 AS "sequenceNumber"
      FROM map_operation_logs
      WHERE map_id = $1::uuid
    `,
    [input.mapId],
  );
  const sequenceNumber = sequenceResult.rows[0]?.sequenceNumber;

  if (!sequenceNumber) {
    throw new Error("Failed to allocate MapOperationLog sequence number");
  }

  const inserted = await client.query<{ id: string; sequenceNumber: string }>(
    `
      INSERT INTO map_operation_logs (
        map_id,
        operation_type,
        target_type,
        target_id,
        "before",
        "after",
        sequence_number,
        client_timestamp,
        related_operation_log_id,
        idempotency_key
      )
      VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb, $6::jsonb, $7, $8::timestamptz, $9::uuid, $10::uuid)
      RETURNING id, sequence_number AS "sequenceNumber"
    `,
    [
      input.mapId,
      input.operationType,
      input.targetType,
      input.targetId,
      input.before === null ? null : JSON.stringify(input.before),
      input.after === null ? null : JSON.stringify(input.after),
      sequenceNumber,
      input.clientTimestamp,
      input.relatedOperationLogId ?? null,
      input.idempotencyKey ?? null,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("Failed to insert MapOperationLog event");
  if (input.operationType === "DELETE_CONCEPT" || input.operationType === "DELETE_LINK") await auditCurrent(client);
  return { id: row.id, sequenceNumber: String(row.sequenceNumber) };
}

async function createMapInitialSnapshot(
  client: PoolClient,
  mapId: string,
): Promise<void> {
  const mapResult = await client.query<{
    id: string;
    type: string;
    basedOnMapId: string | null;
    kitDefinitionId: string | null;
  }>(
    `SELECT id, type, based_on_map_id AS "basedOnMapId",
            kit_definition_id AS "kitDefinitionId"
     FROM maps WHERE id = $1::uuid`,
    [mapId],
  );
  const map = mapResult.rows[0];
  if (!map) throw new Error("Cannot capture an initial snapshot for a missing Map.");

  const conceptResult = await client.query<{
    id: string;
    mapId: string;
    label: string;
    positionX: number;
    positionY: number;
    mergedIntoConceptId: string | null;
  }>(
    `SELECT id, map_id AS "mapId", label,
            position_x AS "positionX", position_y AS "positionY",
            merged_into_concept_id AS "mergedIntoConceptId"
     FROM concepts WHERE map_id = $1::uuid ORDER BY id`,
    [mapId],
  );
  const linkResult = await client.query<{
    id: string;
    mapId: string;
    sourceConceptId: string;
    targetConceptId: string;
    label: string;
  }>(
    `SELECT id, map_id AS "mapId",
            source_concept_id AS "sourceConceptId",
            target_concept_id AS "targetConceptId", label
     FROM links WHERE map_id = $1::uuid ORDER BY id`,
    [mapId],
  );
  const conceptIds = conceptResult.rows.map((item) => item.id);
  const linkIds = linkResult.rows.map((item) => item.id);
  const conceptProvenanceResult = conceptIds.length
    ? await client.query<ConceptProvenanceSnapshot>(
        `SELECT id, target_concept_id AS "targetConceptId",
                source_concept_id AS "sourceConceptId",
                relation_type AS "relationType", created_at AS "createdAt"
         FROM concept_provenance WHERE target_concept_id = ANY($1::uuid[])
         ORDER BY created_at, id`,
        [conceptIds],
      )
    : { rows: [] as ConceptProvenanceSnapshot[] };
  const linkProvenanceResult = linkIds.length
    ? await client.query<LinkProvenanceSnapshot>(
        `SELECT id, target_link_id AS "targetLinkId",
                source_link_id AS "sourceLinkId",
                relation_type AS "relationType", created_at AS "createdAt"
         FROM link_provenance WHERE target_link_id = ANY($1::uuid[])
         ORDER BY created_at, id`,
        [linkIds],
      )
    : { rows: [] as LinkProvenanceSnapshot[] };
  const conceptsById = new Map<string, ConceptProvenanceSnapshot[]>();
  for (const provenance of conceptProvenanceResult.rows) {
    const rows = conceptsById.get(provenance.targetConceptId) ?? [];
    rows.push({ ...provenance, createdAt: new Date(provenance.createdAt).toISOString() });
    conceptsById.set(provenance.targetConceptId, rows);
  }
  const linksById = new Map<string, LinkProvenanceSnapshot[]>();
  for (const provenance of linkProvenanceResult.rows) {
    const rows = linksById.get(provenance.targetLinkId) ?? [];
    rows.push({ ...provenance, createdAt: new Date(provenance.createdAt).toISOString() });
    linksById.set(provenance.targetLinkId, rows);
  }
  const snapshot: MapHistorySnapshot = {
    snapshotVersion: 1,
    mapId: map.id,
    mapType: map.type,
    basedOnMapId: map.basedOnMapId,
    kitDefinitionId: map.kitDefinitionId,
    concepts: conceptResult.rows.map((item) => ({
      ...item,
      provenance: conceptsById.get(item.id) ?? [],
    })),
    links: linkResult.rows.map((item) => ({
      ...item,
      provenance: linksById.get(item.id) ?? [],
    })),
  };
  await client.query(
    `INSERT INTO map_initial_snapshots (map_id, snapshot_version, snapshot)
     VALUES ($1::uuid, $2, $3::jsonb)`,
    [mapId, snapshot.snapshotVersion, JSON.stringify(snapshot)],
  );
}

async function attachConceptProvenance<T extends { id: string }>(
  client: PoolClient,
  concepts: T[],
) {
  const ids = concepts.map((item) => item.id);
  if (!ids.length) return concepts.map((item) => ({ ...item, provenance: [] as ConceptProvenanceSnapshot[] }));
  const result = await client.query<ConceptProvenanceSnapshot>(
    `SELECT id, target_concept_id AS "targetConceptId",
            source_concept_id AS "sourceConceptId",
            relation_type AS "relationType", created_at AS "createdAt"
     FROM concept_provenance WHERE target_concept_id = ANY($1::uuid[])
     ORDER BY created_at, id`,
    [ids],
  );
  const byTarget = new Map<string, ConceptProvenanceSnapshot[]>();
  for (const item of result.rows) {
    const values = byTarget.get(item.targetConceptId) ?? [];
    values.push({ ...item, createdAt: new Date(item.createdAt).toISOString() });
    byTarget.set(item.targetConceptId, values);
  }
  return concepts.map((item) => ({ ...item, provenance: byTarget.get(item.id) ?? [] }));
}

async function attachLinkProvenance<T extends { id: string }>(
  client: PoolClient,
  links: T[],
) {
  const ids = links.map((item) => item.id);
  if (!ids.length) return links.map((item) => ({ ...item, provenance: [] as LinkProvenanceSnapshot[] }));
  const result = await client.query<LinkProvenanceSnapshot>(
    `SELECT id, target_link_id AS "targetLinkId",
            source_link_id AS "sourceLinkId",
            relation_type AS "relationType", created_at AS "createdAt"
     FROM link_provenance WHERE target_link_id = ANY($1::uuid[])
     ORDER BY created_at, id`,
    [ids],
  );
  const byTarget = new Map<string, LinkProvenanceSnapshot[]>();
  for (const item of result.rows) {
    const values = byTarget.get(item.targetLinkId) ?? [];
    values.push({ ...item, createdAt: new Date(item.createdAt).toISOString() });
    byTarget.set(item.targetLinkId, values);
  }
  return links.map((item) => ({ ...item, provenance: byTarget.get(item.id) ?? [] }));
}

async function readCurrentMapHistorySnapshot(
  client: PoolClient,
  mapId: string,
): Promise<MapHistorySnapshot | null> {
  const mapResult = await client.query<{
    id: string;
    type: string;
    basedOnMapId: string | null;
    kitDefinitionId: string | null;
  }>(
    `SELECT id, type, based_on_map_id AS "basedOnMapId",
            kit_definition_id AS "kitDefinitionId"
     FROM maps WHERE id=$1::uuid`,
    [mapId],
  );
  const map = mapResult.rows[0];
  if (!map) return null;

  const conceptResult = await client.query<
    Omit<MapHistorySnapshot["concepts"][number], "provenance">
  >(
    `SELECT id, map_id AS "mapId", label,
            position_x AS "positionX", position_y AS "positionY",
            merged_into_concept_id AS "mergedIntoConceptId"
     FROM concepts WHERE map_id=$1::uuid ORDER BY id`,
    [mapId],
  );
  const linkResult = await client.query<
    Omit<MapHistorySnapshot["links"][number], "provenance">
  >(
    `SELECT id, map_id AS "mapId",
            source_concept_id AS "sourceConceptId",
            target_concept_id AS "targetConceptId", label, label_position_x AS "labelPositionX", label_position_y AS "labelPositionY"
     FROM links WHERE map_id=$1::uuid ORDER BY id`,
    [mapId],
  );
  const concepts = await attachConceptProvenance(client, conceptResult.rows);
  const links = await attachLinkProvenance(client, linkResult.rows.map(({labelPositionX,labelPositionY,...link}) => labelPositionX == null || labelPositionY == null ? link : {...link,labelPositionX,labelPositionY}));
  return {
    snapshotVersion: 1,
    mapId: map.id,
    mapType: map.type,
    basedOnMapId: map.basedOnMapId,
    kitDefinitionId: map.kitDefinitionId,
    concepts,
    links,
  };
}

type UndoRedoContext = {
  status: "AVAILABLE" | "UNAVAILABLE" | "PARTIAL";
  reason: string | null;
  initial: MapHistorySnapshot | null;
  operations: HistoryOperation[];
  current: MapHistorySnapshot | null;
  undoOperation: HistoryOperation | null;
  redoOperation: HistoryOperation | null;
};

async function readUndoRedoContext(
  client: PoolClient,
  mapId: string,
): Promise<UndoRedoContext> {
  const initialResult = await client.query<{
    snapshotVersion: number;
    snapshot: MapHistorySnapshot;
  }>(
    `SELECT snapshot_version AS "snapshotVersion", snapshot
     FROM map_initial_snapshots WHERE map_id=$1::uuid`,
    [mapId],
  );
  const operationResult = await client.query<HistoryOperation>(
    `SELECT id, map_id AS "mapId", sequence_number AS "sequenceNumber",
            operation_type AS "operationType", target_type AS "targetType",
            target_id AS "targetId", before, after,
            related_operation_log_id AS "relatedOperationLogId"
     FROM map_operation_logs WHERE map_id=$1::uuid
     ORDER BY sequence_number, id`,
    [mapId],
  );
  const operations = operationResult.rows;
  const hasBoundaryTable = (await client.query<{ name: string | null }>("SELECT to_regclass('map_history_boundaries')::text AS name")).rows[0]?.name;
  const boundary = hasBoundaryTable ? (await client.query<{ legacyCount: string; legacyLastId: string | null; snapshot: MapHistorySnapshot }>(
    `SELECT legacy_count AS "legacyCount", legacy_last_id AS "legacyLastId", boundary_snapshot AS snapshot FROM map_history_boundaries WHERE map_id=$1::uuid`, [mapId],
  )).rows[0] : undefined;
  if (boundary) {
    const initial = initialResult.rows[0]?.snapshot ?? null;
    const boundaryReplay = initial && replayMapAt(initial, operations, operations.length);
    if (!initial || !Number.isSafeInteger(Number(boundary.legacyCount)) || Number(boundary.legacyCount) !== operations.length || (operations.at(-1)?.id ?? null) !== boundary.legacyLastId || !boundaryReplay || boundaryReplay.status !== "REPLAYABLE" || !historySnapshotsEqual(boundaryReplay.state, boundary.snapshot)) {
      return { status: "PARTIAL", reason: "旧履歴と切替境界が一致しません。", initial, operations, current: null, undoOperation: null, redoOperation: null };
    }
    const newer = await client.query<{ schemaVersion:number; id: string; mapId: string; operationType: string; targetType: string; targetId: string; before: unknown; after: unknown; relatedOperationLogId: string | null }>(
      `SELECT schema_version AS "schemaVersion", event_id AS id, map_id AS "mapId", event_type AS "operationType", target_type AS "targetType", target_id AS "targetId", before_state AS before, after_state AS after, coalesce(related_event_id,related_legacy_operation_log_id) AS "relatedOperationLogId"
       FROM research_events WHERE map_id=$1::uuid AND schema_version IN (2,5) AND outcome='SUCCESS'
         AND event_type IN ('ADD_CONCEPT','EDIT_CONCEPT','MOVE_CONCEPT','DELETE_CONCEPT','MERGE_CONCEPT','IMPORT_KIT_CONCEPT','ADD_LINK','EDIT_LINK','MOVE_LINK','DELETE_LINK','RECONNECT_LINK','IMPORT_KIT_LINK','UNDO','REDO','MAP_SAVE','MAP_KIT_ASSIGN','MAP_SUBMIT','MAP_AUTO_SUBMIT') ORDER BY sequence_number`, [mapId],
    );
    for (const event of newer.rows) operations.push({ ...event, sequenceNumber: String(operations.length + 1), historyFormat: event.schemaVersion === 5 ? "V5" : "V2" });
  }
  const initial = initialResult.rows[0]?.snapshot ?? null;
  if (!initial) {
    return {
      status: "UNAVAILABLE",
      reason: "編集開始前の初期スナップショットがありません。",
      initial: null,
      operations,
      current: null,
      undoOperation: null,
      redoOperation: null,
    };
  }
  if (
    initialResult.rows[0]?.snapshotVersion !== 1 ||
    initial.snapshotVersion !== 1
  ) {
    return {
      status: "UNAVAILABLE",
      reason: "未対応の初期スナップショット形式です。",
      initial,
      operations,
      current: null,
      undoOperation: null,
      redoOperation: null,
    };
  }

  const replay = replayMapAt(initial, operations, operations.length);
  if (replay.status !== "REPLAYABLE") {
    return {
      status: "PARTIAL",
      reason: replay.reason,
      initial,
      operations,
      current: null,
      undoOperation: null,
      redoOperation: null,
    };
  }
  const current = await readCurrentMapHistorySnapshot(client, mapId);
  if (!current || !historySnapshotsEqual(replay.state, current)) {
    return {
      status: "PARTIAL",
      reason: "操作履歴の再生結果と現在のMapが一致しません。",
      initial,
      operations,
      current,
      undoOperation: null,
      redoOperation: null,
    };
  }

  try {
    const availability = deriveUndoRedoAvailability(operations);
    return {
      status: "AVAILABLE",
      reason: null,
      initial,
      operations,
      current,
      undoOperation: availability.undoOperation,
      redoOperation: availability.redoOperation,
    };
  } catch (error) {
    return {
      status: "PARTIAL",
      reason: error instanceof Error ? error.message : "Undo/Redo履歴が不正です。",
      initial,
      operations,
      current,
      undoOperation: null,
      redoOperation: null,
    };
  }
}

async function isStage1LearnerMap(client: PoolClient, mapId: string) {
  const result = await client.query<{ protocolKey: string; type: MapType }>(
    `SELECT session.protocol_key AS "protocolKey", map.type
     FROM maps AS map
     INNER JOIN session_stages AS stage ON stage.id=map.session_stage_id
     INNER JOIN sessions AS session ON session.id=stage.session_id
     WHERE map.id=$1::uuid`,
    [mapId],
  );
  const row = result.rows[0];
  return Boolean(
    (row?.protocolKey === STAGE1_PROTOCOL_KEY || row?.protocolKey === "STAGE1_6") &&
      (row.type === "PRIOR" || row.type === "KB" || row.type === "INTEGRATION"),
  );
}

function undoRedoPayload(
  map: LockedMapState,
  context: UndoRedoContext,
  editable: boolean,
) {
  const available = context.status === "AVAILABLE" && editable;
  const undoOperation = available ? context.undoOperation : null;
  const redoOperation = available ? context.redoOperation : null;
  return {
    mapId: map.mapId,
    status: context.status,
    sequenceNumber: context.operations.length,
    canUndo: undoOperation !== null,
    canRedo: redoOperation !== null,
    undoOperation: undoOperation
      ? { id: undoOperation.id, operationType: undoOperation.operationType }
      : null,
    redoOperation: redoOperation
      ? { id: redoOperation.id, operationType: redoOperation.operationType }
      : null,
    reason:
      context.reason ??
      (editable ? null : map.mapStatus === "SUBMITTED" ? "提出済みのMapは変更できません。" : "現在編集できるStageではありません。"),
  };
}

async function applyHistoryStateDelta(
  client: PoolClient,
  mapId: string,
  delta: ReturnType<typeof historyStateDelta>,
  target: MapHistorySnapshot,
) {
  const conceptIds = delta.affectedConceptIds;
  const linkIds = delta.affectedLinkIds;
  const desiredConcepts = target.concepts.filter((item) => conceptIds.includes(item.id));
  const desiredLinks = target.links.filter((item) => linkIds.includes(item.id));
  const desiredConceptIds = desiredConcepts.map((item) => item.id);
  const desiredLinkIds = desiredLinks.map((item) => item.id);

  if (linkIds.length) {
    await client.query(
      `DELETE FROM links WHERE map_id=$1::uuid AND id=ANY($2::uuid[])
       AND NOT (id=ANY($3::uuid[]))`,
      [mapId, linkIds, desiredLinkIds],
    );
  }

  for (const item of desiredConcepts) {
    await client.query(
      `UPDATE concepts SET merged_into_concept_id=NULL
       WHERE id=$1::uuid AND map_id=$2::uuid
         AND merged_into_concept_id IS NOT NULL
         AND merged_into_concept_id IS DISTINCT FROM $3::uuid`,
      [item.id, mapId, item.mergedIntoConceptId],
    );
  }

  if (conceptIds.length) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM concepts WHERE map_id=$1::uuid AND id=ANY($2::uuid[])`,
      [mapId, conceptIds],
    );
    const existingIds = new Set(existing.rows.map((item) => item.id));
    for (const item of desiredConcepts) {
      if (existingIds.has(item.id)) continue;
      await client.query(
        `INSERT INTO concepts (id,map_id,label,position_x,position_y,merged_into_concept_id)
         VALUES ($1::uuid,$2::uuid,$3,$4,$5,NULL)`,
        [item.id, mapId, item.label, item.positionX, item.positionY],
      );
    }
  }

  for (const item of desiredConcepts) {
    await client.query(
      `UPDATE concepts SET label=$3, position_x=$4, position_y=$5,
                            merged_into_concept_id=$6::uuid
       WHERE id=$1::uuid AND map_id=$2::uuid`,
      [item.id, mapId, item.label, item.positionX, item.positionY, item.mergedIntoConceptId],
    );
  }

  for (const item of desiredLinks) {
    await client.query(
      `INSERT INTO links (id,map_id,source_concept_id,target_concept_id,label,label_position_x,label_position_y)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET source_concept_id=EXCLUDED.source_concept_id,
         target_concept_id=EXCLUDED.target_concept_id,label=EXCLUDED.label,label_position_x=EXCLUDED.label_position_x,label_position_y=EXCLUDED.label_position_y`,
      [item.id, mapId, item.sourceConceptId, item.targetConceptId, item.label,item.labelPositionX??null,item.labelPositionY??null],
    );
  }

  if (conceptIds.length) {
    await client.query(
      `DELETE FROM concept_provenance WHERE target_concept_id=ANY($1::uuid[])`,
      [conceptIds],
    );
  }
  if (linkIds.length) {
    await client.query(
      `DELETE FROM link_provenance WHERE target_link_id=ANY($1::uuid[])`,
      [linkIds],
    );
  }
  if (conceptIds.length) {
    await client.query(
      `DELETE FROM concepts WHERE map_id=$1::uuid AND id=ANY($2::uuid[])
       AND NOT (id=ANY($3::uuid[]))`,
      [mapId, conceptIds, desiredConceptIds],
    );
  }

  for (const item of desiredConcepts) {
    for (const provenance of item.provenance) {
      await client.query(
        `INSERT INTO concept_provenance
           (id,target_concept_id,source_concept_id,relation_type,created_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz)`,
        [provenance.id, item.id, provenance.sourceConceptId, provenance.relationType, provenance.createdAt],
      );
    }
  }
  for (const item of desiredLinks) {
    for (const provenance of item.provenance) {
      await client.query(
        `INSERT INTO link_provenance
           (id,target_link_id,source_link_id,relation_type,created_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz)`,
        [provenance.id, item.id, provenance.sourceLinkId, provenance.relationType, provenance.createdAt],
      );
    }
  }
}

app.use(express.json());
app.use("/api", (request, response, next) => {
  const path = request.path;
  const method = request.method.toUpperCase();
  const match = (pattern: RegExp) => pattern.exec(path);
  let eventType: EventType | null = null;
  let targetType: "MAP" | "CONCEPT" | "LINK" = "MAP";
  let mapId: string | null = null;
  let targetId: string | null = null;
  if (method === "POST" && (match(/^\/maps\/([^/]+)\/concepts$/))) { eventType="ADD_CONCEPT"; mapId=match(/^\/maps\/([^/]+)\/concepts$/)![1]!; targetType="CONCEPT"; }
  else if (method === "POST" && match(/^\/maps\/([^/]+)\/concepts\/merge$/)) { eventType="MERGE_CONCEPT"; mapId=match(/^\/maps\/([^/]+)\/concepts\/merge$/)![1]!; targetType="CONCEPT"; }
  else if (method === "POST" && match(/^\/maps\/([^/]+)\/links$/)) { eventType="ADD_LINK"; mapId=match(/^\/maps\/([^/]+)\/links$/)![1]!; targetType="LINK"; }
  else if (method === "POST" && match(/^\/maps\/([^/]+)\/kit-concepts\/[^/]+\/import$/)) { eventType="IMPORT_KIT_CONCEPT"; mapId=match(/^\/maps\/([^/]+)\/kit-concepts\/[^/]+\/import$/)![1]!; targetType="CONCEPT"; }
  else if (method === "POST" && match(/^\/maps\/([^/]+)\/kit-links\/[^/]+(?:\/import)?$/)) { eventType=path.endsWith("/import")?"IMPORT_KIT_LINK":"IMPORT_KIT_LINK"; mapId=match(/^\/maps\/([^/]+)\/kit-links\/[^/]+(?:\/import)?$/)![1]!; targetType="LINK"; }
  else if (method === "PATCH" && match(/^\/maps\/([^/]+)\/kit-definition$/)) { eventType="MAP_KIT_ASSIGN"; mapId=match(/^\/maps\/([^/]+)\/kit-definition$/)![1]!; }
  else if (method === "POST" && match(/^\/maps\/([^/]+)\/submit$/)) { eventType="MAP_SUBMIT"; mapId=match(/^\/maps\/([^/]+)\/submit$/)![1]!; }
  else if (method === "POST" && match(/^\/maps\/([^/]+)\/undo-redo$/)) { mapId=match(/^\/maps\/([^/]+)\/undo-redo$/)![1]!; eventType=request.body?.action==="UNDO"?"UNDO":request.body?.action==="REDO"?"REDO":null; }
  else if (method === "PATCH" && match(/^\/concepts\/([^/]+)\/(label|position)$/)) { const m=match(/^\/concepts\/([^/]+)\/(label|position)$/)!;targetId=m[1]!;targetType="CONCEPT";eventType=m[2]==="label"?"EDIT_CONCEPT":"MOVE_CONCEPT"; }
  else if (method === "DELETE" && match(/^\/concepts\/([^/]+)$/)) {targetId=match(/^\/concepts\/([^/]+)$/)![1]!;targetType="CONCEPT";eventType="DELETE_CONCEPT";}
  else if (method === "PATCH" && match(/^\/links\/([^/]+)\/(label|reconnect|position)$/)) {const m=match(/^\/links\/([^/]+)\/(label|reconnect|position)$/)!;targetId=m[1]!;targetType="LINK";eventType=m[2]==="label"?"EDIT_LINK":m[2]==="position"?"MOVE_LINK":"RECONNECT_LINK";}
  else if (method === "DELETE" && match(/^\/links\/([^/]+)$/)) {targetId=match(/^\/links\/([^/]+)$/)![1]!;targetType="LINK";eventType="DELETE_LINK";}
  if (!eventType) return next();
  const originalJson = response.json.bind(response);
  response.json = ((body: unknown) => {
    const status = response.statusCode;
    if (status < 400 || status === 401 || status === 403 ||
        body && typeof body==="object" && "error" in body && ["operation_already_committed","idempotency_conflict","operation_result_expired"].includes(String(body.error))) return originalJson(body);
    void (async () => {
      let principal: ReturnType<typeof principalOf>;
      try { principal=principalOf(response); } catch { return originalJson(body); }
      const transactionFailure = body !== null && typeof body === "object" && "message" in body && typeof (body as {message?:unknown}).message === "string" && (body as {message:string}).message.includes("履歴を保存できません");
      const outcome: "REJECTED" | "FAILURE" = status >= 500 || transactionFailure ? "FAILURE" : "REJECTED";
      let reasonCode: "VALIDATION" | "CONFLICT" | "DEADLINE" | "SERVER" | "PERMISSION" = status >= 500 || transactionFailure ? "SERVER" : status === 400 ? "VALIDATION" : "CONFLICT";
      if (status === 409 && body !== null && typeof body === "object" && "message" in body && typeof (body as {message?:unknown}).message === "string" && (body as {message:string}).message.includes("内容を確認してください")) reasonCode = "VALIDATION";
      let resolvedMapId = mapId;
      const resolvedTargetId = targetId;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (targetId && targetType !== "MAP") {
          const table = targetType === "CONCEPT" ? "concepts" : "links";
          const owner = await client.query<{mapId:string;sessionId:string;protocolKey:string;stageType:string;studyGroup:string|null;expired:boolean}>(
            `SELECT item.map_id AS "mapId",s.id AS "sessionId",s.protocol_key AS "protocolKey",st.stage_type AS "stageType",s.study_group AS "studyGroup",
              (s.protocol_key='STAGE1_6' AND st.stage_type='INTEGRATION_MAP' AND clock_timestamp()>=st.started_at+s.group_activity_seconds*interval '1 second') AS expired
             FROM ${table} item JOIN maps m ON m.id=item.map_id JOIN session_stages st ON st.id=m.session_stage_id JOIN sessions s ON s.id=st.session_id
             WHERE item.id=$1::uuid AND s.protocol_key IN ('STAGE1_4','STAGE1_6')`,[targetId]);
          if (!owner.rowCount) { await client.query("ROLLBACK"); return originalJson(body); }
          resolvedMapId=owner.rows[0]!.mapId;
          if (principal.role==="learner"&&principal.sessionId!==owner.rows[0]!.sessionId) {await client.query("ROLLBACK");return originalJson(body);}
          if(owner.rows[0]!.expired){reasonCode="DEADLINE";}
        }
        if (!resolvedMapId) { await client.query("ROLLBACK"); return originalJson(body); }
        const owner=await client.query<{sessionId:string;protocolKey:string;status:string;mapStatus:string;stageType:string;stageStatus:string;expired:boolean}>(
          `SELECT s.id AS "sessionId",s.protocol_key AS "protocolKey",s.status,m.status AS "mapStatus",st.stage_type AS "stageType",st.status AS "stageStatus",
            (s.protocol_key='STAGE1_6' AND st.stage_type IN ('INTEGRATION_MAP','SELF_STUDY') AND st.status='IN_PROGRESS' AND clock_timestamp()>=st.started_at+s.group_activity_seconds*interval '1 second') AS expired
           FROM maps m JOIN session_stages st ON st.id=m.session_stage_id JOIN sessions s ON s.id=st.session_id
           WHERE m.id=$1::uuid AND s.protocol_key IN ('STAGE1_4','STAGE1_6')`,[resolvedMapId]);
        if (!owner.rowCount || principal.role==="learner"&&principal.sessionId!==owner.rows[0]!.sessionId) {await client.query("ROLLBACK");return originalJson(body);}
        const sessionId=owner.rows[0]!.sessionId;
        if(owner.rows[0]!.expired){reasonCode="DEADLINE";}
        else if(owner.rows[0]!.mapStatus==="SUBMITTED") reasonCode="PERMISSION";
        else if(owner.rows[0]!.status==="COMPLETED"||owner.rows[0]!.stageStatus==="COMPLETED") reasonCode="PERMISSION";
        await client.query("SELECT id FROM maps WHERE id=$1::uuid FOR UPDATE",[resolvedMapId]);
        const lockedOwner=await client.query<{status:string;mapStatus:string;stageStatus:string;expired:boolean}>(
          `SELECT s.status,m.status AS "mapStatus",st.status AS "stageStatus",
            (s.protocol_key='STAGE1_6' AND st.stage_type IN ('INTEGRATION_MAP','SELF_STUDY') AND st.status='IN_PROGRESS' AND clock_timestamp()>=st.started_at+s.group_activity_seconds*interval '1 second') AS expired
           FROM maps m JOIN session_stages st ON st.id=m.session_stage_id JOIN sessions s ON s.id=st.session_id WHERE m.id=$1::uuid`,[resolvedMapId]);
        if(lockedOwner.rows[0]?.expired) reasonCode="DEADLINE";
        else if(lockedOwner.rows[0]?.mapStatus==="SUBMITTED"||lockedOwner.rows[0]?.status==="COMPLETED"||lockedOwner.rows[0]?.stageStatus==="COMPLETED") reasonCode="PERMISSION";
        const initial=(await client.query<{snapshot:MapHistorySnapshot}>("SELECT snapshot FROM map_initial_snapshots WHERE map_id=$1::uuid AND snapshot_version=1",[resolvedMapId])).rows[0]?.snapshot;
        if(!initial){await client.query("ROLLBACK");return originalJson({...((body&&typeof body==="object")?body:{}),operationOutcome:outcome,logSaved:false});}
        const legacy=await client.query<HistoryOperation>(`SELECT id,map_id AS "mapId",sequence_number AS "sequenceNumber",operation_type AS "operationType",target_type AS "targetType",target_id AS "targetId",before,after,related_operation_log_id AS "relatedOperationLogId" FROM map_operation_logs WHERE map_id=$1::uuid ORDER BY sequence_number`,[resolvedMapId]);
        const boundary=(await client.query<{legacyCount:string;legacyLastId:string|null;snapshot:MapHistorySnapshot}>(`SELECT legacy_count AS "legacyCount",legacy_last_id AS "legacyLastId",boundary_snapshot AS snapshot FROM map_history_boundaries WHERE map_id=$1::uuid`,[resolvedMapId])).rows[0];
        const stream=await client.query<MapHistoryEventV2>(`SELECT event_id AS "eventId",map_id AS "mapId",schema_version AS "schemaVersion",event_type AS "eventType",related_event_id AS "relatedEventId",related_legacy_operation_log_id AS "relatedLegacyOperationLogId",sequence_number AS "sequenceNumber",outcome,before_state AS before,after_state AS after FROM research_events WHERE map_id=$1::uuid AND schema_version IN (2,5) ORDER BY sequence_number`,[resolvedMapId]);
        if(!boundary&&stream.rowCount){await client.query("ROLLBACK");return originalJson({...((body&&typeof body==="object")?body:{}),operationOutcome:outcome,logSaved:false});}
        const baseBoundary={legacyCount:boundary?Number(boundary.legacyCount):legacy.rows.length,legacyLastId:boundary?boundary.legacyLastId:legacy.rows.at(-1)?.id??null};
        const oldReplay=replayMixedMapHistory(initial,baseBoundary,legacy.rows,[]);
        const currentReplay=oldReplay.status==="REPLAYABLE"?replayMixedMapHistory(initial,baseBoundary,legacy.rows,stream.rows):null;
        const currentSnapshot=await readCurrentMapHistorySnapshot(client,resolvedMapId);
        if(oldReplay.status!=="REPLAYABLE"||boundary&&!historySnapshotsEqual(oldReplay.state,boundary.snapshot)||!currentReplay||currentReplay.status!=="REPLAYABLE"||!currentSnapshot||!validateMapStateV5(currentSnapshot,resolvedMapId)||!historySnapshotsEqual(currentReplay.state,currentSnapshot)){
          await client.query("ROLLBACK");return originalJson({...((body&&typeof body==="object")?body:{}),operationOutcome:outcome,logSaved:false});
        }
        if(!boundary) await client.query("INSERT INTO map_history_boundaries(map_id,legacy_count,legacy_last_id,boundary_snapshot) VALUES($1::uuid,$2,$3::uuid,$4::jsonb)",[resolvedMapId,legacy.rows.length,baseBoundary.legacyLastId,JSON.stringify(currentSnapshot)]);
        const idem=request.get("Idempotency-Key");
        const validIdem=idem&&uuidPattern.test(idem)?idem:null;
        if(validIdem) {
          const prior=await client.query<{eventId:string;eventType:string;outcome:string}>(`SELECT event_id AS "eventId",event_type AS "eventType",outcome FROM research_events WHERE map_id=$1::uuid AND idempotency_key=$2::uuid`,[resolvedMapId,validIdem]);
          if(prior.rowCount) {
            if(prior.rows[0]!.eventType===eventType&&prior.rows[0]!.outcome===outcome) {
              await client.query("COMMIT");
              return originalJson({...((body&&typeof body==="object")?body:{}),operationOutcome:outcome,logSaved:true,eventId:prior.rows[0]!.eventId});
            }
            await client.query("ROLLBACK");
            return originalJson({...((body&&typeof body==="object")?body:{}),operationOutcome:outcome,logSaved:false});
          }
        }
        const event=await insertResearchEvent(client,sessionId,principal.role==="learner"?"LEARNER":"RESEARCHER",{
          schemaVersion:5,eventType,targetType,mapId:resolvedMapId,targetId:targetType==="MAP"?resolvedMapId:resolvedTargetId??undefined,
          outcome,reasonCode,clientTimeQuality:"NOT_APPLICABLE",beforeQuality:"MISSING",afterQuality:"MISSING",
          ...(validIdem?{idempotencyKey:validIdem}:{}),
        });
        if(!event){await client.query("ROLLBACK");return originalJson({...((body&&typeof body==="object")?body:{}),operationOutcome:outcome,logSaved:false});}
        await client.query("COMMIT");
        return originalJson({...((body&&typeof body==="object")?body:{}),operationOutcome:outcome,logSaved:true,eventId:event.eventId});
      } catch {
        await client.query("ROLLBACK").catch(()=>undefined);
        return originalJson({...((body&&typeof body==="object")?body:{}),operationOutcome:outcome,logSaved:false});
      } finally {client.release();}
    })();
    return response;
  }) as Response["json"];
  next();
});
app.use("/api", accessControl(pool));
registerOperationContext(app);
registerAudit(app, pool);
app.use("/api", async (request, response, next) => {
  if (!["POST", "PATCH"].includes(request.method) || !/^\/(maps|concepts|links)\//.test(request.path) || !request.body || typeof request.body.label !== "string") return next();
  const label = request.body.label as string;
  if (!validMapLabel(label) || (process.env.RESEARCHER_API_TOKEN && label.includes(process.env.RESEARCHER_API_TOKEN))) return response.status(400).json({ error: "invalid_map_label", message: "名前は512文字以内にし、URLや認証情報を含めないでください。" });
  try {
    const hashes = [label, ...label.split(/\s+/)].map(tokenHash);
    if ((await pool.query("SELECT 1 FROM sessions WHERE learner_access_token_hash=ANY($1::text[]) LIMIT 1", [hashes])).rowCount) return response.status(400).json({ error: "invalid_map_label", message: "名前にアクセスコードを含めることはできません。" });
    return next();
  } catch (error) { return next(error); }
});
app.use("/api", (request, response, next) => {
  const guarded = request.method !== "GET" && request.method !== "HEAD" &&
    (/^\/(maps|concepts|links)\//.test(request.path) || /^\/session-stages\/[^/]+\/integration-map$/.test(request.path));
  if (guarded) return deadlineContext.run({ mapIds: new Set(), stageIds: new Set(), actor: principalOf(response).role === "learner" ? "LEARNER" : "RESEARCHER" }, next);
  return next();
});
app.get("/api/me", (_request, response) => response.json(principalOf(response)));
registerStage1AnalysisRoutes(app, pool);
registerAssessmentRoutes(app, pool);
registerResearchEventRoutes(app, pool);
registerDeliveryReports(app,pool);
const eventExportPool=new Pool({connectionString:databaseUrl,max:2,connectionTimeoutMillis:5000});
const eventExports=registerEventExportRoutes(app,pool,new EventExportService(eventExportPool, {root:process.env.STAGE1_EXPORT_CACHE_ROOT}));
registerDataManagement(app,pool,eventExports);

// These endpoints record only explicit pre-commit cancellations offered by
// the learner Map UI. They do not accept event payloads or mutate the Map.
type CancellableMapEventType =
  | "ADD_CONCEPT"
  | "EDIT_CONCEPT"
  | "DELETE_CONCEPT"
  | "MERGE_CONCEPT"
  | "ADD_LINK"
  | "EDIT_LINK"
  | "DELETE_LINK"
  | "RECONNECT_LINK"
  | "IMPORT_KIT_LINK"
  | "MAP_SUBMIT";
const cancellableMapOperations: Record<CancellableMapEventType, {
  targetType: "CONCEPT" | "LINK" | "MAP";
  targetRequired: boolean;
  mapTypes: MapType[];
}> = {
  ADD_CONCEPT: { targetType: "CONCEPT", targetRequired: false, mapTypes: ["PRIOR", "INTEGRATION"] },
  EDIT_CONCEPT: { targetType: "CONCEPT", targetRequired: true, mapTypes: ["PRIOR", "INTEGRATION"] },
  DELETE_CONCEPT: { targetType: "CONCEPT", targetRequired: true, mapTypes: ["PRIOR", "INTEGRATION"] },
  MERGE_CONCEPT: { targetType: "CONCEPT", targetRequired: false, mapTypes: ["INTEGRATION"] },
  ADD_LINK: { targetType: "LINK", targetRequired: false, mapTypes: ["PRIOR", "INTEGRATION"] },
  EDIT_LINK: { targetType: "LINK", targetRequired: true, mapTypes: ["PRIOR", "INTEGRATION"] },
  DELETE_LINK: { targetType: "LINK", targetRequired: true, mapTypes: ["PRIOR", "KB", "INTEGRATION"] },
  RECONNECT_LINK: { targetType: "LINK", targetRequired: true, mapTypes: ["PRIOR", "KB", "INTEGRATION"] },
  IMPORT_KIT_LINK: { targetType: "LINK", targetRequired: false, mapTypes: ["KB", "INTEGRATION"] },
  MAP_SUBMIT: { targetType: "MAP", targetRequired: false, mapTypes: ["PRIOR", "KB", "INTEGRATION"] },
};
const recordMapOperationCancellation = async (
  request: Request<{ mapId: string; eventType?: string; targetId?: string }>,
  response: Response,
  eventType: CancellableMapEventType,
  targetId?: string,
) => {
  const { mapId } = request.params;
  const rule = cancellableMapOperations[eventType];
  const principal = principalOf(response);
  if (principal.role !== "learner" || !uuidPattern.test(mapId)) {
    return response.status(404).json({ error: "not_found" });
  }
  if (Boolean(targetId) !== rule.targetRequired || targetId && !uuidPattern.test(targetId)) {
    return response.status(400).json({ error: "invalid_cancellation_request" });
  }
  if (request.body !== undefined && request.body !== null &&
    (typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length > 0)) {
    return response.status(400).json({ error: "invalid_cancellation_request" });
  }

  const rawKey = request.get("Idempotency-Key");
  if (rawKey && !uuidPattern.test(rawKey)) return response.status(400).json({ error: "invalid_idempotency_key" });
  const idempotencyKey = rawKey || undefined;
  try {
    const result = await withTransaction(async (client) => {
      const map = await lockMapById(client, mapId);
      if (!map || !map.sessionStageId || map.mapStatus !== "DRAFT" || !rule.mapTypes.includes(map.mapType)) return null;

      const owner = await client.query<{
        sessionId: string;
        protocolKey: string;
        studyGroup: string | null;
        sessionStatus: string;
        stageType: string;
        stageStatus: string;
        currentStageId: string | null;
        expired: boolean;
      }>(
        `SELECT s.id AS "sessionId", s.protocol_key AS "protocolKey", s.study_group AS "studyGroup",
          s.status AS "sessionStatus", st.stage_type AS "stageType", st.status AS "stageStatus",
          current_stage.id AS "currentStageId",
          (s.protocol_key='STAGE1_6' AND st.stage_type='INTEGRATION_MAP'
            AND s.study_group='EXPERIMENTAL'
            AND clock_timestamp() >= st.started_at + s.group_activity_seconds * interval '1 second') AS expired
         FROM session_stages st JOIN sessions s ON s.id=st.session_id
         LEFT JOIN LATERAL (
           SELECT candidate.id FROM session_stages candidate
           WHERE candidate.session_id=s.id AND candidate.status <> 'COMPLETED'
           ORDER BY candidate.order_index LIMIT 1
         ) current_stage ON true
         WHERE st.id=$1::uuid`,
        [map.sessionStageId],
      );
      const stage = owner.rows[0];
      const expectedStageType = map.mapType === "PRIOR" ? "PRIOR_MAP" : map.mapType === "KB" ? "KB_MAP" : map.mapType === "INTEGRATION" ? "INTEGRATION_MAP" : null;
      if (!stage || stage.sessionId !== principal.sessionId || !["STAGE1_4", "STAGE1_6"].includes(stage.protocolKey)
        || !expectedStageType || stage.stageType !== expectedStageType || stage.sessionStatus !== "IN_PROGRESS"
        || stage.stageStatus !== "IN_PROGRESS" || stage.currentStageId !== map.sessionStageId || stage.expired) return null;
      if (targetId) {
        const table = rule.targetType === "CONCEPT" ? "concepts" : "links";
        if (!(await client.query(`SELECT 1 FROM ${table} WHERE id=$1::uuid AND map_id=$2::uuid`, [targetId, mapId])).rowCount) return null;
      }

      const initial = (await client.query<{ snapshot: MapHistorySnapshot }>(
        "SELECT snapshot FROM map_initial_snapshots WHERE map_id=$1::uuid AND snapshot_version=1", [mapId],
      )).rows[0]?.snapshot;
      if (!initial) return { kind: "history_unavailable" as const };
      const legacy = await client.query<HistoryOperation>(
        `SELECT id,map_id AS "mapId",sequence_number AS "sequenceNumber",operation_type AS "operationType",
          target_type AS "targetType",target_id AS "targetId",before,after,
          related_operation_log_id AS "relatedOperationLogId"
         FROM map_operation_logs WHERE map_id=$1::uuid ORDER BY sequence_number`, [mapId],
      );
      const boundary = (await client.query<{
        legacyCount: string; legacyLastId: string | null; snapshot: MapHistorySnapshot;
      }>(`SELECT legacy_count AS "legacyCount",legacy_last_id AS "legacyLastId",boundary_snapshot AS snapshot
          FROM map_history_boundaries WHERE map_id=$1::uuid`, [mapId])).rows[0];
      const events = await client.query<MapHistoryEventV2>(
        `SELECT event_id AS "eventId",map_id AS "mapId",schema_version AS "schemaVersion",event_type AS "eventType",
          related_event_id AS "relatedEventId",related_legacy_operation_log_id AS "relatedLegacyOperationLogId",
          sequence_number AS "sequenceNumber",outcome,before_state AS before,after_state AS after
         FROM research_events WHERE map_id=$1::uuid AND schema_version IN (2,5) ORDER BY sequence_number`, [mapId],
      );
      if (!boundary && events.rowCount) return { kind: "history_unavailable" as const };
      const definition = {
        legacyCount: boundary ? Number(boundary.legacyCount) : legacy.rows.length,
        legacyLastId: boundary ? boundary.legacyLastId : legacy.rows.at(-1)?.id ?? null,
      };
      const oldReplay = replayMixedMapHistory(initial, definition, legacy.rows, []);
      const replay = oldReplay.status === "REPLAYABLE"
        ? replayMixedMapHistory(initial, definition, legacy.rows, events.rows)
        : null;
      const current = await readCurrentMapHistorySnapshot(client, mapId);
      if (oldReplay.status !== "REPLAYABLE" || boundary && !historySnapshotsEqual(oldReplay.state, boundary.snapshot)
        || !replay || replay.status !== "REPLAYABLE" || !current || !validateMapStateV5(current,mapId) || !historySnapshotsEqual(replay.state, current)) {
        return { kind: "history_unavailable" as const };
      }

      const key = idempotencyKey;
      if (key) {
        const prior = await client.query<{ eventId: string; eventType: string; targetId: string | null }>(
          `SELECT event_id AS "eventId",event_type AS "eventType",target_id AS "targetId"
           FROM research_events WHERE map_id=$1::uuid AND idempotency_key=$2::uuid`,
          [mapId, key],
        );
        if (prior.rowCount) {
          const previous = prior.rows[0]!;
          const expectedTargetId = targetId ?? (rule.targetType === "MAP" ? mapId : null);
          if (previous.eventType !== eventType || previous.targetId !== expectedTargetId) return { kind: "idempotency_conflict" as const };
          return { kind: "cancelled" as const, eventId: previous.eventId, duplicate: true };
        }
      }
      if (!boundary) {
        await client.query(
          "INSERT INTO map_history_boundaries(map_id,legacy_count,legacy_last_id,boundary_snapshot) VALUES($1::uuid,$2,$3::uuid,$4::jsonb)",
          [mapId, legacy.rows.length, definition.legacyLastId, JSON.stringify(current)],
        );
      }
      const event = await insertResearchEvent(client, stage.sessionId, "LEARNER", {
        schemaVersion: 2,
        eventType,
        targetType: rule.targetType,
        mapId,
        ...(targetId ? { targetId } : {}),
        outcome: "CANCELLED",
        reasonCode: "USER_CANCELLED",
        clientTimeQuality: "NOT_APPLICABLE",
        beforeQuality: "MISSING",
        afterQuality: "MISSING",
        ...(key ? { idempotencyKey: key } : {}),
      });
      if (!event) throw new Error("Cancellation event could not be saved");
      return { kind: "cancelled" as const, eventId: event.eventId, duplicate: false };
    });

    if (!result) return response.status(404).json({ error: "not_found" });
    if (result.kind === "history_unavailable") return response.status(409).json({ error: "map_history_unavailable", operationOutcome: "CANCELLED", logSaved: false });
    if (result.kind === "idempotency_conflict") return response.status(409).json({ error: "idempotency_key_conflict", operationOutcome: "CANCELLED", logSaved: false });
    return response.status(result.duplicate ? 200 : 201).json({ eventId: result.eventId, operationOutcome: "CANCELLED", logSaved: true });
  } catch {
    return response.status(500).json({ error: "cancellation_record_failed", operationOutcome: "CANCELLED", logSaved: false });
  }
};
app.post("/api/maps/:mapId/operation-cancellations/:eventType", (request, response) => {
  if (principalOf(response).role !== "learner" || !uuidPattern.test(request.params.mapId)) return response.status(404).json({ error: "not_found" });
  const eventType = request.params.eventType as CancellableMapEventType;
  if (!Object.hasOwn(cancellableMapOperations, eventType)) return response.status(400).json({ error: "invalid_cancellation_request" });
  return recordMapOperationCancellation(request as Request<{ mapId: string; eventType?: string; targetId?: string }>, response, eventType);
});
app.post("/api/maps/:mapId/operation-cancellations/:eventType/:targetId", (request, response) => {
  if (principalOf(response).role !== "learner" || !uuidPattern.test(request.params.mapId)) return response.status(404).json({ error: "not_found" });
  const eventType = request.params.eventType as CancellableMapEventType;
  if (!Object.hasOwn(cancellableMapOperations, eventType)) return response.status(400).json({ error: "invalid_cancellation_request" });
  return recordMapOperationCancellation(request as Request<{ mapId: string; eventType?: string; targetId?: string }>, response, eventType, request.params.targetId);
});
// Read-only compatibility endpoint. It does not create a boundary or alter logs.
app.get("/api/research/sessions/:sessionId/maps/:mapId/mixed-history", async (request, response) => {
  const { sessionId, mapId } = request.params;
  if (principalOf(response).role !== "researcher" || !uuidPattern.test(sessionId) || !uuidPattern.test(mapId)) return response.status(404).json({ error: "not_found" });
  try {
    const result = await withTransaction(async client => {
      const map = await lockMapById(client, mapId);
      if (!map || !(await isStage1LearnerMap(client, mapId))) return null;
      const belongs = await client.query("SELECT 1 FROM maps m JOIN session_stages st ON st.id=m.session_stage_id WHERE m.id=$1::uuid AND st.session_id=$2::uuid", [mapId, sessionId]);
      if (!belongs.rowCount) return null;
      const initial = await client.query<{ snapshot: MapHistorySnapshot }>("SELECT snapshot FROM map_initial_snapshots WHERE map_id=$1::uuid AND snapshot_version=1", [mapId]);
      const old = await client.query<HistoryOperation>(`SELECT id,map_id AS "mapId",sequence_number AS "sequenceNumber",operation_type AS "operationType",target_type AS "targetType",target_id AS "targetId",before,after,related_operation_log_id AS "relatedOperationLogId" FROM map_operation_logs WHERE map_id=$1::uuid ORDER BY sequence_number`, [mapId]);
      const boundary = await client.query<{ legacyCount: string; legacyLastId: string | null; snapshot: MapHistorySnapshot }>(`SELECT legacy_count AS "legacyCount",legacy_last_id AS "legacyLastId",boundary_snapshot AS snapshot FROM map_history_boundaries WHERE map_id=$1::uuid`, [mapId]);
      const newer = await client.query<MapHistoryEventV2>(`SELECT event_id AS "eventId",map_id AS "mapId",schema_version AS "schemaVersion",event_type AS "eventType",related_event_id AS "relatedEventId",related_legacy_operation_log_id AS "relatedLegacyOperationLogId",sequence_number AS "sequenceNumber",outcome,before_state AS before,after_state AS after FROM research_events WHERE session_id=$1::uuid AND map_id=$2::uuid AND schema_version IN (2,5) ORDER BY sequence_number`, [sessionId, mapId]);
      if (!initial.rows[0]) return { status: "UNAVAILABLE", reason: "初期スナップショットがありません。", state: null };
      if (!boundary.rows[0] && newer.rows.length) return { status: "PARTIAL", reason: "新イベントの切替境界がありません。", state: null };
      const legacyBoundary = boundary.rows[0] ?? { legacyCount: String(old.rows.length), legacyLastId: old.rows.at(-1)?.id ?? null };
      const count = Number(legacyBoundary.legacyCount);
      const definition = { legacyCount: count, legacyLastId: legacyBoundary.legacyLastId };
      const legacyReplay = replayMixedMapHistory(initial.rows[0].snapshot, definition, old.rows, []);
      if (legacyReplay.status !== "REPLAYABLE") return legacyReplay;
      if (boundary.rows[0] && !historySnapshotsEqual(legacyReplay.state, boundary.rows[0].snapshot)) return { status: "PARTIAL", reason: "切替時点の状態が旧履歴と一致しません。", state: null };
      const replay = replayMixedMapHistory(initial.rows[0].snapshot, definition, old.rows, newer.rows);
      if (replay.status !== "REPLAYABLE") return replay;
      const current = await readCurrentMapHistorySnapshot(client, mapId);
      if (!current || !historySnapshotsEqual(replay.state, current)) return { status: "PARTIAL", reason: "履歴の最終状態が保存済みマップと一致しません。", state: null };
      return replay;
    });
    return result ? response.json(result) : response.status(404).json({ error: "not_found" });
  } catch {
    return response.status(500).json({ error: "map_history_fetch_failed" });
  }
});

app.get("/api/research/goal-maps", async (_request, response) => {
  if (principalOf(response).role !== "researcher") {
    return response.status(404).json({ error: "not_found" });
  }
  try {
    const result = await pool.query<{
      id: string;
      title: string | null;
      createdAt: string;
      conceptCount: number;
      linkCount: number;
      kitDefinitionId: string | null;
      kitDefinitionName: string | null;
    }>(
      `SELECT
         map.id,
         map.title,
         map.created_at AS "createdAt",
         (SELECT count(*)::int FROM concepts WHERE map_id = map.id AND merged_into_concept_id IS NULL) AS "conceptCount",
         (SELECT count(*)::int FROM links WHERE map_id = map.id) AS "linkCount",
         kit.id AS "kitDefinitionId",
         kit.name AS "kitDefinitionName"
       FROM maps AS map
       LEFT JOIN LATERAL (
         SELECT id, name FROM kit_definitions WHERE goal_map_id = map.id
         ORDER BY created_at, id LIMIT 1
       ) AS kit ON true
       WHERE map.type = 'GOAL'
       ORDER BY map.created_at DESC, map.id`,
    );
    return response.json({ goalMaps: result.rows });
  } catch (error) {
    console.error("Failed to list Goal Maps", safeServerErrorCode(error));
    return response.status(500).json({ error: "goal_map_list_failed" });
  }
});

app.post("/api/research/goal-maps", async (request, response) => {
  if (principalOf(response).role !== "researcher") {
    return response.status(404).json({ error: "not_found" });
  }
  const body: unknown = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return response.status(400).json({ error: "invalid_request" });
  }
  const title = typeof (body as Record<string, unknown>).title === "string"
    ? ((body as Record<string, unknown>).title as string).trim()
    : "";
  if (!title || title.length > 120) {
    return response.status(400).json({
      error: "invalid_goal_map_title",
      message: "Goal Map名は1〜120文字で入力してください。",
    });
  }
  try {
    const result = await pool.query<{ id: string; title: string; createdAt: string }>(
      `INSERT INTO maps (type, status, title)
       VALUES ('GOAL', 'DRAFT', $1)
       RETURNING id, title, created_at AS "createdAt"`,
      [title],
    );
    const map = result.rows[0];
    if (!map) throw new Error("Goal Map insert returned no row");
    return response.status(201).json(map);
  } catch (error) {
    console.error("Failed to create Goal Map", safeServerErrorCode(error));
    return response.status(500).json({ error: "goal_map_create_failed" });
  }
});

app.get("/api/maps/:mapId/undo-redo", async (request, response) => {
  const { mapId } = request.params;
  if (!uuidPattern.test(mapId)) {
    return response.status(400).json({ error: "invalid_map_id" });
  }
  try {
    const outcome = await withTransaction(async (client) => {
      const map = await lockMapById(client, mapId);
      if (!map || !(await isStage1LearnerMap(client, mapId))) {
        return { kind: "map_not_found" as const };
      }
      let editable = true;
      try {
        ensureMapIsEditable(map);
      } catch {
        editable = false;
      }
      const context = await readUndoRedoContext(client, mapId);
      return { kind: "state" as const, state: undoRedoPayload(map, context, editable) };
    });
    if (outcome.kind === "map_not_found") {
      return response.status(404).json({ error: "map_not_found" });
    }
    return response.json(outcome.state);
  } catch (error) {
    console.error("Failed to read Undo/Redo state", safeServerErrorCode(error));
    return response.status(500).json({ error: "undo_redo_state_failed" });
  }
});

app.post("/api/maps/:mapId/undo-redo", async (request, response) => {
  const { mapId } = request.params;
  if (!uuidPattern.test(mapId)) {
    return response.status(400).json({ error: "invalid_map_id" });
  }
  const principal = principalOf(response);
  if (principal.role !== "learner") {
    return response.status(403).json({ error: "learner_action_required" });
  }
  const body: unknown = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return response.status(400).json({ error: "invalid_request" });
  }
  const payload = body as Record<string, unknown>;
  const action = payload.action;
  const expectedSequenceNumber = payload.expectedSequenceNumber;
  const idempotencyKey = payload.idempotencyKey;
  if (action !== "UNDO" && action !== "REDO") {
    return response.status(400).json({ error: "invalid_undo_redo_action" });
  }
  if (
    typeof expectedSequenceNumber !== "number" ||
    !Number.isSafeInteger(expectedSequenceNumber) ||
    expectedSequenceNumber < 0
  ) {
    return response.status(400).json({ error: "invalid_expected_sequence_number" });
  }
  if (typeof idempotencyKey !== "string" || !uuidPattern.test(idempotencyKey)) {
    return response.status(400).json({ error: "invalid_idempotency_key" });
  }
  const timestamp = validateClientTimestamp(payload.clientTimestamp);
  if (!timestamp.valid) {
    return response.status(400).json({ error: "invalid_client_timestamp" });
  }

  try {
    const outcome = await withTransaction(async (client) => {
      const map = await lockMapById(client, mapId);
      if (!map || !(await isStage1LearnerMap(client, mapId))) {
        return { kind: "map_not_found" as const };
      }

      const duplicate = await client.query<{
        id: string;
        operationType: string;
        relatedOperationLogId: string | null;
        sequenceNumber: string;
      }>(
        `SELECT id, operation_type AS "operationType",
                related_operation_log_id AS "relatedOperationLogId",
                sequence_number AS "sequenceNumber"
         FROM map_operation_logs
         WHERE map_id=$1::uuid AND idempotency_key=$2::uuid`,
        [mapId, idempotencyKey],
      );
      let priorRequest = duplicate.rows[0];
      const boundaryTable = (await client.query<{ name: string | null }>("SELECT to_regclass('map_history_boundaries')::text AS name")).rows[0]?.name;
      if (!priorRequest && boundaryTable) {
        const previous = await client.query<{ id: string; operationType: string; relatedOperationLogId: string | null; sequenceNumber: string }>(`SELECT event_id AS id,event_type AS "operationType",coalesce(related_event_id,related_legacy_operation_log_id) AS "relatedOperationLogId",sequence_number AS "sequenceNumber" FROM research_events WHERE map_id=$1::uuid AND idempotency_key=$2::uuid`, [mapId,idempotencyKey]);
        priorRequest = previous.rows[0];
      }
      if (priorRequest) {
        if (priorRequest.operationType !== action) {
          return { kind: "idempotency_conflict" as const };
        }
        const context = await readUndoRedoContext(client, mapId);
        return {
          kind: "applied" as const,
          operationId: priorRequest.id,
          relatedOperationLogId: priorRequest.relatedOperationLogId,
          sequenceNumber: String(context.operations.findIndex(item => item.id === priorRequest.id) + 1),
          duplicate: true,
          state: undoRedoPayload(map, context, map.mapStatus === "DRAFT"),
        };
      }

      ensureMapIsEditable(map);
      const context = await readUndoRedoContext(client, mapId);
      const state = undoRedoPayload(map, context, true);
      if (
        context.status !== "AVAILABLE" ||
        !context.initial ||
        !context.current
      ) {
        return { kind: "unavailable" as const, state };
      }
      if (expectedSequenceNumber !== context.operations.length) {
        return { kind: "stale" as const, state };
      }

      const target = action === "UNDO" ? context.undoOperation : context.redoOperation;
      if (!target) return { kind: "unavailable" as const, state };
      const targetIndex = context.operations.findIndex((item) => item.id === target.id);
      if (targetIndex < 0) return { kind: "unavailable" as const, state };

      const beforeTarget = replayMapAt(context.initial, context.operations, targetIndex);
      const afterTarget = replayMapAt(context.initial, context.operations, targetIndex + 1);
      if (beforeTarget.status !== "REPLAYABLE" || afterTarget.status !== "REPLAYABLE") {
        return { kind: "unavailable" as const, state };
      }
      const expectedCurrent = action === "UNDO" ? afterTarget.state : beforeTarget.state;
      const desired = action === "UNDO" ? beforeTarget.state : afterTarget.state;
      if (!historySnapshotsEqual(expectedCurrent, context.current)) {
        return { kind: "stale" as const, state };
      }

      const delta = historyStateDelta(
        expectedCurrent,
        desired,
        target.id,
        target.operationType,
      );
      if (delta.affectedConceptIds.length === 0 && delta.affectedLinkIds.length === 0) {
        return { kind: "unavailable" as const, state };
      }
      await applyHistoryStateDelta(client, mapId, delta, desired);
      const event = await appendMapOperationLog(client, {
        mapId,
        operationType: action,
        targetType: target.targetType === "LINK" ? "LINK" : "CONCEPT",
        targetId: target.targetId,
        before: delta.before,
        after: delta.after,
        clientTimestamp: timestamp.value,
        relatedOperationLogId: target.id,
        idempotencyKey,
      });
      const updatedContext = await readUndoRedoContext(client, mapId);
      return {
        kind: "applied" as const,
        operationId: event.id,
        relatedOperationLogId: target.id,
        sequenceNumber: event.sequenceNumber,
        duplicate: false,
        state: undoRedoPayload(map, updatedContext, true),
      };
    });

    if (outcome.kind === "map_not_found") {
      return response.status(404).json({ error: "map_not_found" });
    }
    if (outcome.kind === "idempotency_conflict") {
      return response.status(409).json({ error: "idempotency_key_reused" });
    }
    if (outcome.kind === "unavailable") {
      return response.status(409).json({ error: "undo_redo_unavailable", state: outcome.state });
    }
    if (outcome.kind === "stale") {
      return response.status(409).json({ error: "stale_operation_history", state: outcome.state });
    }
    return response.json(outcome);
  } catch (error) {
    const policyResponse = readOnlyMapResponse(response, error);
    if (policyResponse) return policyResponse;
    if (isPostgresErrorCode(error, "23503") || isPostgresErrorCode(error, "23505")) {
      return response.status(409).json({ error: "undo_redo_conflict" });
    }
    console.error("Failed to apply Undo/Redo", safeServerErrorCode(error));
    return response.status(500).json({ error: "undo_redo_failed" });
  }
});

function hasUnexpectedEmptyBody(body: unknown): boolean {
  return (
    body !== undefined &&
    (typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 0)
  );
}

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error", safeServerErrorCode(error));
});

app.get("/api/research/stage1/settings", async (_request, response) => {
  try { const result = await pool.query<{ minutes: number }>("SELECT group_activity_seconds / 60 AS minutes FROM research_settings WHERE id=1"); return response.json({ minutes: result.rows[0]?.minutes ?? null }); }
  catch { return response.status(500).json({ error: "settings_fetch_failed" }); }
});
app.put("/api/research/stage1/settings", async (request, response) => {
  const minutes = request.body?.minutes;
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 35791394) return response.status(400).json({ error: "invalid_duration", message: "正の整数の分数を指定してください。" });
  try { await withTransaction(async client => { await client.query("INSERT INTO research_settings (id, group_activity_seconds) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET group_activity_seconds=EXCLUDED.group_activity_seconds", [minutes * 60]); await auditCurrent(client); }); return response.json({ minutes }); }
  catch { return response.status(500).json({ error: "settings_save_failed" }); }
});

app.post("/api/research/stage1/sessions", async (request, response) => {
  const body: unknown = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return response.status(400).json({ error: "invalid_stage1_request" });
  }
  const data = body as Record<string, unknown>;
  const participantCode =
    typeof data.participantCode === "string" ? data.participantCode.trim() : "";
  const requestedVideo =
    typeof data.videoUrl === "string" ? data.videoUrl.trim() : "";
  const videoUrl = requestedVideo || process.env.STAGE1_VIDEO_URL?.trim() || "";
  const kitDefinitionId = data.kitDefinitionId;
  const studyGroup = data.studyGroup;
  const validVideoUrl =
    videoUrl.length > 0 &&
    videoUrl.length <= 2048 &&
    ((videoUrl.startsWith("/") && !videoUrl.startsWith("//")) ||
      /^https?:\/\//i.test(videoUrl));
  if (
    (studyGroup !== "EXPERIMENTAL" && studyGroup !== "CONTROL") ||
    !participantCode ||
    participantCode.length > 64 ||
    !validVideoUrl ||
    typeof kitDefinitionId !== "string" ||
    !uuidPattern.test(kitDefinitionId)
  ) {
    return response.status(400).json({
      error: "invalid_stage1_request",
      message: "仮名の参加者コード、授業動画URL、教材Kitを指定してください。",
    });
  }
  try {
    const result = await withTransaction(async (client) => {
      const settings = await client.query<{ seconds: number }>("SELECT group_activity_seconds AS seconds FROM research_settings WHERE id=1 FOR SHARE");
      if (!settings.rows[0]) return { kind: "settings_missing" as const };
      const kit = await client.query<{ id: string; goalMapId: string }>(
        `SELECT kit.id, kit.goal_map_id AS "goalMapId"
         FROM kit_definitions AS kit
         INNER JOIN maps AS goal_map
           ON goal_map.id = kit.goal_map_id AND goal_map.type = 'GOAL'
         WHERE kit.id = $1::uuid AND kit.id <> $2::uuid
         FOR SHARE OF kit, goal_map`,
        [kitDefinitionId, RETIRED_DEVELOPMENT_KIT_ID],
      );
      if (kit.rowCount !== 1) return { kind: "kit_not_found" as const };
      const coverage = await client.query<{
        goalConcepts: number;
        kitConceptItems: number;
        validKitConceptItems: number;
        goalLinks: number;
        kitLinkItems: number;
        validKitLinkItems: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM concepts AS goal_concept
            WHERE goal_concept.map_id = $1::uuid
              AND goal_concept.merged_into_concept_id IS NULL) AS "goalConcepts",
           (SELECT count(*)::int FROM kit_concept_items AS item
            WHERE item.kit_definition_id = $2::uuid) AS "kitConceptItems",
           (SELECT count(*)::int
            FROM kit_concept_items AS item
            INNER JOIN concepts AS goal_concept
              ON goal_concept.id = item.source_concept_id
              AND goal_concept.map_id = $1::uuid
              AND goal_concept.merged_into_concept_id IS NULL
            WHERE item.kit_definition_id = $2::uuid) AS "validKitConceptItems",
           (SELECT count(*)::int FROM links AS goal_link
            WHERE goal_link.map_id = $1::uuid) AS "goalLinks",
           (SELECT count(*)::int FROM kit_link_items AS item
            WHERE item.kit_definition_id = $2::uuid) AS "kitLinkItems",
           (SELECT count(*)::int
            FROM kit_link_items AS item
            INNER JOIN links AS goal_link
              ON goal_link.id = item.source_link_id
              AND goal_link.map_id = $1::uuid
            INNER JOIN concepts AS goal_source
              ON goal_source.id = goal_link.source_concept_id
              AND goal_source.map_id = $1::uuid
              AND goal_source.merged_into_concept_id IS NULL
            INNER JOIN concepts AS goal_target
              ON goal_target.id = goal_link.target_concept_id
              AND goal_target.map_id = $1::uuid
              AND goal_target.merged_into_concept_id IS NULL
            WHERE item.kit_definition_id = $2::uuid) AS "validKitLinkItems"`,
        [kit.rows[0]!.goalMapId, kitDefinitionId],
      );
      const parts = coverage.rows[0];
      if (
        !parts ||
        parts.goalConcepts === 0 ||
        parts.goalConcepts !== parts.kitConceptItems ||
        parts.kitConceptItems !== parts.validKitConceptItems ||
        parts.goalLinks !== parts.kitLinkItems ||
        parts.kitLinkItems !== parts.validKitLinkItems
      ) {
        return { kind: "kit_not_complete" as const };
      }
      const session = await createStage1Session(client, {
        participantCode,
        lessonVideoUrl: videoUrl,
        kitDefinitionId,
        studyGroup: studyGroup as "EXPERIMENTAL" | "CONTROL",
        groupActivitySeconds: settings.rows[0].seconds,
      });
      const credential = createLearnerToken();
      await storeLearnerToken(client, session.id, credential.hash);
      await auditCurrent(client, { sessionId: session.id });
      return { kind: "created" as const, session, learnerAccessToken: credential.token };
    });
    if (result.kind === "settings_missing") return response.status(409).json({ error: "settings_missing", message: "群別活動の共通時間を設定してください。" });
    if (result.kind === "kit_not_found") {
      return response.status(404).json({ error: "kit_not_found" });
    }
    if (result.kind === "kit_not_complete") {
      return response.status(422).json({
        error: "stage1_kit_must_cover_goal_map",
        message:
          "Stage 1のKit-Buildでは、Goal Mapのすべての概念と関係を含むKitDefinitionが必要です。",
      });
    }
    return response.status(201).json({ ...result.session, learnerAccessToken: result.learnerAccessToken });
  } catch {
    console.error("stage1_session_create_failed");
    return response.status(500).json({ error: "stage1_session_create_failed" });
  }
});

app.post("/api/research/stage1/sessions/:sessionId/learner-token", async (request, response) => {
  const { sessionId } = request.params;
  if (!uuidPattern.test(sessionId)) return response.status(404).json({ error: "not_found" });
  try {
    const result = await withTransaction(async (client) => {
      const session = await client.query(
        "SELECT id FROM sessions WHERE id=$1::uuid AND protocol_key IN ('STAGE1_4','STAGE1_6') FOR UPDATE",
        [sessionId],
      );
      if (!session.rowCount) return null;
      const credential = createLearnerToken();
      await storeLearnerToken(client, sessionId, credential.hash);
      await auditCurrent(client);
      return credential.token;
    });
    if (!result) return response.status(404).json({ error: "not_found" });
    return response.json({ learnerAccessToken: result });
  } catch {
    console.error("learner_token_rotation_failed");
    return response.status(500).json({ error: "learner_token_rotation_failed" });
  }
});

async function currentLearnerMapState(sessionId: string) {
  const result = await pool.query<{ id: string; status: string; type: string; expired: boolean; autoSubmittedAt: Date | null }>(
    `SELECT m.id, m.status, m.type, m.auto_submitted_at AS "autoSubmittedAt",
       (s.protocol_key = 'STAGE1_6' AND st.stage_type = 'INTEGRATION_MAP' AND clock_timestamp() >= st.started_at + s.group_activity_seconds * interval '1 second') AS expired
     FROM sessions s
     JOIN LATERAL (
       SELECT id, status, stage_type, started_at FROM session_stages
       WHERE session_id = s.id AND status <> 'COMPLETED'
       ORDER BY order_index LIMIT 1
     ) st ON st.status = 'IN_PROGRESS'
     JOIN maps m ON m.session_stage_id = st.id
       AND ((m.type = 'PRIOR' AND st.stage_type = 'PRIOR_MAP')
         OR (m.type = 'KB' AND st.stage_type = 'KB_MAP')
         OR (m.type = 'INTEGRATION' AND st.stage_type = 'INTEGRATION_MAP'))
     WHERE s.id = $1::uuid AND s.status = 'IN_PROGRESS'`,
    [sessionId],
  );
  const map = result.rows[0];
  return {
    visibleMapId: map?.status === "DRAFT" && !map.expired ? map.id : null,
    integrationSubmitted: map?.type === "INTEGRATION" && map.status === "SUBMITTED",
    integrationExists: map?.type === "INTEGRATION",
    integrationAutoSubmittedAt: map?.type === "INTEGRATION" ? map.autoSubmittedAt : null,
  };
}

function learnerStage<T extends { mapId: string | null }>(stage: T, visibleMapId: string | null): T {
  return { ...stage, mapId: stage.mapId === visibleMapId ? stage.mapId : null };
}

app.get("/api/sessions/:sessionId", async (request, response) => {
  const { sessionId } = request.params;
  if (!uuidPattern.test(sessionId)) {
    return response.status(400).json({
      error: "invalid_session_id",
      message: "Session IDの形式が正しくありません。",
    });
  }

  try {
    const session = await getSession(pool, sessionId);
    if (!session) {
      return response.status(404).json({
        error: "session_not_found",
        message: "Sessionが見つかりません。",
      });
    }
    if (principalOf(response).role === "learner") {
      const { visibleMapId } = await currentLearnerMapState(sessionId);
      return response.json({
        ...session,
        stages: session.stages.map((stage) => learnerStage(stage, visibleMapId)),
      });
    }
    return response.json(session);
  } catch (error) {
    console.error("Failed to fetch Session", safeServerErrorCode(error));
    return response.status(500).json({
      error: "session_fetch_failed",
      message: "Sessionを取得できませんでした。",
    });
  }
});

app.get(
  "/api/research/sessions/:sessionId/export",
  async (request, response) => {
    const { sessionId } = request.params;
    if (!uuidPattern.test(sessionId)) {
      return response.status(400).json({
        error: "invalid_session_id",
        message: "Session IDの形式が正しくありません。",
      });
    }

    let client: PoolClient | null = null;
    try {
      client = await pool.connect();
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const result = await buildSessionRawExport(client, sessionId);
      if (result.kind === "not_found") {
        await client.query("COMMIT");
        return response.status(404).json({
          error: "session_not_found",
          message: "Sessionが見つかりません。",
        });
      }
      if (result.kind === "not_completed") {
        await client.query("COMMIT");
        return response.status(409).json({
          error: "session_not_completed",
          message: "完了済みSessionだけをExportできます。",
          status: result.status,
        });
      }
      if (result.kind === "inconsistent") {
        await client.query("COMMIT");
        return response.status(409).json({
          error: "session_export_data_inconsistent",
          message: "Sessionの研究データに不整合があるためExportできません。",
          detail: result.detail,
        });
      }

      await client.query("COMMIT");
      return response
        .status(200)
        .set("Content-Type", "application/json; charset=utf-8")
        .set(
          "Content-Disposition",
          `attachment; filename="session-${sessionId}-raw-export.json"`,
        )
        .json(result.value);
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      console.error("Failed to export Session research data", safeServerErrorCode(error));
      return response.status(500).json({
        error: "session_export_failed",
        message: "Sessionの研究データをExportできませんでした。",
      });
    } finally {
      client?.release();
    }
  },
);

app.get("/api/sessions/:sessionId/flow", async (request, response) => {
  const { sessionId } = request.params;
  if (!uuidPattern.test(sessionId)) {
    return response.status(400).json({
      error: "invalid_session_id",
      message: "Session IDの形式が正しくありません。",
    });
  }

  try {
    const flow = await getSessionFlow(pool, sessionId);
    if (!flow) {
      return response.status(404).json({
        error: "session_not_found",
        message: "Sessionが見つかりません。",
      });
    }
    const clock = await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const mapState = await currentLearnerMapState(sessionId);
    const visibleFlow = principalOf(response).role === "learner"
      ? {
          ...flow,
          stages: flow.stages.map((stage) => learnerStage(stage, mapState.visibleMapId)),
          currentStage: flow.currentStage && learnerStage(flow.currentStage, mapState.visibleMapId),
          nextStage: flow.nextStage && learnerStage(flow.nextStage, mapState.visibleMapId),
        }
      : flow;
    return response.json({ ...visibleFlow, currentMapSubmitted: mapState.integrationSubmitted, currentIntegrationMapExists: mapState.integrationExists, currentMapAutoSubmittedAt: mapState.integrationAutoSubmittedAt, serverNow: clock.rows[0]!.now });
  } catch (error) {
    console.error("Failed to fetch Session flow", safeServerErrorCode(error));
    return response.status(500).json({
      error: "session_flow_fetch_failed",
      message: "Sessionの進行状況を取得できませんでした。",
    });
  }
});

app.get("/api/sessions/:sessionId/self-study-maps", async (request, response) => {
  const { sessionId } = request.params;
  if (!uuidPattern.test(sessionId)) return response.status(404).json({ error: "not_found" });
  try {
    const result = await pool.query<{ id: string; type: string }>(`
      SELECT m.id, m.type FROM sessions s
      JOIN session_stages current_stage ON current_stage.session_id=s.id AND current_stage.stage_type='SELF_STUDY' AND current_stage.status='IN_PROGRESS'
      JOIN session_stages st ON st.session_id=s.id AND st.stage_type IN ('PRIOR_MAP','KB_MAP') AND st.status='COMPLETED'
      JOIN maps m ON m.session_stage_id=st.id AND m.status='SUBMITTED' AND ((st.stage_type='PRIOR_MAP' AND m.type='PRIOR') OR (st.stage_type='KB_MAP' AND m.type='KB'))
      WHERE s.id=$1::uuid AND s.protocol_key='STAGE1_6' AND s.study_group='CONTROL' AND s.status='IN_PROGRESS'
        AND current_stage.id=(SELECT id FROM session_stages WHERE session_id=s.id AND status <> 'COMPLETED' ORDER BY order_index LIMIT 1)
        AND ($2::boolean OR clock_timestamp() < current_stage.started_at + s.group_activity_seconds * interval '1 second')
      ORDER BY st.order_index`, [sessionId, principalOf(response).role === "researcher"]);
    if (result.rows.length !== 2) return response.status(409).json({ error: "self_study_unavailable", message: "自主学習用の提出済みMapを取得できません。" });
    return response.json({ maps: result.rows });
  } catch { return response.status(500).json({ error: "self_study_fetch_failed" }); }
});

app.post("/api/sessions/:sessionId/start", async (request, response) => {
  const { sessionId } = request.params;
  if (!uuidPattern.test(sessionId)) {
    return response.status(400).json({
      error: "invalid_session_id",
      message: "Session IDの形式が正しくありません。",
    });
  }
  if (hasUnexpectedEmptyBody(request.body)) {
    return response.status(400).json({
      error: "invalid_session_start_request",
      message:
        "startedAtはサーバー側で設定されるため、request bodyは省略するか空にしてください。",
    });
  }

  try {
    const outcome = await withTransaction(async (client) => {
      const current = await client.query<{ status: string; protocolKey: string }>(
        "SELECT status, protocol_key AS \"protocolKey\" FROM sessions WHERE id = $1::uuid AND protocol_key IN ('STAGE1_4','STAGE1_6') FOR UPDATE",
        [sessionId],
      );
      const session = current.rows[0];
      if (!session) return { kind: "not_found" as const };
      if (session.status !== "NOT_STARTED") {
        return { kind: "conflict" as const, status: session.status };
      }
      if (session.protocolKey === "STAGE1_6") {
        const questions = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM assessment_questions WHERE session_id=$1::uuid AND category='DESCRIPTION'", [sessionId]);
        if ((questions.rows[0]?.count ?? 0) < 2) return { kind: "questions_missing" as const };
      }

      const updated = await client.query<{
        id: string;
        status: string;
        startedAt: Date;
        completedAt: Date | null;
      }>(
        `
          UPDATE sessions
          SET status = 'IN_PROGRESS', started_at = clock_timestamp()
          WHERE id = $1::uuid AND status = 'NOT_STARTED'
          RETURNING id, status, started_at AS "startedAt",
            completed_at AS "completedAt"
        `,
        [sessionId],
      );
      const result = updated.rows[0];
      if (!result) throw new Error("Session start returned no row");
      const log = await insertResearchEventBestEffort(client, sessionId, principalOf(response).role === "learner" ? "LEARNER" : "RESEARCHER", {
        eventType: "SESSION_START", targetType: "SESSION", outcome: "SUCCESS", clientTimeQuality: "NOT_APPLICABLE",
      });
      return { kind: "started" as const, session: result, logSaved: log.logSaved };
    });

    if (outcome.kind === "started") return response.json({ ...outcome.session, logSaved: outcome.logSaved });
    if (outcome.kind === "not_found") {
      return response.status(404).json({
        error: "session_not_found",
        message: "Sessionが見つかりません。",
      });
    }
    if (outcome.kind === "questions_missing") return response.status(409).json({ error: "questions_missing", message: "Session開始前に記述問題を2問以上登録してください。" });
    return response.status(409).json({
      error: "session_cannot_start",
      message: "NOT_STARTEDのSessionだけ開始できます。",
      status: outcome.status,
    });
  } catch (error) {
    console.error("Failed to start Session", safeServerErrorCode(error));
    return response.status(500).json({
      error: "session_start_failed",
      message: "Sessionを開始できませんでした。",
    });
  }
});

app.post("/api/session-stages/:stageId/start", async (request, response) => {
  const { stageId } = request.params;
  if (!uuidPattern.test(stageId)) {
    return response.status(400).json({
      error: "invalid_session_stage_id",
      message: "SessionStage IDの形式が正しくありません。",
    });
  }
  if (hasUnexpectedEmptyBody(request.body)) {
    return response.status(400).json({
      error: "invalid_session_stage_start_request",
      message:
        "startedAtはサーバー側で設定されるため、request bodyは省略するか空にしてください。",
    });
  }

  try {
    const outcome = await withTransaction(async (client) => {
      const stage = await lockSessionStageProgress(client, stageId);
      if (!stage) return { kind: "not_found" as const };
      const flow = await assertStageIsCurrent(client, stage);
      if (flow.kind !== "ready") {
        return { kind: "flow_conflict" as const, flow };
      }
      if (stage.sessionStatus !== "IN_PROGRESS") {
        return {
          kind: "session_not_in_progress" as const,
          sessionStatus: stage.sessionStatus,
        };
      }
      if (stage.status === "IN_PROGRESS") {
        {
          const expired = await client.query(`SELECT 1 FROM session_stages st JOIN sessions s ON s.id=st.session_id
            WHERE st.id=$1::uuid AND s.protocol_key='STAGE1_6' AND st.stage_type IN ('INTEGRATION_MAP','SELF_STUDY')
              AND clock_timestamp() >= st.started_at + s.group_activity_seconds * interval '1 second'`, [stageId]);
          if (expired.rowCount) return { kind: "time_expired" as const };
        }
        const log = await insertResearchEventBestEffort(client, stage.sessionId, principalOf(response).role === "learner" ? "LEARNER" : "RESEARCHER", {
          eventType: "STAGE_RESUME", targetType: "STAGE", stageId, outcome: "SUCCESS", clientTimeQuality: "NOT_APPLICABLE",
        });
        return { kind: "resumed" as const, stage, logSaved: log.logSaved };
      }
      if (stage.status !== "PENDING") {
        return { kind: "conflict" as const, stageStatus: stage.status };
      }

      const updated = await client.query<{
        id: string;
        sessionId: string;
        stageType: string;
        status: string;
        startedAt: Date;
        completedAt: Date | null;
      }>(
        `
          UPDATE session_stages
          SET status = 'IN_PROGRESS', started_at = now()
          WHERE id = $1::uuid AND status = 'PENDING'
          RETURNING id, session_id AS "sessionId", stage_type AS "stageType",
            status, started_at AS "startedAt", completed_at AS "completedAt"
        `,
        [stageId],
      );
      const result = updated.rows[0];
      if (!result) throw new Error("SessionStage start returned no row");
      const log = await insertResearchEventBestEffort(client, result.sessionId, principalOf(response).role === "learner" ? "LEARNER" : "RESEARCHER", {
        eventType: "STAGE_START", targetType: "STAGE", stageId, outcome: "SUCCESS", clientTimeQuality: "NOT_APPLICABLE",
      });
      return { kind: "started" as const, stage: result, logSaved: log.logSaved };
    });

    if (outcome.kind === "started" || outcome.kind === "resumed") {
      return response.json({ ...outcome.stage, logSaved: outcome.logSaved });
    }
    if (outcome.kind === "time_expired") return response.status(409).json({ error: "time_expired", message: "活動時間が終了しました。Session画面から次の操作を行ってください。" });
    if (outcome.kind === "not_found") {
      return response.status(404).json({
        error: "session_stage_not_found",
        message: "SessionStageが見つかりません。",
      });
    }
    if (outcome.kind === "session_not_in_progress") {
      return response.status(409).json({
        error: "session_not_in_progress",
        message: "Sessionを開始してからStageを開始してください。",
        status: outcome.sessionStatus,
      });
    }
    if (outcome.kind === "flow_conflict") {
      return currentStageConflictResponse(response, outcome.flow);
    }
    return response.status(409).json({
      error: "session_stage_cannot_start",
      message: "PENDINGのStageだけ開始できます。",
      status: outcome.stageStatus,
    });
  } catch (error) {
    console.error("Failed to start SessionStage", safeServerErrorCode(error));
    return response.status(500).json({
      error: "session_stage_start_failed",
      message: "SessionStageを開始できませんでした。",
    });
  }
});

app.post("/api/session-stages/:stageId/submit-expired-integration", (_request, response) => {
  return response.status(409).json({ error: "automatic_submission_required", message: "統合マップは活動時間の終了時に自動で提出されます。" });
});

app.post("/api/session-stages/:stageId/complete", async (request, response) => {
  const { stageId } = request.params;
  if (!uuidPattern.test(stageId)) {
    return response.status(400).json({
      error: "invalid_session_stage_id",
      message: "SessionStage IDの形式が正しくありません。",
    });
  }
  if (hasUnexpectedEmptyBody(request.body)) {
    return response.status(400).json({
      error: "invalid_session_stage_complete_request",
      message:
        "completedAtはサーバー側で設定されるため、request bodyは省略するか空にしてください。",
    });
  }

  try {
    const outcome = await withTransaction(async (client) => {
      const stage = await lockSessionStageProgress(client, stageId);
      if (!stage) return { kind: "not_found" as const };
      const flow = await assertStageIsCurrent(client, stage);
      if (flow.kind !== "ready") {
        return { kind: "flow_conflict" as const, flow };
      }
      if (stage.stageType === "PRE_ASSESSMENT" || stage.stageType === "POST_ASSESSMENT") return { kind: "assessment_requires_submission" as const };
      const timed = await client.query<{ protocol: string; studyGroup: string; elapsed: boolean; submitted: boolean }>(
        `SELECT s.protocol_key AS protocol, s.study_group AS "studyGroup",
          clock_timestamp() >= st.started_at + s.group_activity_seconds * interval '1 second' AS elapsed,
          EXISTS (SELECT 1 FROM maps m WHERE m.session_stage_id=st.id AND m.type='INTEGRATION' AND m.status='SUBMITTED') AS submitted
         FROM session_stages st JOIN sessions s ON s.id=st.session_id WHERE st.id=$1::uuid`, [stageId]);
      const conditions = timed.rows[0];
      const isTimed = conditions?.protocol === "STAGE1_6" && (stage.stageType === "SELF_STUDY" || stage.stageType === "INTEGRATION_MAP");
      if (isTimed && (stage.stageType === "SELF_STUDY" ? conditions.studyGroup !== "CONTROL" : conditions.studyGroup !== "EXPERIMENTAL")) return { kind: "group_mismatch" as const };
      if (isTimed && (!conditions.elapsed || (stage.stageType === "INTEGRATION_MAP" && !conditions.submitted))) return { kind: "timed_incomplete" as const };
      if (
        stage.stageType === "PRIOR_MAP" ||
        stage.stageType === "KB_MAP" ||
        (stage.stageType === "INTEGRATION_MAP" && !isTimed)
      ) {
        return { kind: "map_stage" as const };
      }
      if (stage.status !== "IN_PROGRESS") {
        return { kind: "conflict" as const, stageStatus: stage.status };
      }

      const updated = await client.query<{
        id: string;
        sessionId: string;
        stageType: string;
        status: string;
        startedAt: Date;
        completedAt: Date;
      }>(
        `
            UPDATE session_stages
            SET status = 'COMPLETED', completed_at = now()
            WHERE id = $1::uuid AND status = 'IN_PROGRESS'
            RETURNING id, session_id AS "sessionId", stage_type AS "stageType",
              status, started_at AS "startedAt", completed_at AS "completedAt"
          `,
        [stageId],
      );
      const result = updated.rows[0];
      if (!result) throw new Error("SessionStage complete returned no row");
      const log = await insertResearchEventBestEffort(client, result.sessionId, principalOf(response).role === "learner" ? "LEARNER" : "RESEARCHER", {
        eventType: "STAGE_COMPLETE", targetType: "STAGE", stageId, outcome: "SUCCESS", clientTimeQuality: "NOT_APPLICABLE",
      });
      return { kind: "completed" as const, stage: result, logSaved: log.logSaved };
    });

    if (outcome.kind === "completed") return response.json({ ...outcome.stage, logSaved: outcome.logSaved });
    if (outcome.kind === "not_found") {
      return response.status(404).json({
        error: "session_stage_not_found",
        message: "SessionStageが見つかりません。",
      });
    }
    if (outcome.kind === "flow_conflict") {
      return currentStageConflictResponse(response, outcome.flow);
    }
    if (outcome.kind === "assessment_requires_submission") return response.status(409).json({ error: "assessment_requires_submission", message: "評価の回答を提出してください。" });
    if (outcome.kind === "group_mismatch") return response.status(409).json({ error: "group_mismatch", message: "この群の活動ではありません。" });
    if (outcome.kind === "timed_incomplete") return response.status(409).json({ error: "timed_incomplete", message: "時間の終了と必要なMapの提出を確認してください。" });
    if (outcome.kind === "map_stage") {
      return response.status(409).json({
        error: "map_stage_completion_requires_submit",
        message: "Map Stageは対応するMapの提出によって完了します。",
      });
    }
    return response.status(409).json({
      error: "session_stage_cannot_complete",
      message: "IN_PROGRESSのStageだけ完了できます。",
      status: outcome.stageStatus,
    });
  } catch (error) {
    console.error("Failed to complete SessionStage", safeServerErrorCode(error));
    return response.status(500).json({
      error: "session_stage_complete_failed",
      message: "SessionStageを完了できませんでした。",
    });
  }
});

app.post(
  "/api/session-stages/:stageId/prior-map",
  async (request, response) => {
    const { stageId } = request.params;
    if (!uuidPattern.test(stageId)) {
      return response.status(400).json({
        error: "invalid_session_stage_id",
        message: "SessionStage IDの形式が正しくありません。",
      });
    }

    try {
      const outcome = await withTransaction<PriorMapCreateOutcome>(
        async (client) => {
          const validation = await lockSessionStageForMap(
            client,
            stageId,
            "PRIOR",
          );
          if (validation.kind !== "ready") return validation;

          const result = await client.query<PriorMapRow>(
            `
          INSERT INTO maps (type, status, session_stage_id)
          VALUES ('PRIOR', 'DRAFT', $1::uuid)
          RETURNING
            id,
            type,
            status,
            based_on_map_id AS "basedOnMapId",
            session_stage_id AS "sessionStageId",
            submitted_at AS "submittedAt"
        `,
            [stageId],
          );
          const map = result.rows[0];
          if (!map) throw new Error("Prior Map insert returned no row");
          // The post-lesson Scratch-Build map starts with a single anchor.
          // System initialization does not create a learner ADD_CONCEPT log.
          await client.query(
            `INSERT INTO concepts (map_id, label, position_x, position_y)
             VALUES ($1::uuid, '注意', 320, 240)`,
            [map.id],
          );
          await createMapInitialSnapshot(client, map.id);
          return { kind: "created", map };
        },
      );

      if (outcome.kind === "created")
        return response.status(201).json(outcome.map);
      return sessionStageMapResponse(response, outcome);
    } catch (error) {
      if (isPostgresErrorCode(error, "23505")) {
        return sessionStageMapResponse(response, {
          kind: "session_stage_already_assigned",
        });
      }
      console.error("Failed to create Prior Map for SessionStage", safeServerErrorCode(error));
      return response.status(500).json({
        error: "prior_map_create_failed",
        message: "Prior Mapを作成できませんでした。",
      });
    }
  },
);

app.get("/api/maps/:mapId/kit-graph-signature", async (request, response) => {
  const { mapId } = request.params;
  if (!uuidPattern.test(mapId)) return response.status(404).json({ error: "map_not_found" });
  try {
    const signature = await withTransaction(async (client) => {
      const map = await client.query(
        `SELECT id FROM maps WHERE id = $1::uuid AND type = 'KB' FOR SHARE`,
        [mapId],
      );
      return map.rowCount ? readKitBuildMapSignature(client, mapId) : null;
    });
    return signature === null
      ? response.status(404).json({ error: "map_not_found" })
      : response.json({ mapSignature: signature });
  } catch (error) {
    console.error("Failed to read Kit-Build graph signature", safeServerErrorCode(error));
    return response.status(500).json({ error: "kit_graph_signature_failed" });
  }
});

app.get("/api/maps/:mapId/kit-feedback", async (request, response) => {
  const { mapId } = request.params;
  if (!uuidPattern.test(mapId)) {
    return response.status(400).json({ error: "invalid_map_id" });
  }

  let safeContext: {sessionId:string;stageId:string}|null=null;
  try {
    const principal = principalOf(response);
    const feedback = await withTransaction(async (client) => {
      const map = await client.query<{ id: string; kitDefinitionId: string | null; stageId: string | null; sessionId: string | null; stageType: string | null; stageStatus: string | null; sessionStatus: string | null; protocolKey: string | null; currentStageId: string | null }>(
        `SELECT m.id, m.kit_definition_id AS "kitDefinitionId", st.id AS "stageId", st.session_id AS "sessionId",
           st.stage_type AS "stageType", st.status AS "stageStatus", s.status AS "sessionStatus",
           s.protocol_key AS "protocolKey", current_stage.id AS "currentStageId"
         FROM maps m LEFT JOIN session_stages st ON st.id=m.session_stage_id
         LEFT JOIN sessions s ON s.id=st.session_id
         LEFT JOIN LATERAL (
           SELECT id FROM session_stages WHERE session_id=st.session_id AND status <> 'COMPLETED' ORDER BY order_index LIMIT 1
         ) current_stage ON true
         WHERE m.id = $1::uuid AND m.type = 'KB' FOR SHARE OF m`,
        [mapId],
      );
      const owner = map.rows[0];
      if (!owner) return { kind: "not_found" as const };
      if (principal.role === "learner" &&
          (owner.sessionId !== principal.sessionId || owner.protocolKey === null || owner.stageType !== "KB_MAP" ||
           owner.sessionStatus !== "IN_PROGRESS" || owner.stageStatus !== "IN_PROGRESS" || owner.currentStageId !== owner.stageId)) {
        return { kind: "not_found" as const };
      }
      if(principal.role === "learner" && owner.sessionId && owner.stageId) safeContext={sessionId:owner.sessionId,stageId:owner.stageId};
      if (!owner.kitDefinitionId) {
        const log=safeContext?await insertResearchEventBestEffort(client,safeContext.sessionId,"LEARNER",{schemaVersion:6,eventType:"FEEDBACK_CHECK",targetType:"FEEDBACK",targetId:mapId,mapId,stageId:safeContext.stageId,outcome:"REJECTED",reasonCode:"VALIDATION",clientTimeQuality:"NOT_APPLICABLE",beforeQuality:"NOT_APPLICABLE",afterQuality:"NOT_APPLICABLE"}):{logSaved:false};
        return {kind:"kit_required" as const,logSaved:log.logSaved};
      }
      const result = await readKitBuildFeedbackWithSignature(client, mapId);
      if (!result) return { kind: "not_found" as const };
      let activityLogSaved: boolean | null = null;
      if (principal.role === "learner" && owner.sessionId && owner.stageId && owner.protocolKey &&
          ["STAGE1_4", "STAGE1_6"].includes(owner.protocolKey)) {
        const log = await insertResearchEventBestEffort(client, owner.sessionId, "LEARNER", {
          schemaVersion:6,eventType: "FEEDBACK_CHECK", targetType: "FEEDBACK", targetId:mapId,stageId: owner.stageId, mapId,
          outcome: "SUCCESS", details:{matched:result.matched},clientTimeQuality: "NOT_APPLICABLE",beforeQuality:"NOT_APPLICABLE",afterQuality:"NOT_APPLICABLE",
        });
        activityLogSaved = log.logSaved;
      }
      return { kind: "feedback" as const, feedback: result, activityLogSaved };
    });

    if (feedback.kind === "not_found") {
      return response.status(404).json({ error: "map_not_found" });
    }
    if (feedback.kind === "kit_required") {
      return response.status(409).json({ error: "kit_definition_required",logSaved:feedback.logSaved,operationOutcome:"REJECTED" });
    }
    return response.json({ ...feedback.feedback, logSaved: feedback.activityLogSaved });
  } catch (error) {
    let logSaved=false;
    const context=safeContext as {sessionId:string;stageId:string}|null;
    if(context)try{const result=await withTransaction(client=>insertResearchEventBestEffort(client,context.sessionId,"LEARNER",{schemaVersion:6,eventType:"FEEDBACK_CHECK",targetType:"FEEDBACK",targetId:mapId,mapId,stageId:context.stageId,outcome:"FAILURE",reasonCode:"SERVER",clientTimeQuality:"NOT_APPLICABLE",beforeQuality:"NOT_APPLICABLE",afterQuality:"NOT_APPLICABLE"}));logSaved=result.logSaved;}catch{/* State is unchanged; recording failure is separate. */}
    console.error("Failed to check Kit-Build feedback", safeServerErrorCode(error));
    return response.status(500).json({ error: "kit_feedback_failed",operationOutcome:"FAILURE",logSaved });
  }
});

app.post("/api/maps/:mapId/kit-feedback/display", async (request, response) => {
  const { mapId } = request.params;
  const principal = principalOf(response);
  if (!uuidPattern.test(mapId) || principal.role !== "learner") return response.status(404).json({ error: "not_found" });
  if (hasUnexpectedEmptyBody(request.body)) return response.status(400).json({ error: "invalid_feedback_display_request" });
  try {
    const outcome = await withTransaction(async (client) => {
      const owner = await client.query<{ sessionId: string; stageId: string; stageType: string; stageStatus: string; sessionStatus: string; protocolKey: string; currentStageId: string | null; mapStatus: string }>(
        `SELECT st.session_id AS "sessionId", st.id AS "stageId", st.stage_type AS "stageType",
           st.status AS "stageStatus", s.status AS "sessionStatus", s.protocol_key AS "protocolKey",
           current_stage.id AS "currentStageId", m.status AS "mapStatus"
         FROM maps m JOIN session_stages st ON st.id=m.session_stage_id
         JOIN sessions s ON s.id=st.session_id
         LEFT JOIN LATERAL (
           SELECT id FROM session_stages WHERE session_id=s.id AND status <> 'COMPLETED' ORDER BY order_index LIMIT 1
         ) current_stage ON true
         WHERE m.id=$1::uuid AND m.type='KB' AND s.id=$2::uuid FOR SHARE OF m`,
        [mapId, principal.sessionId],
      );
      const item = owner.rows[0];
      if (!item || !["STAGE1_4", "STAGE1_6"].includes(item.protocolKey) || item.stageType !== "KB_MAP" ||
          item.mapStatus !== "DRAFT" || item.sessionStatus !== "IN_PROGRESS" || item.stageStatus !== "IN_PROGRESS" || item.currentStageId !== item.stageId) {
        return { allowed: false as const };
      }
      const log = await insertResearchEventBestEffort(client, item.sessionId, "LEARNER", {
        eventType: "FEEDBACK_DISPLAY", targetType: "FEEDBACK", stageId: item.stageId, mapId,
        outcome: "SUCCESS", clientTimeQuality: "MISSING",
      });
      return { allowed: true as const, logSaved: log.logSaved };
    });
    return outcome.allowed
      ? response.json({ displayed: true, logSaved: outcome.logSaved })
      : response.status(404).json({ error: "not_found" });
  } catch {
    return response.status(500).json({ error: "feedback_display_record_failed", logSaved: false });
  }
});

app.post("/api/maps/:mapId/submit", async (request, response) => {
  const { mapId } = request.params;

  if (!uuidPattern.test(mapId)) {
    return response.status(400).json({
      error: "invalid_map_id",
      message: "Map IDの形式が正しくありません。",
    });
  }

  try {
    const outcome = await withTransaction<MapSubmitOutcome>(async (client) => {
      const map = await lockMapById(client, mapId);
      if (!map) return { kind: "map_not_found" };

      if (
        map.mapType !== "PRIOR" &&
        map.mapType !== "KB" &&
        map.mapType !== "INTEGRATION"
      ) {
        return { kind: "map_type_not_supported", mapType: map.mapType };
      }

      if (map.mapStatus === "SUBMITTED") {
        return {
          kind: "map_already_submitted",
          mapType: map.mapType,
          submittedAt: map.submittedAt,
        };
      }

      if (map.mapType === "KB") {
        const feedback = await readKitBuildFeedbackWithSignature(client, mapId);
        if (!feedback) throw new Error("Kit-Build feedback returned no Map");
        if (!feedback.matched) return {kind:"kit_build_not_matched",feedback,logSaved:null};
      }

      if (map.sessionStageId !== null) {
        const stage = await lockSessionStageProgress(
          client,
          map.sessionStageId,
        );
        if (!stage) return { kind: "session_stage_not_found" };

        const flow = await assertStageIsCurrent(client, stage);
        if (flow.kind === "session_not_in_progress") {
          return {
            kind: "session_not_in_progress",
            sessionStatus: flow.sessionStatus,
          };
        }
        if (flow.kind === "stage_not_current") {
          return {
            kind: "session_stage_not_current",
            currentStageId: flow.currentStageId,
          };
        }

        const expectedStageType = SESSION_STAGE_TYPES_BY_MAP_TYPE[map.mapType];
        if (stage.stageType !== expectedStageType) {
          return {
            kind: "session_stage_type_mismatch",
            expectedStageType,
            actualStageType: stage.stageType,
          };
        }
        if (stage.sessionStatus !== "IN_PROGRESS") {
          return {
            kind: "session_not_in_progress",
            sessionStatus: stage.sessionStatus,
          };
        }
        if (stage.status !== "IN_PROGRESS") {
          return {
            kind: "session_stage_not_in_progress",
            stageStatus: stage.status,
          };
        }
        if (map.mapType === "INTEGRATION") {
          const automatic = await client.query(`SELECT 1 FROM session_stages st JOIN sessions s ON s.id=st.session_id WHERE st.id=$1::uuid AND s.protocol_key='STAGE1_6' AND s.study_group='EXPERIMENTAL'`, [stage.id]);
          if (automatic.rowCount) return { kind: "automatic_submission_required" };
        }
      }

      const result = await client.query<SubmittedMapRow>(
        `
          UPDATE maps
          SET status = 'SUBMITTED', submitted_at = now()
          WHERE id = $1::uuid AND type = $2 AND status = 'DRAFT'
          RETURNING
            id,
            type,
            status,
            submitted_at AS "submittedAt"
        `,
        [mapId, map.mapType],
      );
      const submittedMap = result.rows[0];
      if (!submittedMap) throw new Error("Map submission returned no row");
      const hasEvents = (await client.query<{ name: string | null }>("SELECT to_regclass('map_history_boundaries')::text AS name")).rows[0]?.name;
      if (await isStage1LearnerMap(client, mapId)) {
        if (!hasEvents) throw new HistoryTransitionError("操作履歴のDB変更が未適用です。研究者に連絡してください。");
        await appendMapOperationLog(client, { mapId, operationType: "MAP_SUBMIT", targetType: "MAP", targetId: mapId, before: null, after: null, clientTimestamp: null });
      }

      let activityLogSaved: boolean | null = null;
      const transitionContext = map.sessionStageId === null ? null : await client.query<{ sessionId: string; stageType: string; protocolKey: string }>(
        `SELECT st.session_id AS "sessionId", st.stage_type AS "stageType", s.protocol_key AS "protocolKey"
         FROM session_stages st JOIN sessions s ON s.id=st.session_id WHERE st.id=$1::uuid`,
        [map.sessionStageId],
      );
      const transitionOwner = transitionContext?.rows[0] ?? null;
      const sixIntegration = map.mapType === "INTEGRATION" && transitionOwner?.protocolKey === "STAGE1_6";
      if (map.sessionStageId !== null && !sixIntegration) {
        const completedStage = await client.query(
          `
            UPDATE session_stages
            SET status = 'COMPLETED', completed_at = now()
            WHERE id = $1::uuid AND status = 'IN_PROGRESS'
            RETURNING id
          `,
          [map.sessionStageId],
        );
        if (completedStage.rowCount !== 1 || !transitionOwner) {
          throw new Error("SessionStage completion returned no row");
        }
        const stageLog = await insertResearchEventBestEffort(client, transitionOwner.sessionId, principalOf(response).role === "learner" ? "LEARNER" : "RESEARCHER", {
          eventType: "STAGE_COMPLETE", targetType: "STAGE", stageId: map.sessionStageId, outcome: "SUCCESS", clientTimeQuality: "NOT_APPLICABLE",
        });
        activityLogSaved = stageLog.logSaved;
        // Integration submit is the last learner activity in Stage 1.
        // Complete Session in the very same transaction as Map/Stage submit.
        if (map.mapType === "INTEGRATION") {
          const protocol = await client.query<{
            sessionId: string;
            protocolKey: string;
          }>(
            `SELECT session.id AS "sessionId", session.protocol_key AS "protocolKey"
             FROM session_stages AS stage
             JOIN sessions AS session ON session.id = stage.session_id
             WHERE stage.id = $1::uuid`,
            [map.sessionStageId],
          );
          const owner = protocol.rows[0];
          if (owner?.protocolKey === STAGE1_PROTOCOL_KEY) {
            const completed = await client.query(
              `UPDATE sessions SET status = 'COMPLETED', completed_at = now()
               WHERE id = $1::uuid AND status = 'IN_PROGRESS'
                 AND NOT EXISTS (
                   SELECT 1 FROM session_stages
                   WHERE session_id = $1::uuid AND status <> 'COMPLETED'
                 )
               RETURNING id`,
              [owner.sessionId],
            );
            if (completed.rowCount !== 1) {
              throw new Error("Stage1 Session completion returned no row");
            }
            const sessionLog = await insertResearchEventBestEffort(client, owner.sessionId, principalOf(response).role === "learner" ? "LEARNER" : "RESEARCHER", {
              eventType: "SESSION_COMPLETE", targetType: "SESSION", outcome: "SUCCESS", clientTimeQuality: "NOT_APPLICABLE",
            });
            activityLogSaved = activityLogSaved && sessionLog.logSaved;
          }
        }
      }

      return { kind: "submitted", map: submittedMap, activityLogSaved };
    });

    if (outcome.kind === "automatic_submission_required") return response.status(409).json({ error: "automatic_submission_required", message: "統合マップは活動時間の終了時に自動で提出されます。" });
    if (outcome.kind === "time_expired") return response.status(409).json({ error: "time_expired", message: "活動時間が終了しました。セッション画面に戻ってください。" });
    if (outcome.kind === "submitted") {
      return response.json({ ...outcome.map, activityLogSaved: outcome.activityLogSaved });
    }

    if (outcome.kind === "map_not_found") {
      return response.status(404).json({
        error: "map_not_found",
        message: "Mapが見つかりません。",
      });
    }

    if (outcome.kind === "map_type_not_supported") {
      return response.status(422).json({
        error: "map_type_not_supported",
        message:
          "このAPIで提出できるのはStage 1のPrior Map、KB Map、Integration Mapです。",
        type: outcome.mapType,
      });
    }
    if (outcome.kind === "kit_build_not_matched") {
      return response.status(409).json({
        error: "kit_build_not_matched",
        message:
          "Kit-Buildがゴールマップと一致するまで提出できません。一致状況を確認し、概念の配置と関係の接続を見直してください。",
        feedback: outcome.feedback,
        logSaved: outcome.logSaved,
      });
    }

    if (outcome.kind === "session_stage_not_found") {
      return response.status(409).json({
        error: "map_session_stage_not_found",
        message: "Mapに紐付いたSessionStageが見つかりません。",
      });
    }

    if (outcome.kind === "session_stage_type_mismatch") {
      return response.status(409).json({
        error: "map_session_stage_type_mismatch",
        message: "Map typeとSessionStage typeの対応が一致しません。",
        expectedStageType: outcome.expectedStageType,
        actualStageType: outcome.actualStageType,
      });
    }

    if (outcome.kind === "session_not_in_progress") {
      return response.status(409).json({
        error: "session_not_in_progress",
        message: "Mapを提出するにはSessionがIN_PROGRESSである必要があります。",
        status: outcome.sessionStatus,
      });
    }

    if (outcome.kind === "session_stage_not_in_progress") {
      return response.status(409).json({
        error: "session_stage_not_in_progress",
        message:
          "Mapを提出するには対応StageがIN_PROGRESSである必要があります。",
        status: outcome.stageStatus,
      });
    }

    if (outcome.kind === "session_stage_not_current") {
      return response.status(409).json({
        error: "session_stage_not_current",
        message: "現在のStageではないためMapを提出できません。",
        currentStageId: outcome.currentStageId,
      });
    }

    const mapLabel =
      outcome.mapType === "KB"
          ? "KB Map"
          : outcome.mapType === "INTEGRATION"
            ? "Integration Map"
            : "Prior Map";
    return response.status(409).json({
      error: "map_already_submitted",
      message: `${mapLabel}は既に提出済みです。`,
      type: outcome.mapType,
      submittedAt: outcome.submittedAt,
    });
  } catch (error) {
    if (error instanceof SessionFlowGuardError) return response.status(409).json({ error: "time_expired", message: "活動時間が終了しました。Session画面から提出してください。" });
    const policyResponse = readOnlyMapResponse(response, error);
    if (policyResponse) return policyResponse;
    console.error("Failed to submit Map", safeServerErrorCode(error));
    return response.status(500).json({
      error: "map_submit_failed",
      message: "Mapを提出できませんでした。",
    });
  }
});

app.post(["/api/maps/:priorMapId/integration", "/api/session-stages/:stageId/integration-map"], async (request, response) => {
  let priorMapId = typeof request.params.priorMapId === "string" ? request.params.priorMapId : null;
  const stageId = typeof request.params.stageId === "string" ? request.params.stageId : null;
  let sessionStageId: string | null = null;
  let sourceKitId: string | null = null;

  if (stageId) {
    if (!uuidPattern.test(stageId) || hasUnexpectedEmptyBody(request.body)) {
      return response.status(404).json({ error: "not_found" });
    }
    try {
      const sources = await pool.query<{ priorId: string; kitId: string }>(
        `SELECT prior.id AS "priorId", kb.kit_definition_id AS "kitId"
         FROM session_stages target
         JOIN sessions s ON s.id = target.session_id
         JOIN session_stages prior_stage ON prior_stage.session_id = s.id AND prior_stage.stage_type = 'PRIOR_MAP' AND prior_stage.status = 'COMPLETED'
         JOIN maps prior ON prior.session_stage_id = prior_stage.id AND prior.type = 'PRIOR' AND prior.status = 'SUBMITTED'
         JOIN session_stages kb_stage ON kb_stage.session_id = s.id AND kb_stage.stage_type = 'KB_MAP' AND kb_stage.status = 'COMPLETED'
         JOIN maps kb ON kb.session_stage_id = kb_stage.id AND kb.type = 'KB' AND kb.status = 'SUBMITTED' AND kb.kit_definition_id IS NOT NULL
         WHERE target.id = $1::uuid AND target.stage_type = 'INTEGRATION_MAP'
           AND target.status = 'IN_PROGRESS' AND s.status = 'IN_PROGRESS'
           AND (s.protocol_key = 'STAGE1_4' OR (s.protocol_key = 'STAGE1_6' AND s.study_group = 'EXPERIMENTAL'))
           AND target.id = (SELECT id FROM session_stages WHERE session_id = s.id AND status <> 'COMPLETED' ORDER BY order_index LIMIT 1)`,
        [stageId],
      );
      const source = sources.rows[0];
      if (!source) return response.status(404).json({ error: "not_found" });
      priorMapId = source.priorId;
      sourceKitId = source.kitId;
      sessionStageId = stageId;
    } catch (error) {
      console.error("Failed to resolve Integration sources", safeServerErrorCode(error));
      return response.status(500).json({ error: "integration_initialization_failed" });
    }
  }

  if (!priorMapId || !uuidPattern.test(priorMapId)) {
    return response.status(400).json({
      error: "invalid_map_id",
      message: "Map IDの形式が正しくありません。",
    });
  }

  const resolvedPriorMapId = priorMapId;
  if (!stageId && request.body !== undefined) {
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return response.status(400).json({
        error: "invalid_request",
        message: "JSON bodyにはsessionStageIdだけを指定してください。",
      });
    }
    const payload = body as Record<string, unknown>;
    if (Object.keys(payload).some((key) => key !== "sessionStageId")) {
      return response.status(400).json({
        error: "invalid_request",
        message: "JSON bodyにはsessionStageIdだけを指定してください。",
      });
    }
    if (payload.sessionStageId !== undefined) {
      if (
        typeof payload.sessionStageId !== "string" ||
        !uuidPattern.test(payload.sessionStageId)
      ) {
        return response.status(400).json({
          error: "invalid_session_stage_id",
          message: "sessionStageIdには有効なUUIDを指定してください。",
        });
      }
      sessionStageId = payload.sessionStageId;
    }
  }

  try {
    const outcome = await withTransaction<IntegrationCreateOutcome>(
      async (client) => {
        const priorMap = await lockMapById(client, resolvedPriorMapId);
        if (!priorMap) return { kind: "map_not_found" };

        if (priorMap.mapType !== "PRIOR") {
          return {
            kind: "map_type_not_supported",
            mapType: priorMap.mapType,
          };
        }

        let integrationStageSessionId: string | null = null;
        let assignedIntegrationMapId: string | null = null;
        if (sessionStageId !== null) {
          const validation = await lockSessionStageForMap(
            client,
            sessionStageId,
            "INTEGRATION",
          );
          if (validation.kind === "not_found") {
            return { kind: "session_stage_not_found" };
          }
          if (validation.kind === "type_mismatch") {
            return {
              kind: "session_stage_type_mismatch",
              stageType: validation.stageType,
            };
          }
          if (
            validation.kind === "ready" ||
            validation.kind === "already_assigned"
          ) {
            integrationStageSessionId = validation.stage.sessionId;
            {
              const expired = await client.query(`SELECT 1 FROM session_stages st JOIN sessions s ON s.id=st.session_id WHERE st.id=$1::uuid AND s.protocol_key='STAGE1_6' AND clock_timestamp() >= st.started_at + s.group_activity_seconds * interval '1 second'`, [sessionStageId]);
              if (expired.rowCount) return { kind: "time_expired" };
              deadlineContext.getStore()?.stageIds.add(sessionStageId);
            }
          }
          if (validation.kind === "already_assigned") {
            assignedIntegrationMapId = validation.stage.mapId;
          }
          if (validation.kind === "session_not_in_progress") {
            return {
              kind: "session_not_in_progress",
              sessionStatus: validation.sessionStatus,
            };
          }
          if (validation.kind === "stage_not_current") {
            return {
              kind: "session_stage_not_current",
              currentStageId: validation.currentStageId,
            };
          }
          if (validation.kind === "stage_not_in_progress") {
            return {
              kind: "session_stage_not_in_progress",
              status: validation.status,
            };
          }
        }

        const priorStageResult = await client.query<{
          stageId: string | null;
          sessionId: string | null;
          stageType: string | null;
        }>(
          `
            SELECT
              stage.id AS "stageId",
              stage.session_id AS "sessionId",
              stage.stage_type AS "stageType"
            FROM maps AS prior
            LEFT JOIN session_stages AS stage
              ON stage.id = prior.session_stage_id
            WHERE prior.id = $1::uuid
          `,
          [resolvedPriorMapId],
        );
        const priorStage = priorStageResult.rows[0];
        if (!priorStage) return { kind: "map_not_found" };

        if (priorStage.stageId !== null) {
          if (priorStage.stageType !== "PRIOR_MAP") {
            return { kind: "prior_session_stage_invalid" };
          }
          if (sessionStageId === null) {
            return { kind: "integration_stage_required" };
          }
          if (priorStage.sessionId !== integrationStageSessionId) {
            return { kind: "session_mismatch" };
          }
        } else if (sessionStageId !== null) {
          return { kind: "prior_session_stage_required" };
        }

        if (priorMap.mapStatus !== "SUBMITTED") {
          return { kind: "prior_map_not_submitted" };
        }

        if (assignedIntegrationMapId !== null) {
          const assignedMap = await client.query<IntegrationMapRow>(
            `
              SELECT
                id,
                type,
                status,
                based_on_map_id AS "basedOnMapId",
                session_stage_id AS "sessionStageId",
                submitted_at AS "submittedAt"
              FROM maps
              WHERE id = $1::uuid
                AND type = 'INTEGRATION'
                AND based_on_map_id = $2::uuid
            `,
            [assignedIntegrationMapId, resolvedPriorMapId],
          );
          const existingMap = assignedMap.rows[0];
          if (existingMap) return { kind: "existing", map: existingMap };
          return { kind: "session_stage_already_assigned" };
        }

        if (sessionStageId === null) {
          const existingResult = await client.query<IntegrationMapRow>(
            `
              SELECT
                id,
                type,
                status,
                based_on_map_id AS "basedOnMapId",
                session_stage_id AS "sessionStageId",
                submitted_at AS "submittedAt"
              FROM maps
              WHERE type = 'INTEGRATION' AND based_on_map_id = $1::uuid
              ORDER BY created_at, id
              LIMIT 1
            `,
            [resolvedPriorMapId],
          );
          const existingMap = existingResult.rows[0];
          if (existingMap) {
            if (existingMap.sessionStageId !== null) {
              return { kind: "existing_integration_conflict" };
            }
            return { kind: "existing", map: existingMap };
          }
        }

        const conceptsResult = await client.query<PriorConceptToClone>(
          `
            SELECT
              id,
              label,
              position_x AS "positionX",
              position_y AS "positionY"
            FROM concepts
            WHERE map_id = $1::uuid
            ORDER BY created_at, id
          `,
          [resolvedPriorMapId],
        );
        const linksResult = await client.query<PriorLinkToClone>(
          `
            SELECT
              id,
              source_concept_id AS "sourceConceptId",
              target_concept_id AS "targetConceptId",
              label
            FROM links
            WHERE map_id = $1::uuid
            ORDER BY created_at, id
          `,
          [resolvedPriorMapId],
        );
        const priorConcepts = conceptsResult.rows;
        const priorLinks = linksResult.rows;
        const priorConceptIds = new Set(priorConcepts.map(({ id }) => id));

        if (
          priorLinks.some(
            (link) =>
              !priorConceptIds.has(link.sourceConceptId) ||
              !priorConceptIds.has(link.targetConceptId),
          )
        ) {
          return { kind: "invalid_prior_graph" };
        }

        const mapResult = await client.query<IntegrationMapRow>(
          `
            INSERT INTO maps (type, status, based_on_map_id, session_stage_id)
            VALUES ('INTEGRATION', 'DRAFT', $1::uuid, $2::uuid)
            RETURNING
              id,
              type,
              status,
              based_on_map_id AS "basedOnMapId",
              session_stage_id AS "sessionStageId",
              submitted_at AS "submittedAt"
          `,
          [resolvedPriorMapId, sessionStageId],
        );
        const integrationMap = mapResult.rows[0];
        if (!integrationMap) {
          throw new Error("Integration Map insert returned no row");
        }

        const conceptIdMap = new Map<string, string>();

        for (const priorConcept of priorConcepts) {
          const cloneResult = await client.query<{ id: string }>(
            `
              INSERT INTO concepts (map_id, label, position_x, position_y)
              VALUES ($1::uuid, $2, $3, $4)
              RETURNING id
            `,
            [
              integrationMap.id,
              priorConcept.label,
              priorConcept.positionX,
              priorConcept.positionY,
            ],
          );
          const clonedConcept = cloneResult.rows[0];
          if (!clonedConcept) {
            throw new Error("Integration Concept insert returned no row");
          }

          conceptIdMap.set(priorConcept.id, clonedConcept.id);
          await client.query(
            `
              INSERT INTO concept_provenance (
                target_concept_id,
                source_concept_id,
                relation_type
              )
              VALUES ($1::uuid, $2::uuid, 'CLONED_FROM')
            `,
            [clonedConcept.id, priorConcept.id],
          );
        }

        for (const priorLink of priorLinks) {
          const sourceConceptId = conceptIdMap.get(priorLink.sourceConceptId);
          const targetConceptId = conceptIdMap.get(priorLink.targetConceptId);
          if (!sourceConceptId || !targetConceptId) {
            throw new Error("Prior Link endpoint mapping is missing");
          }

          const cloneResult = await client.query<{ id: string }>(
            `
              INSERT INTO links (
                map_id,
                source_concept_id,
                target_concept_id,
                label
              )
              VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
              RETURNING id
            `,
            [
              integrationMap.id,
              sourceConceptId,
              targetConceptId,
              priorLink.label,
            ],
          );
          const clonedLink = cloneResult.rows[0];
          if (!clonedLink) {
            throw new Error("Integration Link insert returned no row");
          }

          await client.query(
            `
              INSERT INTO link_provenance (
                target_link_id,
                source_link_id,
                relation_type
              )
              VALUES ($1::uuid, $2::uuid, 'CLONED_FROM')
            `,
            [clonedLink.id, priorLink.id],
          );
        }

        await createMapInitialSnapshot(client, integrationMap.id);

        return { kind: "created", map: integrationMap };
      },
    );

    if (outcome.kind === "time_expired") return response.status(409).json({ error: "time_expired", message: "活動時間が終了しました。Session画面に戻ってください。" });
    if (outcome.kind === "created" || outcome.kind === "existing") {
      if (principalOf(response).role === "learner" && outcome.map.status !== "DRAFT") {
        return response.status(404).json({ error: "not_found" });
      }
      const map = principalOf(response).role === "learner"
        ? { ...outcome.map, basedOnMapId: null }
        : outcome.map;
      return response.status(outcome.kind === "created" ? 201 : 200).json({
        ...map,
        created: outcome.kind === "created",
        ...(sourceKitId ? { kitDefinitionId: sourceKitId } : {}),
      });
    }

    if (outcome.kind === "map_not_found") {
      return response.status(404).json({
        error: "map_not_found",
        message: "Mapが見つかりません。",
      });
    }

    if (
      outcome.kind === "session_stage_not_found" ||
      outcome.kind === "session_stage_type_mismatch" ||
      outcome.kind === "session_stage_already_assigned" ||
      outcome.kind === "session_not_in_progress" ||
      outcome.kind === "session_stage_not_current" ||
      outcome.kind === "session_stage_not_in_progress"
    ) {
      if (
        outcome.kind === "session_stage_not_found" ||
        outcome.kind === "session_stage_type_mismatch" ||
        outcome.kind === "session_stage_already_assigned"
      ) {
        return sessionStageMapResponse(response, outcome);
      }
      if (outcome.kind === "session_not_in_progress") {
        return response.status(409).json({
          error: "session_not_in_progress",
          message: "Sessionを開始してからIntegration Mapを作成してください。",
          status: outcome.sessionStatus,
        });
      }
      if (outcome.kind === "session_stage_not_current") {
        return response.status(409).json({
          error: "session_stage_not_current",
          message: "現在のStageではIntegration Mapを作成できません。",
          currentStageId: outcome.currentStageId,
        });
      }
      return response.status(409).json({
        error: "session_stage_not_in_progress",
        message: "Integration Stageを開始してからMapを作成してください。",
        status: outcome.status,
      });
    }

    if (
      outcome.kind === "prior_session_stage_required" ||
      outcome.kind === "integration_stage_required" ||
      outcome.kind === "prior_session_stage_invalid" ||
      outcome.kind === "session_mismatch" ||
      outcome.kind === "existing_integration_conflict"
    ) {
      const messages = {
        prior_session_stage_required:
          "Sessionに紐付いたIntegrationにはSession内のPrior Mapが必要です。",
        integration_stage_required:
          "Sessionに紐付いたPrior MapにはIntegration用SessionStageを指定してください。",
        prior_session_stage_invalid:
          "初期化元Prior MapはPRIOR_MAP Stageに紐付いている必要があります。",
        session_mismatch:
          "Prior MapとIntegration Stageは同じSessionに属している必要があります。",
        existing_integration_conflict:
          "既存Integration MapのSessionStage relationと競合しています。",
      };
      return response.status(409).json({
        error: outcome.kind,
        message: messages[outcome.kind],
      });
    }

    if (outcome.kind === "map_type_not_supported") {
      return response.status(422).json({
        error: "map_type_not_supported",
        message: "Integration Mapの初期化元はPrior Mapに限られます。",
        type: outcome.mapType,
      });
    }

    if (outcome.kind === "prior_map_not_submitted") {
      return response.status(409).json({
        error: "prior_map_not_submitted",
        message: "提出済みのPrior Mapだけを初期化元にできます。",
      });
    }

    if (outcome.kind === "invalid_prior_graph") {
      return response.status(409).json({
        error: "invalid_prior_graph",
        message: "Prior MapのLinkが所属Map内のConceptを参照していません。",
      });
    }
    throw new Error("Unexpected Integration Map initialization outcome");
  } catch (error) {
    if (isPostgresErrorCode(error, "23505") && sessionStageId !== null) {
      return sessionStageMapResponse(response, {
        kind: "session_stage_already_assigned",
      });
    }
    if (error instanceof SessionFlowGuardError) return response.status(409).json({ error: "time_expired", message: "活動時間が終了しました。Session画面に戻ってください。" });
    console.error("Failed to initialize Integration Map", safeServerErrorCode(error));
    return response.status(500).json({
      error: "integration_initialization_failed",
      message: "Integration Mapを初期化できませんでした。",
    });
  }
});

app.post("/api/maps/:goalMapId/kits", async (request, response) => {
  const { goalMapId } = request.params;

  if (!uuidPattern.test(goalMapId)) {
    return response.status(400).json({
      error: "invalid_map_id",
      message: "Goal Map IDの形式が正しくありません。",
    });
  }

  const body: unknown = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return response.status(400).json({
      error: "invalid_request",
      message: "JSON bodyを指定してください。",
    });
  }

  const payload = body as Record<string, unknown>;
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const conceptIds = payload.conceptIds ?? [];
  const linkIds = payload.linkIds ?? [];

  if (!name) {
    return response.status(400).json({
      error: "invalid_kit_name",
      message: "Kit名を入力してください。",
    });
  }

  if (
    !Array.isArray(conceptIds) ||
    !conceptIds.every(
      (id): id is string => typeof id === "string" && uuidPattern.test(id),
    ) ||
    !Array.isArray(linkIds) ||
    !linkIds.every(
      (id): id is string => typeof id === "string" && uuidPattern.test(id),
    )
  ) {
    return response.status(400).json({
      error: "invalid_kit_item_ids",
      message: "conceptIdsとlinkIdsにはUUIDの配列を指定してください。",
    });
  }

  const selectedConceptIds = conceptIds as string[];
  const selectedLinkIds = linkIds as string[];
  if (
    new Set(selectedConceptIds).size !== selectedConceptIds.length ||
    new Set(selectedLinkIds).size !== selectedLinkIds.length
  ) {
    return response.status(400).json({
      error: "duplicate_kit_item_ids",
      message: "Kit内で同じConceptまたはLinkを重複指定できません。",
    });
  }

  try {
    type KitCreateOutcome =
      | {
          kind: "created";
          kit: KitDefinitionRow;
          conceptCount: number;
          linkCount: number;
        }
      | { kind: "map_not_found" }
      | { kind: "map_type_not_supported"; mapType: MapType }
      | { kind: "concept_map_mismatch" }
      | { kind: "link_map_mismatch" }
      | { kind: "link_concept_missing" };

    const outcome = await withTransaction<KitCreateOutcome>(async (client) => {
      const map = await lockMapById(client, goalMapId);
      if (!map) return { kind: "map_not_found" };
      if (map.mapType !== "GOAL") {
        return { kind: "map_type_not_supported", mapType: map.mapType };
      }

      const conceptsResult = await client.query<{ id: string }>(
        `
          SELECT id
          FROM concepts
          WHERE map_id = $1::uuid AND id = ANY($2::uuid[])
        `,
        [goalMapId, selectedConceptIds],
      );
      if (conceptsResult.rows.length !== selectedConceptIds.length) {
        return { kind: "concept_map_mismatch" };
      }

      const linksResult = await client.query<{
        id: string;
        sourceConceptId: string;
        targetConceptId: string;
      }>(
        `
          SELECT
            id,
            source_concept_id AS "sourceConceptId",
            target_concept_id AS "targetConceptId"
          FROM links
          WHERE map_id = $1::uuid AND id = ANY($2::uuid[])
        `,
        [goalMapId, selectedLinkIds],
      );
      if (linksResult.rows.length !== selectedLinkIds.length) {
        return { kind: "link_map_mismatch" };
      }

      const selectedConceptSet = new Set(selectedConceptIds);
      if (
        linksResult.rows.some(
          (link) =>
            !selectedConceptSet.has(link.sourceConceptId) ||
            !selectedConceptSet.has(link.targetConceptId),
        )
      ) {
        return { kind: "link_concept_missing" };
      }

      const kitResult = await client.query<KitDefinitionRow>(
        `
          INSERT INTO kit_definitions (goal_map_id, name)
          VALUES ($1::uuid, $2)
          RETURNING
            id,
            goal_map_id AS "goalMapId",
            name,
            created_at AS "createdAt"
        `,
        [goalMapId, name],
      );
      const kit = kitResult.rows[0];
      if (!kit) throw new Error("KitDefinition insert returned no row");

      for (const sourceConceptId of selectedConceptIds) {
        await client.query(
          `
            INSERT INTO kit_concept_items (kit_definition_id, source_concept_id)
            VALUES ($1::uuid, $2::uuid)
          `,
          [kit.id, sourceConceptId],
        );
      }

      for (const sourceLinkId of selectedLinkIds) {
        await client.query(
          `
            INSERT INTO kit_link_items (kit_definition_id, source_link_id)
            VALUES ($1::uuid, $2::uuid)
          `,
          [kit.id, sourceLinkId],
        );
      }

      return {
        kind: "created",
        kit,
        conceptCount: selectedConceptIds.length,
        linkCount: selectedLinkIds.length,
      };
    });

    if (outcome.kind === "created") {
      return response.status(201).json({
        ...outcome.kit,
        conceptCount: outcome.conceptCount,
        linkCount: outcome.linkCount,
      });
    }

    if (outcome.kind === "map_not_found") {
      return response.status(404).json({
        error: "map_not_found",
        message: "Goal Mapが見つかりません。",
      });
    }

    if (outcome.kind === "map_type_not_supported") {
      return response.status(422).json({
        error: "goal_map_required",
        message: "Kitの作成元にはGoal Mapを指定してください。",
        type: outcome.mapType,
      });
    }

    if (outcome.kind === "concept_map_mismatch") {
      return response.status(422).json({
        error: "concept_map_mismatch",
        message: "すべてのConceptは指定したGoal Mapに所属する必要があります。",
      });
    }

    if (outcome.kind === "link_map_mismatch") {
      return response.status(422).json({
        error: "link_map_mismatch",
        message: "すべてのLinkは指定したGoal Mapに所属する必要があります。",
      });
    }

    return response.status(422).json({
      error: "link_concept_missing",
      message: "Kitに含めるLinkのsource / target Conceptも指定してください。",
    });
  } catch (error) {
    console.error("Failed to create KitDefinition", safeServerErrorCode(error));
    return response.status(500).json({
      error: "kit_create_failed",
      message: "KitDefinitionを保存できませんでした。",
    });
  }
});

app.patch("/api/maps/:mapId/kit-definition", async (request, response) => {
  const { mapId } = request.params;
  const body: unknown = request.body;

  if (!uuidPattern.test(mapId)) {
    return response.status(400).json({
      error: "invalid_map_id",
      message: "Map IDの形式が正しくありません。",
    });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return response.status(400).json({
      error: "invalid_request",
      message: "JSON bodyを指定してください。",
    });
  }

  const kitDefinitionId = (body as Record<string, unknown>).kitDefinitionId;
  if (
    typeof kitDefinitionId !== "string" ||
    !uuidPattern.test(kitDefinitionId)
  ) {
    return response.status(400).json({
      error: "invalid_kit_definition_id",
      message: "KitDefinition IDの形式が正しくありません。",
    });
  }

  try {
    type AssignKitOutcome =
      | { kind: "assigned"; kitDefinition: KitDefinitionOption }
      | { kind: "map_not_found" }
      | { kind: "map_type_not_supported"; mapType: MapType }
      | { kind: "map_not_draft" }
      | { kind: "kit_already_assigned" }
      | { kind: "kit_not_found" }
      | { kind: "invalid_kit_source" };

    const outcome = await withTransaction<AssignKitOutcome>(async (client) => {
      const map = await lockMapById(client, mapId);
      if (!map) return { kind: "map_not_found" };
      if (map.mapType !== "INTEGRATION") {
        return { kind: "map_type_not_supported", mapType: map.mapType };
      }
      if (map.mapStatus !== "DRAFT") return { kind: "map_not_draft" };
      ensureMapIsEditable(map);
      if (kitDefinitionId === RETIRED_DEVELOPMENT_KIT_ID) {
        return { kind: "kit_not_found" };
      }
      if (map.sessionStageId !== null) {
        const owner = await client.query<{
          protocolKey: string;
          researchKitDefinitionId: string | null;
        }>(
          `SELECT session.protocol_key AS "protocolKey",
                  session.research_kit_definition_id AS "researchKitDefinitionId"
           FROM session_stages AS stage
           JOIN sessions AS session ON session.id = stage.session_id
           WHERE stage.id = $1::uuid`,
          [map.sessionStageId],
        );
        if (
          owner.rows[0]?.protocolKey === STAGE1_PROTOCOL_KEY &&
          owner.rows[0]?.researchKitDefinitionId !== kitDefinitionId
        ) {
          return { kind: "kit_not_found" };
        }
      }

      const currentResult = await client.query<{
        kitDefinitionId: string | null;
      }>(
        `SELECT kit_definition_id AS "kitDefinitionId" FROM maps WHERE id = $1::uuid`,
        [mapId],
      );
      if (currentResult.rows[0]?.kitDefinitionId) {
        return { kind: "kit_already_assigned" };
      }

      const kitResult = await client.query<KitDefinitionOption>(
        `
          SELECT kit.id, kit.name
          FROM kit_definitions AS kit
          INNER JOIN maps AS goal_map
            ON goal_map.id = kit.goal_map_id AND goal_map.type = 'GOAL'
          WHERE kit.id = $1::uuid
          FOR SHARE OF kit, goal_map
        `,
        [kitDefinitionId],
      );
      const kit = kitResult.rows[0];
      if (!kit) {
        const existsResult = await client.query<{ exists: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM kit_definitions WHERE id = $1::uuid) AS exists",
          [kitDefinitionId],
        );
        return existsResult.rows[0]?.exists
          ? { kind: "invalid_kit_source" }
          : { kind: "kit_not_found" };
      }

      await client.query(
        `UPDATE maps SET kit_definition_id = $2::uuid WHERE id = $1::uuid`,
        [mapId, kitDefinitionId],
      );
      const hasEvents = (await client.query<{ name: string | null }>("SELECT to_regclass('map_history_boundaries')::text AS name")).rows[0]?.name;
      if (await isStage1LearnerMap(client, mapId)) {
        if (!hasEvents) throw new HistoryTransitionError("操作履歴のDB変更が未適用です。研究者に連絡してください。");
        await appendMapOperationLog(client, { mapId, operationType: "MAP_KIT_ASSIGN", targetType: "MAP", targetId: mapId, before: null, after: null, clientTimestamp: null });
        return { kind: "assigned", kitDefinition: kit };
      }
      await client.query(
        `UPDATE map_initial_snapshots AS snapshot
         SET snapshot = jsonb_set(snapshot.snapshot, '{kitDefinitionId}', to_jsonb($2::uuid), true)
         WHERE snapshot.map_id = $1::uuid
           AND NOT EXISTS (
             SELECT 1 FROM map_operation_logs AS operation
             WHERE operation.map_id = snapshot.map_id
           )`,
        [mapId, kitDefinitionId],
      );
      return { kind: "assigned", kitDefinition: kit };
    });

    if (outcome.kind === "assigned") {
      return response.json({
        mapId,
        kitDefinitionId,
        kitDefinitionName: outcome.kitDefinition.name,
      });
    }
    if (outcome.kind === "map_not_found") {
      return response.status(404).json({
        error: "map_not_found",
        message: "Mapが見つかりません。",
      });
    }
    if (outcome.kind === "map_type_not_supported") {
      return response.status(422).json({
        error: "integration_map_required",
        message: "KitDefinitionを設定できるのはIntegration Mapだけです。",
        type: outcome.mapType,
      });
    }
    if (outcome.kind === "map_not_draft") {
      return response.status(409).json({
        error: "integration_map_not_draft",
        message:
          "DRAFT状態のIntegration MapだけにKitDefinitionを設定できます。",
      });
    }
    if (outcome.kind === "kit_already_assigned") {
      return response.status(409).json({
        error: "integration_kit_already_assigned",
        message: "このIntegration Mapには既にKitDefinitionが設定されています。",
      });
    }
    if (outcome.kind === "kit_not_found") {
      return response.status(404).json({
        error: "kit_definition_not_found",
        message: "KitDefinitionが見つかりません。",
      });
    }
    return response.status(409).json({
      error: "invalid_kit_source",
      message: "KitDefinitionの参照元がGoal Mapではありません。",
    });
  } catch (error) {
    const policyResponse = readOnlyMapResponse(response, error);
    if (policyResponse) return policyResponse;
    console.error("Failed to assign KitDefinition to Integration Map", safeServerErrorCode(error));
    return response.status(500).json({
      error: "integration_kit_assignment_failed",
      message: "Integration MapへKitDefinitionを設定できませんでした。",
    });
  }
});

app.post(
  "/api/maps/:mapId/kit-concepts/:kitConceptItemId/import",
  async (request, response) => {
    const { mapId, kitConceptItemId } = request.params;
    const body: unknown = request.body;

    if (!uuidPattern.test(mapId) || !uuidPattern.test(kitConceptItemId)) {
      return response.status(400).json({
        error: "invalid_id",
        message: "Map IDまたはKit Concept IDの形式が正しくありません。",
      });
    }

    if (
      body !== undefined &&
      (typeof body !== "object" || body === null || Array.isArray(body))
    ) {
      return response.status(400).json({
        error: "invalid_request",
        message: "JSON objectを指定してください。",
      });
    }
    const timestamp = validateClientTimestamp(
      body === undefined
        ? undefined
        : (body as Record<string, unknown>).clientTimestamp,
    );
    if (!timestamp.valid) {
      return response.status(400).json({
        error: "invalid_client_timestamp",
        message: "clientTimestampはISO 8601形式で指定してください。",
      });
    }

    const payload = body === undefined ? {} : (body as Record<string, unknown>);
    const hasPosition =
      payload.positionX !== undefined || payload.positionY !== undefined;
    if (
      hasPosition &&
      (typeof payload.positionX !== "number" ||
        !Number.isFinite(payload.positionX) ||
        typeof payload.positionY !== "number" ||
        !Number.isFinite(payload.positionY))
    ) {
      return response.status(400).json({
        error: "invalid_position",
        message: "positionXとpositionYは両方に有限の数値を指定してください。",
      });
    }

    try {
      type ImportOutcome =
        | { kind: "created"; concept: CreatedConceptRow }
        | { kind: "map_not_found" }
        | { kind: "map_type_not_supported"; mapType: MapType }
        | { kind: "map_not_draft" }
        | { kind: "map_without_kit" }
        | { kind: "kit_concept_not_found" }
        | { kind: "kit_mismatch" }
        | { kind: "invalid_kit_source" }
        | { kind: "already_imported" };

      const outcome = await withTransaction<ImportOutcome>(async (client) => {
        const map = await lockMapById(client, mapId);
        if (!map) return { kind: "map_not_found" };
        if (
          map.mapType !== "KB" &&
          map.mapType !== "INTEGRATION"
        ) {
          return { kind: "map_type_not_supported", mapType: map.mapType };
        }
        if (map.mapStatus !== "DRAFT") return { kind: "map_not_draft" };

        const mapKitResult = await client.query<{
          kitDefinitionId: string | null;
        }>(
          `SELECT kit_definition_id AS "kitDefinitionId" FROM maps WHERE id = $1::uuid`,
          [mapId],
        );
        const kitDefinitionId = mapKitResult.rows[0]?.kitDefinitionId;
        if (!kitDefinitionId) return { kind: "map_without_kit" };
        if (kitDefinitionId === RETIRED_DEVELOPMENT_KIT_ID) {
          return { kind: "map_without_kit" };
        }

        const itemResult = await client.query<{
          kitDefinitionId: string;
          goalMapId: string;
          goalMapType: MapType;
          sourceConceptId: string;
          sourceMapId: string;
          label: string;
        }>(
          `
            SELECT
              item.kit_definition_id AS "kitDefinitionId",
              kit.goal_map_id AS "goalMapId",
              goal_map.type AS "goalMapType",
              source.id AS "sourceConceptId",
              source.map_id AS "sourceMapId",
              source.label
            FROM kit_concept_items AS item
            INNER JOIN kit_definitions AS kit ON kit.id = item.kit_definition_id
            INNER JOIN maps AS goal_map ON goal_map.id = kit.goal_map_id
            INNER JOIN concepts AS source ON source.id = item.source_concept_id
            WHERE item.id = $1::uuid
            FOR SHARE OF item, kit, goal_map, source
          `,
          [kitConceptItemId],
        );
        const item = itemResult.rows[0];
        if (!item) return { kind: "kit_concept_not_found" };
        if (item.kitDefinitionId !== kitDefinitionId) {
          return { kind: "kit_mismatch" };
        }
        if (
          item.goalMapType !== "GOAL" ||
          item.sourceMapId !== item.goalMapId
        ) {
          return { kind: "invalid_kit_source" };
        }

        const duplicateResult = await client.query<{ exists: boolean }>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM concept_provenance AS provenance
              INNER JOIN concepts AS imported
                ON imported.id = provenance.target_concept_id
              WHERE imported.map_id = $1::uuid
                AND provenance.source_concept_id = $2::uuid
                AND provenance.relation_type = $3
            ) AS exists
          `,
          [
            mapId,
            item.sourceConceptId,
            map.mapType === "KB" ? "CLONED_FROM" : "IMPORTED_FROM",
          ],
        );
        if (duplicateResult.rows[0]?.exists) {
          return { kind: "already_imported" };
        }

        const countResult = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM concepts WHERE map_id = $1::uuid",
          [mapId],
        );
        const conceptCount = countResult.rows[0]?.count ?? 0;
        const createdResult = await client.query<CreatedConceptRow>(
          `
            INSERT INTO concepts (map_id, label, position_x, position_y)
            VALUES ($1::uuid, $2, $3, $4)
            RETURNING
              id,
              map_id AS "mapId",
              label,
              position_x AS "positionX",
              position_y AS "positionY",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
          `,
          [
            mapId,
            item.label,
            hasPosition ? payload.positionX : 760 + (conceptCount % 3) * 250,
            hasPosition
              ? payload.positionY
              : 80 + Math.floor(conceptCount / 3) * 160,
          ],
        );
        const concept = createdResult.rows[0];
        if (!concept)
          throw new Error("Imported Concept insert returned no row");

        const provenanceResult = await client.query<ConceptProvenanceSnapshot>(
          `
            INSERT INTO concept_provenance (
              target_concept_id, source_concept_id, relation_type
            )
            VALUES ($1::uuid, $2::uuid, $3)
            RETURNING id, target_concept_id AS "targetConceptId",
                      source_concept_id AS "sourceConceptId",
                      relation_type AS "relationType", created_at AS "createdAt"
          `,
          [
            concept.id,
            item.sourceConceptId,
            map.mapType === "KB" ? "CLONED_FROM" : "IMPORTED_FROM",
          ],
        );
        await appendMapOperationLog(client, {
          mapId,
          operationType: "IMPORT_KIT_CONCEPT",
          targetType: "CONCEPT",
          targetId: concept.id,
          before: null,
          after: {
            ...toConceptSnapshot(concept),
            mergedIntoConceptId: null,
            provenance: provenanceResult.rows.map((item) => ({
              ...item,
              createdAt: new Date(item.createdAt).toISOString(),
            })),
          },
          clientTimestamp: timestamp.value,
        });

        return { kind: "created", concept };
      });

      if (outcome.kind === "created") {
        return response.status(201).json({
          ...outcome.concept,
          kitConceptItemId,
        });
      }
      if (outcome.kind === "map_not_found") {
        return response.status(404).json({
          error: "map_not_found",
          message: "Mapが見つかりません。",
        });
      }
      if (outcome.kind === "map_type_not_supported") {
        return response.status(422).json({
          error: "integration_map_required",
          message:
            "Kit Conceptを配置できるのはKB MapまたはIntegration Mapだけです。",
          type: outcome.mapType,
        });
      }
      if (outcome.kind === "map_not_draft") {
        return response.status(409).json({
          error: "integration_map_not_draft",
          message: "DRAFT状態のMapだけにKit Conceptを配置できます。",
        });
      }
      if (outcome.kind === "map_without_kit") {
        return response.status(409).json({
          error: "integration_kit_required",
          message: "Integration MapにKitDefinitionを設定してください。",
        });
      }
      if (outcome.kind === "kit_concept_not_found") {
        return response.status(404).json({
          error: "kit_concept_not_found",
          message: "Kit Conceptが見つかりません。",
        });
      }
      if (outcome.kind === "kit_mismatch") {
        return response.status(422).json({
          error: "kit_concept_kit_mismatch",
          message:
            "指定されたKit ConceptはこのIntegration MapのKitに属していません。",
        });
      }
      if (outcome.kind === "invalid_kit_source") {
        return response.status(409).json({
          error: "invalid_kit_source",
          message:
            "Kit ConceptのsourceはKitDefinitionのGoal Mapに属している必要があります。",
        });
      }
      if (outcome.kind === "already_imported") {
        return response.status(409).json({
          error: "kit_concept_already_imported",
          message: "このKit Conceptは既にImportされています。",
        });
      }
    } catch (error) {
      const readOnlyResponse = readOnlyMapResponse(response, error);
      if (readOnlyResponse) return readOnlyResponse;

      console.error("Failed to import Kit Concept", safeServerErrorCode(error));
      return response.status(500).json({
        error: "kit_concept_import_failed",
        message: "Kit ConceptをImportできませんでした。",
      });
    }
  },
);

app.post("/api/maps/:mapId/concepts", async (request, response) => {
  const { mapId } = request.params;

  if (!uuidPattern.test(mapId)) {
    return response.status(400).json({
      error: "invalid_map_id",
      message: "Map IDの形式が正しくありません。",
    });
  }

  const body: unknown = request.body;

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return response.status(400).json({
      error: "invalid_request",
      message: "JSON bodyを指定してください。",
    });
  }

  const payload = body as Record<string, unknown>;
  const label = typeof payload.label === "string" ? payload.label.trim() : "";

  if (!label) {
    return response.status(400).json({
      error: "invalid_label",
      message: "Concept名を入力してください。",
    });
  }

  const { positionX, positionY } = payload;

  if (
    typeof positionX !== "number" ||
    !Number.isFinite(positionX) ||
    typeof positionY !== "number" ||
    !Number.isFinite(positionY)
  ) {
    return response.status(400).json({
      error: "invalid_position",
      message: "positionXとpositionYには有限の数値を指定してください。",
    });
  }

  const timestamp = validateClientTimestamp(payload.clientTimestamp);
  if (!timestamp.valid) {
    return response.status(400).json({
      error: "invalid_client_timestamp",
      message: "clientTimestampにはISO 8601形式の日時を指定してください。",
    });
  }

  try {
    const concept = await withTransaction(async (client) => {
      const map = await lockMapById(client, mapId);
      if (!map) return null;
      ensureConceptStructureEditable(map);

      const result = await client.query<CreatedConceptRow>(
        `
          INSERT INTO concepts (map_id, label, position_x, position_y)
          VALUES ($1::uuid, $2, $3, $4)
          RETURNING
            id,
            map_id AS "mapId",
            label,
            position_x AS "positionX",
            position_y AS "positionY",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [mapId, label, positionX, positionY],
      );
      const createdConcept = result.rows[0];

      await appendMapOperationLog(client, {
        mapId,
        operationType: "ADD_CONCEPT",
        targetType: "CONCEPT",
        targetId: createdConcept.id,
        before: null,
        after: toConceptSnapshot(createdConcept),
        clientTimestamp: timestamp.value,
      });

      return createdConcept;
    });

    if (!concept) {
      return response.status(404).json({
        error: "map_not_found",
        message: "Mapが見つかりません。",
      });
    }

    return response.status(201).json(concept);
  } catch (error) {
    const readOnlyResponse = readOnlyMapResponse(response, error);
    if (readOnlyResponse) return readOnlyResponse;

    if (isPostgresErrorCode(error, "23503")) {
      return response.status(404).json({
        error: "map_not_found",
        message: "Mapが見つかりません。",
      });
    }

    console.error("Failed to create Concept", safeServerErrorCode(error));
    return response.status(500).json({
      error: "concept_create_failed",
      message: "Conceptを保存できませんでした。",
    });
  }
});

app.post("/api/maps/:mapId/concepts/merge", async (request, response) => {
  const { mapId } = request.params;

  if (!uuidPattern.test(mapId)) {
    return response.status(400).json({
      error: "invalid_map_id",
      message: "Map IDの形式が正しくありません。",
    });
  }

  const body: unknown = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return response.status(400).json({
      error: "invalid_request",
      message: "JSON bodyを指定してください。",
    });
  }

  const payload = body as Record<string, unknown>;
  const conceptIds = payload.conceptIds;
  if (
    !Array.isArray(conceptIds) ||
    conceptIds.length !== 2 ||
    !conceptIds.every(
      (id): id is string => typeof id === "string" && uuidPattern.test(id),
    )
  ) {
    return response.status(400).json({
      error: "invalid_concept_ids",
      message: "Merge対象には異なるConcept IDを2件指定してください。",
    });
  }

  const selectedConceptIds = conceptIds as string[];
  if (new Set(selectedConceptIds).size !== 2) {
    return response.status(400).json({
      error: "duplicate_concept_ids",
      message: "同じConceptを2回指定してMergeすることはできません。",
    });
  }

  const label = typeof payload.label === "string" ? payload.label.trim() : "";
  if (!label) {
    return response.status(400).json({
      error: "invalid_label",
      message: "Merge後のConcept名を入力してください。",
    });
  }

  const timestamp = validateClientTimestamp(payload.clientTimestamp);
  if (!timestamp.valid) {
    return response.status(400).json({
      error: "invalid_client_timestamp",
      message: "clientTimestampにはISO 8601形式の日時を指定してください。",
    });
  }

  type MergeOutcome =
    | {
        kind: "merged";
        concept: CreatedConceptRow & { isMergeResult: true };
        mergedConceptIds: string[];
        incidentLinks: LinkSnapshot[];
      }
    | { kind: "map_not_found" }
    | { kind: "map_type_not_supported"; mapType: MapType }
    | { kind: "map_not_draft" }
    | { kind: "concept_not_found" }
    | { kind: "concept_map_mismatch" }
    | { kind: "concept_already_merged" }
    | { kind: "invalid_position" };

  try {
    const outcome = await withTransaction<MergeOutcome>(async (client) => {
      const map = await lockMapById(client, mapId);
      if (!map) return { kind: "map_not_found" };
      if (map.mapType !== "INTEGRATION") {
        return { kind: "map_type_not_supported", mapType: map.mapType };
      }
      if (map.mapStatus !== "DRAFT") return { kind: "map_not_draft" };

      const conceptsResult = await client.query<LockedConceptRow>(
        `
          SELECT
            id,
            map_id AS "mapId",
            label,
            position_x AS "positionX",
            position_y AS "positionY",
            merged_into_concept_id AS "mergedIntoConceptId",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM concepts
          WHERE id = ANY($1::uuid[])
          ORDER BY id
          FOR UPDATE
        `,
        [selectedConceptIds],
      );
      if (conceptsResult.rows.length !== 2) {
        return { kind: "concept_not_found" };
      }

      const conceptsById = new Map(
        conceptsResult.rows.map((concept) => [concept.id, concept]),
      );
      const first = conceptsById.get(selectedConceptIds[0]);
      const second = conceptsById.get(selectedConceptIds[1]);
      if (!first || !second) return { kind: "concept_not_found" };
      if (first.mapId !== mapId || second.mapId !== mapId) {
        return { kind: "concept_map_mismatch" };
      }
      if (
        first.mergedIntoConceptId !== null ||
        second.mergedIntoConceptId !== null
      ) {
        return { kind: "concept_already_merged" };
      }

      const positionX = first.positionX / 2 + second.positionX / 2;
      const positionY = first.positionY / 2 + second.positionY / 2;
      if (
        !Number.isFinite(first.positionX) ||
        !Number.isFinite(first.positionY) ||
        !Number.isFinite(second.positionX) ||
        !Number.isFinite(second.positionY) ||
        !Number.isFinite(positionX) ||
        !Number.isFinite(positionY)
      ) {
        return { kind: "invalid_position" };
      }

      const incidentLinksResult = await client.query<MapLinkRow>(
        `
          SELECT
            id,
            map_id AS "mapId",
            source_concept_id AS "sourceConceptId",
            target_concept_id AS "targetConceptId",
            label, label_position_x AS "labelPositionX", label_position_y AS "labelPositionY"
          FROM links
          WHERE map_id = $1::uuid
            AND (
              source_concept_id = ANY($2::uuid[])
              OR target_concept_id = ANY($2::uuid[])
            )
          ORDER BY id
          FOR UPDATE
        `,
        [mapId, selectedConceptIds],
      );
      const beforeLinks = await attachLinkProvenance(
        client,
        incidentLinksResult.rows.map(toLinkSnapshot),
      );

      const createdResult = await client.query<CreatedConceptRow>(
        `
          INSERT INTO concepts (map_id, label, position_x, position_y)
          VALUES ($1::uuid, $2, $3, $4)
          RETURNING
            id,
            map_id AS "mapId",
            label,
            position_x AS "positionX",
            position_y AS "positionY",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [mapId, label, positionX, positionY],
      );
      const createdConcept = createdResult.rows[0];
      if (!createdConcept)
        throw new Error("Merge Concept insert returned no row");

      const mergeProvenanceResult = await client.query<ConceptProvenanceSnapshot>(
        `
          INSERT INTO concept_provenance (
            target_concept_id,
            source_concept_id,
            relation_type
          )
          VALUES
            ($1::uuid, $2::uuid, 'MERGED_FROM'),
            ($1::uuid, $3::uuid, 'MERGED_FROM')
          RETURNING id, target_concept_id AS "targetConceptId",
                    source_concept_id AS "sourceConceptId",
                    relation_type AS "relationType", created_at AS "createdAt"
        `,
        [createdConcept.id, first.id, second.id],
      );

      const mergedSources = await client.query<{ id: string }>(
        `
          UPDATE concepts
          SET merged_into_concept_id = $3::uuid
          WHERE map_id = $1::uuid
            AND id = ANY($2::uuid[])
            AND merged_into_concept_id IS NULL
          RETURNING id
        `,
        [mapId, selectedConceptIds, createdConcept.id],
      );
      if (mergedSources.rowCount !== 2) {
        throw new ConceptMergeConflictError();
      }

      const rewiredResult = await client.query<MapLinkRow>(
        `
          UPDATE links
          SET
            source_concept_id = CASE
              WHEN source_concept_id = ANY($2::uuid[]) THEN $3::uuid
              ELSE source_concept_id
            END,
            target_concept_id = CASE
              WHEN target_concept_id = ANY($2::uuid[]) THEN $3::uuid
              ELSE target_concept_id
            END
          WHERE map_id = $1::uuid
            AND (
              source_concept_id = ANY($2::uuid[])
              OR target_concept_id = ANY($2::uuid[])
            )
          RETURNING
            id,
            map_id AS "mapId",
            source_concept_id AS "sourceConceptId",
            target_concept_id AS "targetConceptId",
            label
        `,
        [mapId, selectedConceptIds, createdConcept.id],
      );
      const afterLinks = await attachLinkProvenance(
        client,
        rewiredResult.rows.map(toLinkSnapshot),
      );
      const beforeConcepts = await attachConceptProvenance(
        client,
        [first, second].map((item) => ({
          ...toConceptSnapshot(item),
          mergedIntoConceptId: item.mergedIntoConceptId,
        })),
      );
      const mergedConcepts = selectedConceptIds.map((id) => ({
        id,
        mergedIntoConceptId: createdConcept.id,
      }));
      const mergedConceptSnapshot = {
        ...toConceptSnapshot(createdConcept),
        mergedIntoConceptId: null,
        provenance: mergeProvenanceResult.rows.map((item) => ({
          ...item,
          createdAt: new Date(item.createdAt).toISOString(),
        })),
      };

      await appendMapOperationLog(client, {
        mapId,
        operationType: "MERGE_CONCEPT",
        targetType: "CONCEPT",
        targetId: createdConcept.id,
        before: {
          concepts: beforeConcepts,
          incidentLinks: beforeLinks,
        },
        after: {
          concept: mergedConceptSnapshot,
          mergedConcepts,
          incidentLinks: afterLinks,
        },
        clientTimestamp: timestamp.value,
      });

      return {
        kind: "merged",
        concept: { ...createdConcept, isMergeResult: true },
        mergedConceptIds: selectedConceptIds,
        incidentLinks: afterLinks,
      };
    });

    if (outcome.kind === "merged") {
      return response.status(201).json({
        concept: outcome.concept,
        mergedConceptIds: outcome.mergedConceptIds,
        incidentLinks: outcome.incidentLinks,
      });
    }

    if (outcome.kind === "map_not_found") {
      return response.status(404).json({
        error: "map_not_found",
        message: "Integration Mapが見つかりません。",
      });
    }
    if (outcome.kind === "map_type_not_supported") {
      return response.status(422).json({
        error: "integration_map_required",
        message: "Concept MergeはIntegration MapまたはTutorial Mapで行えます。",
        type: outcome.mapType,
      });
    }
    if (outcome.kind === "map_not_draft") {
      return response.status(409).json({
        error: "integration_map_not_editable",
        message: "DRAFTのIntegration MapでのみMergeできます。",
      });
    }
    if (outcome.kind === "concept_not_found") {
      return response.status(404).json({
        error: "concept_not_found",
        message: "Merge対象のConceptが見つかりません。",
      });
    }
    if (outcome.kind === "concept_map_mismatch") {
      return response.status(422).json({
        error: "concept_map_mismatch",
        message: "2つのConceptは同じIntegration Mapに所属する必要があります。",
      });
    }
    if (outcome.kind === "concept_already_merged") {
      return response.status(409).json({
        error: "concept_already_merged",
        message:
          "Merge対象に既にMerge済みのConceptが含まれています。Mapを再読み込みしてください。",
      });
    }
    return response.status(409).json({
      error: "invalid_merge_position",
      message: "Merge対象の座標が無効なため、Mergeできませんでした。",
    });
  } catch (error) {
    const readOnlyResponse = readOnlyMapResponse(response, error);
    if (readOnlyResponse) return readOnlyResponse;

    console.error("Failed to merge Concepts", safeServerErrorCode(error));
    return response.status(500).json({
      error: "concept_merge_failed",
      message: "ConceptをMergeできませんでした。",
    });
  }
});

app.post("/api/maps/:mapId/links", async (request, response) => {
  const { mapId } = request.params;

  if (!uuidPattern.test(mapId)) {
    return response.status(400).json({
      error: "invalid_map_id",
      message: "Map IDの形式が正しくありません。",
    });
  }

  const body: unknown = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return response.status(400).json({
      error: "invalid_request",
      message: "JSON bodyを指定してください。",
    });
  }

  const payload = body as Record<string, unknown>;
  const { sourceConceptId, targetConceptId } = payload;
  const label = typeof payload.label === "string" ? payload.label : null;

  if (
    typeof sourceConceptId !== "string" ||
    !uuidPattern.test(sourceConceptId) ||
    typeof targetConceptId !== "string" ||
    !uuidPattern.test(targetConceptId)
  ) {
    return response.status(400).json({
      error: "invalid_concept_id",
      message:
        "sourceConceptIdとtargetConceptIdには有効なUUIDを指定してください。",
    });
  }

  if (label === null || label.trim().length === 0) {
    return response.status(400).json({
      error: "invalid_label",
      message: "Link labelを入力してください。",
    });
  }

  const timestamp = validateClientTimestamp(payload.clientTimestamp);
  if (!timestamp.valid) {
    return response.status(400).json({
      error: "invalid_client_timestamp",
      message: "clientTimestampにはISO 8601形式の日時を指定してください。",
    });
  }

  try {
    const outcome = await withTransaction<LinkCreateOutcome>(async (client) => {
      const map = await lockMapById(client, mapId);
      if (!map) {
        return { kind: "map_not_found" };
      }
      ensureFreeLinkCreationAllowed(map);

      const membershipResult = await client.query<{
        sourceMapId: string | null;
        targetMapId: string | null;
        sourceMergedIntoConceptId: string | null;
        targetMergedIntoConceptId: string | null;
      }>(
        `
          SELECT
            (SELECT map_id FROM concepts WHERE id = $1::uuid) AS "sourceMapId",
            (SELECT map_id FROM concepts WHERE id = $2::uuid) AS "targetMapId",
            (SELECT merged_into_concept_id FROM concepts WHERE id = $1::uuid)
              AS "sourceMergedIntoConceptId",
            (SELECT merged_into_concept_id FROM concepts WHERE id = $2::uuid)
              AS "targetMergedIntoConceptId"
        `,
        [sourceConceptId, targetConceptId],
      );
      const membership = membershipResult.rows[0];

      if (!membership?.sourceMapId) {
        return { kind: "source_concept_not_found" };
      }

      if (!membership.targetMapId) {
        return { kind: "target_concept_not_found" };
      }

      if (
        membership.sourceMapId !== mapId ||
        membership.targetMapId !== mapId
      ) {
        return { kind: "concept_map_mismatch" };
      }
      ensureConceptNotMerged(membership.sourceMergedIntoConceptId);
      ensureConceptNotMerged(membership.targetMergedIntoConceptId);

      const result = await client.query<CreatedLinkRow>(
        `
          INSERT INTO links (
            map_id,
            source_concept_id,
            target_concept_id,
            label
          )
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
          RETURNING
            id,
            map_id AS "mapId",
            source_concept_id AS "sourceConceptId",
            target_concept_id AS "targetConceptId",
            label,
            created_at AS "createdAt"
        `,
        [mapId, sourceConceptId, targetConceptId, label],
      );
      const link = result.rows[0];
      if (!link) throw new Error("Link insert returned no row");

      await appendMapOperationLog(client, {
        mapId,
        operationType: "ADD_LINK",
        targetType: "LINK",
        targetId: link.id,
        before: null,
        after: toLinkSnapshot(link),
        clientTimestamp: timestamp.value,
      });

      return { kind: "created", link };
    });

    if (outcome.kind === "created") {
      return response.status(201).json(outcome.link);
    }

    if (outcome.kind === "map_not_found") {
      return response.status(404).json({
        error: "map_not_found",
        message: "Mapが見つかりません。",
      });
    }

    if (outcome.kind === "source_concept_not_found") {
      return response.status(404).json({
        error: "source_concept_not_found",
        message: "source Conceptが見つかりません。",
      });
    }

    if (outcome.kind === "target_concept_not_found") {
      return response.status(404).json({
        error: "target_concept_not_found",
        message: "target Conceptが見つかりません。",
      });
    }

    return response.status(422).json({
      error: "concept_map_mismatch",
      message: "sourceとtargetは指定したMapに所属するConceptを選んでください。",
    });
  } catch (error) {
    const readOnlyResponse = readOnlyMapResponse(response, error);
    if (readOnlyResponse) return readOnlyResponse;

    if (isPostgresErrorCode(error, "23503")) {
      return response.status(404).json({
        error: "link_concept_not_found",
        message: "LinkのConceptが見つかりません。",
      });
    }

    console.error("Failed to create Link", safeServerErrorCode(error));
    return response.status(500).json({
      error: "link_create_failed",
      message: "Linkを保存できませんでした。",
    });
  }
});

app.post(
  "/api/maps/:mapId/kit-links/:kitLinkItemId",
  async (request, response) => {
    const { mapId, kitLinkItemId } = request.params;

    if (!uuidPattern.test(mapId)) {
      return response.status(400).json({
        error: "invalid_map_id",
        message: "Map IDの形式が正しくありません。",
      });
    }
    if (!uuidPattern.test(kitLinkItemId)) {
      return response.status(400).json({
        error: "invalid_kit_link_item_id",
        message: "Kit Link Item IDの形式が正しくありません。",
      });
    }

    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return response.status(400).json({
        error: "invalid_request",
        message: "JSON bodyを指定してください。",
      });
    }

    const payload = body as Record<string, unknown>;
    const { sourceConceptId, targetConceptId } = payload;
    if (
      typeof sourceConceptId !== "string" ||
      !uuidPattern.test(sourceConceptId) ||
      typeof targetConceptId !== "string" ||
      !uuidPattern.test(targetConceptId)
    ) {
      return response.status(400).json({
        error: "invalid_concept_id",
        message:
          "sourceConceptIdとtargetConceptIdには有効なUUIDを指定してください。",
      });
    }

    const timestamp = validateClientTimestamp(payload.clientTimestamp);
    if (!timestamp.valid) {
      return response.status(400).json({
        error: "invalid_client_timestamp",
        message: "clientTimestampにはISO 8601形式の日時を指定してください。",
      });
    }

    type ReconstructOutcome =
      | {
          kind: "created";
          link: CreatedLinkRow;
          kitLinkItemId: string;
        }
      | { kind: "map_not_found" }
      | { kind: "map_not_kb" }
      | { kind: "map_not_draft" }
      | { kind: "map_without_kit" }
      | { kind: "kit_link_not_found" }
      | { kind: "source_concept_not_found" }
      | { kind: "target_concept_not_found" }
      | { kind: "concept_map_mismatch" }
      | { kind: "kit_link_already_used" };

    try {
      const outcome = await withTransaction<ReconstructOutcome>(
        async (client) => {
          const map = await lockMapById(client, mapId);
          if (!map) return { kind: "map_not_found" };
          if (map.mapType !== "KB") return { kind: "map_not_kb" };
          if (map.mapStatus !== "DRAFT") return { kind: "map_not_draft" };

          const mapKitResult = await client.query<{
            kitDefinitionId: string | null;
          }>(
            `
              SELECT kit_definition_id AS "kitDefinitionId"
              FROM maps
              WHERE id = $1::uuid
            `,
            [mapId],
          );
          const kitDefinitionId = mapKitResult.rows[0]?.kitDefinitionId;
          if (!kitDefinitionId) return { kind: "map_without_kit" };

          const kitLinkResult = await client.query<{
            sourceLinkId: string;
            label: string;
          }>(
            `
              SELECT
                item.source_link_id AS "sourceLinkId",
                goal_link.label
              FROM kit_link_items AS item
              INNER JOIN kit_definitions AS kit
                ON kit.id = item.kit_definition_id
              INNER JOIN links AS goal_link
                ON goal_link.id = item.source_link_id
                AND goal_link.map_id = kit.goal_map_id
              WHERE item.id = $1::uuid
                AND item.kit_definition_id = $2::uuid
            `,
            [kitLinkItemId, kitDefinitionId],
          );
          const kitLink = kitLinkResult.rows[0];
          if (!kitLink) return { kind: "kit_link_not_found" };

          const membershipResult = await client.query<{
            sourceMapId: string | null;
            targetMapId: string | null;
          }>(
            `
              SELECT
                (SELECT map_id FROM concepts WHERE id = $1::uuid) AS "sourceMapId",
                (SELECT map_id FROM concepts WHERE id = $2::uuid) AS "targetMapId"
            `,
            [sourceConceptId, targetConceptId],
          );
          const membership = membershipResult.rows[0];
          if (!membership?.sourceMapId) {
            return { kind: "source_concept_not_found" };
          }
          if (!membership.targetMapId) {
            return { kind: "target_concept_not_found" };
          }
          if (
            membership.sourceMapId !== mapId ||
            membership.targetMapId !== mapId
          ) {
            return { kind: "concept_map_mismatch" };
          }

          const usedResult = await client.query<{ used: boolean }>(
            `
              SELECT EXISTS (
                SELECT 1
                FROM links AS kb_link
                INNER JOIN link_provenance AS provenance
                  ON provenance.target_link_id = kb_link.id
                WHERE kb_link.map_id = $1::uuid
                  AND provenance.source_link_id = $2::uuid
              ) AS used
            `,
            [mapId, kitLink.sourceLinkId],
          );
          if (usedResult.rows[0]?.used) {
            return { kind: "kit_link_already_used" };
          }

          const linkResult = await client.query<CreatedLinkRow>(
            `
              INSERT INTO links (
                map_id,
                source_concept_id,
                target_concept_id,
                label
              )
              VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
              RETURNING
                id,
                map_id AS "mapId",
                source_concept_id AS "sourceConceptId",
                target_concept_id AS "targetConceptId",
                label,
                created_at AS "createdAt"
            `,
            [mapId, sourceConceptId, targetConceptId, kitLink.label],
          );
          const link = linkResult.rows[0];
          if (!link) throw new Error("KB Link insert returned no row");

          const provenanceResult = await client.query<LinkProvenanceSnapshot>(
            `
              INSERT INTO link_provenance (
                target_link_id,
                source_link_id,
                relation_type
              )
              VALUES ($1::uuid, $2::uuid, 'RECONSTRUCTED_FROM')
              RETURNING id, target_link_id AS "targetLinkId",
                        source_link_id AS "sourceLinkId",
                        relation_type AS "relationType", created_at AS "createdAt"
            `,
            [link.id, kitLink.sourceLinkId],
          );

          await appendMapOperationLog(client, {
            mapId,
            operationType: "ADD_LINK",
            targetType: "LINK",
            targetId: link.id,
            before: null,
            after: {
              ...toLinkSnapshot(link),
              provenance: provenanceResult.rows.map((item) => ({
                ...item,
                createdAt: new Date(item.createdAt).toISOString(),
              })),
            },
            clientTimestamp: timestamp.value,
          });

          return { kind: "created", link, kitLinkItemId };
        },
      );

      if (outcome.kind === "created") {
        return response.status(201).json({
          ...outcome.link,
          kitLinkItemId: outcome.kitLinkItemId,
        });
      }
      if (outcome.kind === "map_not_found") {
        return response.status(404).json({
          error: "map_not_found",
          message: "KB Mapが見つかりません。",
        });
      }
      if (outcome.kind === "map_not_kb") {
        return response.status(409).json({
          error: "kb_map_required",
          message: "Kit LinkはKB Mapでのみ使用できます。",
        });
      }
      if (outcome.kind === "map_not_draft") {
        return response.status(409).json({
          error: "kb_map_not_editable",
          message: "編集中のKB MapでのみLinkを再構成できます。",
        });
      }
      if (outcome.kind === "map_without_kit") {
        return response.status(409).json({
          error: "kb_map_without_kit",
          message: "このKB MapにはKitDefinitionが設定されていません。",
        });
      }
      if (outcome.kind === "kit_link_not_found") {
        return response.status(404).json({
          error: "kit_link_not_found",
          message: "このKB Mapで使えるKit Linkが見つかりません。",
        });
      }
      if (outcome.kind === "source_concept_not_found") {
        return response.status(404).json({
          error: "source_concept_not_found",
          message: "source Conceptが見つかりません。",
        });
      }
      if (outcome.kind === "target_concept_not_found") {
        return response.status(404).json({
          error: "target_concept_not_found",
          message: "target Conceptが見つかりません。",
        });
      }
      if (outcome.kind === "concept_map_mismatch") {
        return response.status(422).json({
          error: "concept_map_mismatch",
          message: "sourceとtargetにはこのKB Map内のConceptを選んでください。",
        });
      }
      return response.status(409).json({
        error: "kit_link_already_used",
        message: "このKit Linkは既に使用されています。",
      });
    } catch (error) {
      const readOnlyResponse = readOnlyMapResponse(response, error);
      if (readOnlyResponse) return readOnlyResponse;

      if (isPostgresErrorCode(error, "23503")) {
        return response.status(404).json({
          error: "kit_link_source_not_found",
          message: "Kit Linkの参照元が見つかりません。",
        });
      }

      console.error("Failed to reconstruct KB Link", safeServerErrorCode(error));
      return response.status(500).json({
        error: "kb_link_create_failed",
        message: "KB Linkを保存できませんでした。",
      });
    }
  },
);

app.post(
  "/api/maps/:mapId/kit-links/:kitLinkItemId/import",
  async (request, response) => {
    const { mapId, kitLinkItemId } = request.params;

    if (!uuidPattern.test(mapId)) {
      return response.status(400).json({
        error: "invalid_map_id",
        message: "Map IDの形式が正しくありません。",
      });
    }
    if (!uuidPattern.test(kitLinkItemId)) {
      return response.status(400).json({
        error: "invalid_kit_link_item_id",
        message: "Kit Link Item IDの形式が正しくありません。",
      });
    }

    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return response.status(400).json({
        error: "invalid_request",
        message: "JSON bodyを指定してください。",
      });
    }

    const payload = body as Record<string, unknown>;
    const { sourceConceptId, targetConceptId } = payload;
    if (
      typeof sourceConceptId !== "string" ||
      !uuidPattern.test(sourceConceptId) ||
      typeof targetConceptId !== "string" ||
      !uuidPattern.test(targetConceptId)
    ) {
      return response.status(400).json({
        error: "invalid_concept_id",
        message:
          "sourceConceptIdとtargetConceptIdには有効なUUIDを指定してください。",
      });
    }

    const timestamp = validateClientTimestamp(payload.clientTimestamp);
    if (!timestamp.valid) {
      return response.status(400).json({
        error: "invalid_client_timestamp",
        message: "clientTimestampにはISO 8601形式の日時を指定してください。",
      });
    }

    type ImportOutcome =
      | {
          kind: "created";
          link: CreatedLinkRow;
          kitLinkItemId: string;
        }
      | { kind: "map_not_found" }
      | { kind: "map_not_integration" }
      | { kind: "map_not_draft" }
      | { kind: "map_without_kit" }
      | { kind: "kit_link_not_found" }
      | { kind: "source_concept_not_found" }
      | { kind: "target_concept_not_found" }
      | { kind: "concept_map_mismatch" }
      | { kind: "kit_link_already_imported" };

    try {
      const outcome = await withTransaction<ImportOutcome>(async (client) => {
        const map = await lockMapById(client, mapId);
        if (!map) return { kind: "map_not_found" };
        if (map.mapType !== "INTEGRATION") {
          return { kind: "map_not_integration" };
        }
        if (map.mapStatus !== "DRAFT") return { kind: "map_not_draft" };

        const mapKitResult = await client.query<{
          kitDefinitionId: string | null;
        }>(
          `
            SELECT kit_definition_id AS "kitDefinitionId"
            FROM maps
            WHERE id = $1::uuid
          `,
          [mapId],
        );
        const kitDefinitionId = mapKitResult.rows[0]?.kitDefinitionId;
        if (!kitDefinitionId) return { kind: "map_without_kit" };
        if (kitDefinitionId === RETIRED_DEVELOPMENT_KIT_ID) {
          return { kind: "map_without_kit" };
        }

        const kitLinkResult = await client.query<{
          sourceLinkId: string;
          label: string;
        }>(
          `
            SELECT
              item.source_link_id AS "sourceLinkId",
              goal_link.label
            FROM kit_link_items AS item
            INNER JOIN kit_definitions AS kit
              ON kit.id = item.kit_definition_id
            INNER JOIN links AS goal_link
              ON goal_link.id = item.source_link_id
              AND goal_link.map_id = kit.goal_map_id
            WHERE item.id = $1::uuid
              AND item.kit_definition_id = $2::uuid
          `,
          [kitLinkItemId, kitDefinitionId],
        );
        const kitLink = kitLinkResult.rows[0];
        if (!kitLink) return { kind: "kit_link_not_found" };

        const membershipResult = await client.query<{
          sourceMapId: string | null;
          targetMapId: string | null;
          sourceMergedIntoConceptId: string | null;
          targetMergedIntoConceptId: string | null;
        }>(
          `
            SELECT
              (SELECT map_id FROM concepts WHERE id = $1::uuid) AS "sourceMapId",
              (SELECT map_id FROM concepts WHERE id = $2::uuid) AS "targetMapId",
              (SELECT merged_into_concept_id FROM concepts WHERE id = $1::uuid)
                AS "sourceMergedIntoConceptId",
              (SELECT merged_into_concept_id FROM concepts WHERE id = $2::uuid)
                AS "targetMergedIntoConceptId"
          `,
          [sourceConceptId, targetConceptId],
        );
        const membership = membershipResult.rows[0];
        if (!membership?.sourceMapId) {
          return { kind: "source_concept_not_found" };
        }
        if (!membership.targetMapId) {
          return { kind: "target_concept_not_found" };
        }
        if (
          membership.sourceMapId !== mapId ||
          membership.targetMapId !== mapId
        ) {
          return { kind: "concept_map_mismatch" };
        }
        ensureConceptNotMerged(membership.sourceMergedIntoConceptId);
        ensureConceptNotMerged(membership.targetMergedIntoConceptId);

        const importedResult = await client.query<{ imported: boolean }>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM links AS integration_link
              INNER JOIN link_provenance AS provenance
                ON provenance.target_link_id = integration_link.id
                AND provenance.source_link_id = $2::uuid
                AND provenance.relation_type = 'IMPORTED_FROM'
              WHERE integration_link.map_id = $1::uuid
            ) AS imported
          `,
          [mapId, kitLink.sourceLinkId],
        );
        if (importedResult.rows[0]?.imported) {
          return { kind: "kit_link_already_imported" };
        }

        const linkResult = await client.query<CreatedLinkRow>(
          `
            INSERT INTO links (
              map_id,
              source_concept_id,
              target_concept_id,
              label
            )
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
            RETURNING
              id,
              map_id AS "mapId",
              source_concept_id AS "sourceConceptId",
              target_concept_id AS "targetConceptId",
              label,
              created_at AS "createdAt"
          `,
          [mapId, sourceConceptId, targetConceptId, kitLink.label],
        );
        const link = linkResult.rows[0];
        if (!link) throw new Error("Integration Link insert returned no row");

        const provenanceResult = await client.query<LinkProvenanceSnapshot>(
          `
            INSERT INTO link_provenance (
              target_link_id,
              source_link_id,
              relation_type
            )
            VALUES ($1::uuid, $2::uuid, 'IMPORTED_FROM')
            RETURNING id, target_link_id AS "targetLinkId",
                      source_link_id AS "sourceLinkId",
                      relation_type AS "relationType", created_at AS "createdAt"
          `,
          [link.id, kitLink.sourceLinkId],
        );

        await appendMapOperationLog(client, {
          mapId,
          operationType: "IMPORT_KIT_LINK",
          targetType: "LINK",
          targetId: link.id,
          before: null,
          after: {
            ...toLinkSnapshot(link),
            provenance: provenanceResult.rows.map((item) => ({
              ...item,
              createdAt: new Date(item.createdAt).toISOString(),
            })),
          },
          clientTimestamp: timestamp.value,
        });

        return { kind: "created", link, kitLinkItemId };
      });

      if (outcome.kind === "created") {
        return response.status(201).json({
          ...outcome.link,
          kitLinkItemId: outcome.kitLinkItemId,
        });
      }
      if (outcome.kind === "map_not_found") {
        return response.status(404).json({
          error: "map_not_found",
          message: "Integration MapまたはTutorial Mapが見つかりません。",
        });
      }
      if (outcome.kind === "map_not_integration") {
        return response.status(409).json({
          error: "integration_map_required",
          message:
            "Kit Link ImportはIntegration Mapで行えます。",
        });
      }
      if (outcome.kind === "map_not_draft") {
        return response.status(409).json({
          error: "integration_map_not_editable",
          message: "編集中のIntegration MapでのみKit LinkをImportできます。",
        });
      }
      if (outcome.kind === "map_without_kit") {
        return response.status(409).json({
          error: "integration_map_without_kit",
          message: "このIntegration MapにはKitDefinitionが設定されていません。",
        });
      }
      if (outcome.kind === "kit_link_not_found") {
        return response.status(404).json({
          error: "kit_link_not_found",
          message: "このIntegration MapのKitに含まれるLinkが見つかりません。",
        });
      }
      if (outcome.kind === "source_concept_not_found") {
        return response.status(404).json({
          error: "source_concept_not_found",
          message: "source Conceptが見つかりません。",
        });
      }
      if (outcome.kind === "target_concept_not_found") {
        return response.status(404).json({
          error: "target_concept_not_found",
          message: "target Conceptが見つかりません。",
        });
      }
      if (outcome.kind === "concept_map_mismatch") {
        return response.status(422).json({
          error: "concept_map_mismatch",
          message:
            "sourceとtargetにはこのIntegration Map内のConceptを選んでください。",
        });
      }
      return response.status(409).json({
        error: "kit_link_already_imported",
        message: "このKit Linkは既にImportされています。",
      });
    } catch (error) {
      if (isPostgresErrorCode(error, "23503")) {
        return response.status(404).json({
          error: "kit_link_source_not_found",
          message: "Kit Linkの参照元が見つかりません。",
        });
      }

      const readOnlyResponse = readOnlyMapResponse(response, error);
      if (readOnlyResponse) return readOnlyResponse;

      console.error("Failed to import Integration Link from Kit", safeServerErrorCode(error));
      return response.status(500).json({
        error: "kit_link_import_failed",
        message: "Kit LinkをImportできませんでした。",
      });
    }
  },
);

app.patch("/api/links/:linkId/label", async (request, response) => {
  const { linkId } = request.params;

  if (!uuidPattern.test(linkId)) {
    return response.status(400).json({
      error: "invalid_link_id",
      message: "Link IDの形式が正しくありません。",
    });
  }

  const body: unknown = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return response.status(400).json({
      error: "invalid_request",
      message: "JSON bodyを指定してください。",
    });
  }

  const payload = body as Record<string, unknown>;
  const label = typeof payload.label === "string" ? payload.label.trim() : "";

  if (!label) {
    return response.status(400).json({
      error: "invalid_label",
      message: "Link labelを入力してください。",
    });
  }

  const timestamp = validateClientTimestamp(payload.clientTimestamp);
  if (!timestamp.valid) {
    return response.status(400).json({
      error: "invalid_client_timestamp",
      message: "clientTimestampにはISO 8601形式の日時を指定してください。",
    });
  }

  try {
    const link = await withTransaction(async (client) => {
      const map = await lockMapForLink(client, linkId);
      if (!map) return null;
      ensureLinkLabelEditable(map);
      const mapId = map.mapId;

      const current = await getLinkForUpdate(client, linkId, mapId);
      if (!current || current.label === label) return current;

      const result = await client.query<UpdatedLinkRow>(
        `
          UPDATE links
          SET label = $2
          WHERE id = $1::uuid AND map_id = $3::uuid
          RETURNING
            id,
            map_id AS "mapId",
            source_concept_id AS "sourceConceptId",
            target_concept_id AS "targetConceptId",
            label,
            updated_at AS "updatedAt"
        `,
        [linkId, label, mapId],
      );
      const updated = result.rows[0];
      if (!updated) return null;

      await appendMapOperationLog(client, {
        mapId,
        operationType: "EDIT_LINK",
        targetType: "LINK",
        targetId: linkId,
        before: toLinkSnapshot(current),
        after: toLinkSnapshot(updated),
        clientTimestamp: timestamp.value,
      });

      return updated;
    });

    if (!link) {
      return response.status(404).json({
        error: "link_not_found",
        message: "Linkが見つかりません。",
      });
    }

    return response.json(link);
  } catch (error) {
    const readOnlyResponse = readOnlyMapResponse(response, error);
    if (readOnlyResponse) return readOnlyResponse;

    console.error("Failed to update Link label", safeServerErrorCode(error));
    return response.status(500).json({
      error: "link_label_update_failed",
      message: "Link labelを保存できませんでした。",
    });
  }
});

app.patch("/api/links/:linkId/reconnect", async (request, response) => {
  const { linkId } = request.params;

  if (!uuidPattern.test(linkId)) {
    return response.status(400).json({
      error: "invalid_link_id",
      message: "Link IDの形式が正しくありません。",
    });
  }

  const body: unknown = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return response.status(400).json({
      error: "invalid_request",
      message: "JSON bodyを指定してください。",
    });
  }

  const payload = body as Record<string, unknown>;
  const { sourceConceptId, targetConceptId } = payload;
  if (
    typeof sourceConceptId !== "string" ||
    !uuidPattern.test(sourceConceptId) ||
    typeof targetConceptId !== "string" ||
    !uuidPattern.test(targetConceptId)
  ) {
    return response.status(400).json({
      error: "invalid_concept_id",
      message:
        "sourceConceptIdとtargetConceptIdには有効なUUIDを指定してください。",
    });
  }

  const timestamp = validateClientTimestamp(payload.clientTimestamp);
  if (!timestamp.valid) {
    return response.status(400).json({
      error: "invalid_client_timestamp",
      message: "clientTimestampにはISO 8601形式の日時を指定してください。",
    });
  }

  try {
    const outcome = await withTransaction<LinkReconnectOutcome>(
      async (client) => {
        const map = await lockMapForLink(client, linkId);
        if (!map) return { kind: "link_not_found" };
        ensureMapIsEditable(map);
        const mapId = map.mapId;

        const current = await getLinkForUpdate(client, linkId, mapId);
        if (!current) return { kind: "link_not_found" };

        const membershipResult = await client.query<{
          sourceMapId: string | null;
          targetMapId: string | null;
          sourceMergedIntoConceptId: string | null;
          targetMergedIntoConceptId: string | null;
        }>(
          `
            SELECT
              (SELECT map_id FROM concepts WHERE id = $1::uuid) AS "sourceMapId",
              (SELECT map_id FROM concepts WHERE id = $2::uuid) AS "targetMapId",
              (SELECT merged_into_concept_id FROM concepts WHERE id = $1::uuid)
                AS "sourceMergedIntoConceptId",
              (SELECT merged_into_concept_id FROM concepts WHERE id = $2::uuid)
                AS "targetMergedIntoConceptId"
          `,
          [sourceConceptId, targetConceptId],
        );
        const membership = membershipResult.rows[0];

        if (!membership?.sourceMapId) {
          return { kind: "source_concept_not_found" };
        }

        if (!membership.targetMapId) {
          return { kind: "target_concept_not_found" };
        }

        if (
          membership.sourceMapId !== mapId ||
          membership.targetMapId !== mapId
        ) {
          return { kind: "concept_map_mismatch" };
        }
        ensureConceptNotMerged(membership.sourceMergedIntoConceptId);
        ensureConceptNotMerged(membership.targetMergedIntoConceptId);

        if (
          current.sourceConceptId === sourceConceptId &&
          current.targetConceptId === targetConceptId
        ) {
          return { kind: "updated", link: current };
        }

        const result = await client.query<UpdatedLinkRow>(
          `
            UPDATE links
            SET
              source_concept_id = $2::uuid,
              target_concept_id = $3::uuid
            WHERE id = $1::uuid AND map_id = $4::uuid
            RETURNING
              id,
              map_id AS "mapId",
              source_concept_id AS "sourceConceptId",
              target_concept_id AS "targetConceptId",
              label,
              updated_at AS "updatedAt"
          `,
          [linkId, sourceConceptId, targetConceptId, mapId],
        );
        const updated = result.rows[0];
        if (!updated) return { kind: "link_not_found" };

        await appendMapOperationLog(client, {
          mapId,
          operationType: "RECONNECT_LINK",
          targetType: "LINK",
          targetId: linkId,
          before: toLinkSnapshot(current),
          after: toLinkSnapshot(updated),
          clientTimestamp: timestamp.value,
        });

        return { kind: "updated", link: updated };
      },
    );

    if (outcome.kind === "updated") {
      return response.json(outcome.link);
    }

    if (outcome.kind === "link_not_found") {
      return response.status(404).json({
        error: "link_not_found",
        message: "Linkが見つかりません。",
      });
    }

    if (outcome.kind === "source_concept_not_found") {
      return response.status(404).json({
        error: "source_concept_not_found",
        message: "source Conceptが見つかりません。",
      });
    }

    if (outcome.kind === "target_concept_not_found") {
      return response.status(404).json({
        error: "target_concept_not_found",
        message: "target Conceptが見つかりません。",
      });
    }

    return response.status(422).json({
      error: "concept_map_mismatch",
      message:
        "sourceとtargetはLinkと同じMapに所属するConceptを選んでください。",
    });
  } catch (error) {
    const readOnlyResponse = readOnlyMapResponse(response, error);
    if (readOnlyResponse) return readOnlyResponse;

    if (isPostgresErrorCode(error, "23503")) {
      return response.status(404).json({
        error: "link_concept_not_found",
        message: "再接続先のConceptが見つかりません。",
      });
    }

    console.error("Failed to reconnect Link", safeServerErrorCode(error));
    return response.status(500).json({
      error: "link_reconnect_failed",
      message: "Linkを再接続できませんでした。",
    });
  }
});

app.delete("/api/links/:linkId", async (request, response) => {
  const { linkId } = request.params;

  if (!uuidPattern.test(linkId)) {
    return response.status(400).json({
      error: "invalid_link_id",
      message: "Link IDの形式が正しくありません。",
    });
  }

  const body = request.body === undefined ? {} : request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return response.status(400).json({
      error: "invalid_request",
      message: "JSON bodyを指定してください。",
    });
  }

  const timestamp = validateClientTimestamp(
    (body as Record<string, unknown>).clientTimestamp,
  );
  if (!timestamp.valid) {
    return response.status(400).json({
      error: "invalid_client_timestamp",
      message: "clientTimestampにはISO 8601形式の日時を指定してください。",
    });
  }

  try {
    const deletedLink = await withTransaction(async (client) => {
      const map = await lockMapForLink(client, linkId);
      if (!map) return null;
      ensureMapIsEditable(map);
      const mapId = map.mapId;

      const current = await getLinkForUpdate(client, linkId, mapId);
      if (!current) return null;
      const [currentWithProvenance] = await attachLinkProvenance(client, [
        toLinkSnapshot(current),
      ]);

      const result = await client.query<{ id: string }>(
        `
          DELETE FROM links
          WHERE id = $1::uuid AND map_id = $2::uuid
          RETURNING id
        `,
        [linkId, mapId],
      );
      const deleted = result.rows[0];
      if (!deleted) return null;

      await appendMapOperationLog(client, {
        mapId,
        operationType: "DELETE_LINK",
        targetType: "LINK",
        targetId: deleted.id,
        before: currentWithProvenance,
        after: null,
        clientTimestamp: timestamp.value,
      });

      return deleted;
    });

    if (!deletedLink) {
      return response.status(404).json({
        error: "link_not_found",
        message: "Linkが見つかりません。",
      });
    }

    return response.json({ id: deletedLink.id });
  } catch (error) {
    const readOnlyResponse = readOnlyMapResponse(response, error);
    if (readOnlyResponse) return readOnlyResponse;

    console.error("Failed to delete Link", safeServerErrorCode(error));
    return response.status(500).json({
      error: "link_delete_failed",
      message: "Linkを削除できませんでした。",
    });
  }
});

app.patch("/api/concepts/:conceptId/position", async (request, response) => {
  const { conceptId } = request.params;

  if (!uuidPattern.test(conceptId)) {
    return response.status(400).json({
      error: "invalid_concept_id",
      message: "Concept IDの形式が正しくありません。",
    });
  }

  const body: unknown = request.body;

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return response.status(400).json({
      error: "invalid_request",
      message: "JSON bodyを指定してください。",
    });
  }

  const payload = body as Record<string, unknown>;
  const { positionX, positionY } = payload;

  if (
    typeof positionX !== "number" ||
    !Number.isFinite(positionX) ||
    typeof positionY !== "number" ||
    !Number.isFinite(positionY)
  ) {
    return response.status(400).json({
      error: "invalid_position",
      message: "positionXとpositionYには有限の数値を指定してください。",
    });
  }

  const timestamp = validateClientTimestamp(payload.clientTimestamp);
  if (!timestamp.valid) {
    return response.status(400).json({
      error: "invalid_client_timestamp",
      message: "clientTimestampにはISO 8601形式の日時を指定してください。",
    });
  }

  try {
    const concept = await withTransaction(async (client) => {
      const map = await lockMapForConcept(client, conceptId);
      if (!map) return null;
      ensureMapIsEditable(map);
      const mapId = map.mapId;

      const current = await getConceptForUpdate(client, conceptId, mapId);
      if (!current) return null;
      ensureConceptActive(current);

      if (current.positionX === positionX && current.positionY === positionY) {
        return current;
      }

      const result = await client.query<CreatedConceptRow>(
        `
          UPDATE concepts
          SET position_x = $2, position_y = $3
          WHERE id = $1::uuid AND map_id = $4::uuid
          RETURNING
            id,
            map_id AS "mapId",
            label,
            position_x AS "positionX",
            position_y AS "positionY",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [conceptId, positionX, positionY, mapId],
      );
      const updatedConcept = result.rows[0];

      await appendMapOperationLog(client, {
        mapId,
        operationType: "MOVE_CONCEPT",
        targetType: "CONCEPT",
        targetId: conceptId,
        before: toConceptSnapshot(current),
        after: toConceptSnapshot(updatedConcept),
        clientTimestamp: timestamp.value,
      });

      return updatedConcept;
    });

    if (!concept) {
      return response.status(404).json({
        error: "concept_not_found",
        message: "Conceptが見つかりません。",
      });
    }

    return response.json(concept);
  } catch (error) {
    const readOnlyResponse = readOnlyMapResponse(response, error);
    if (readOnlyResponse) return readOnlyResponse;

    console.error("Failed to update Concept position", safeServerErrorCode(error));
    return response.status(500).json({
      error: "concept_position_update_failed",
      message: "Conceptの位置を保存できませんでした。",
    });
  }
});

app.patch("/api/links/:linkId/position", async (request, response) => {
 const {linkId}=request.params, body=request.body as Record<string,unknown>|undefined;
 if(!uuidPattern.test(linkId))return response.status(404).json({error:"not_found"});
 if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(k=>!["labelPositionX","labelPositionY","clientTimestamp"].includes(k))||!validMapCoordinate(body.labelPositionX)||!validMapCoordinate(body.labelPositionY))return response.status(400).json({error:"invalid_link_position",message:"リンクの座標は絶対値10000000以内の数値で指定してください。"});
 const {labelPositionX,labelPositionY}=body; const timestamp=validateClientTimestamp(body.clientTimestamp);
 if(!timestamp.valid)return response.status(400).json({error:"invalid_client_timestamp"});
 try {
  const saved=await withTransaction(async client=>{
   const map=await lockMapForLink(client,linkId);if(!map)return null;ensureMapIsEditable(map);
   if(!await isStage1LearnerMap(client,map.mapId))return null;
   const row=(await client.query("SELECT label_position_x, label_position_y FROM links WHERE id=$1 AND map_id=$2 FOR UPDATE",[linkId,map.mapId])).rows[0];
   if(!row)return null;
   if(row.label_position_x!==labelPositionX||row.label_position_y!==labelPositionY){
    await client.query("UPDATE links SET label_position_x=$2,label_position_y=$3 WHERE id=$1",[linkId,labelPositionX,labelPositionY]);
    await appendMapOperationLog(client,{mapId:map.mapId,operationType:"MOVE_LINK",targetType:"LINK",targetId:linkId,before:null,after:null,clientTimestamp:timestamp.value,idempotencyKey:request.get("Idempotency-Key")??null});
   }
   return{id:linkId,mapId:map.mapId,labelPositionX,labelPositionY};
  });return saved?response.json(saved):response.status(404).json({error:"not_found"});
 }catch(error){const policy=readOnlyMapResponse(response,error);if(policy)return policy;return response.status(500).json({error:"link_position_save_failed",message:"リンクの位置を保存できませんでした。"});}
});

app.patch("/api/concepts/:conceptId/label", async (request, response) => {
  const { conceptId } = request.params;

  if (!uuidPattern.test(conceptId)) {
    return response.status(400).json({
      error: "invalid_concept_id",
      message: "Concept IDの形式が正しくありません。",
    });
  }

  const body: unknown = request.body;

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return response.status(400).json({
      error: "invalid_request",
      message: "JSON bodyを指定してください。",
    });
  }

  const payload = body as Record<string, unknown>;
  const label = typeof payload.label === "string" ? payload.label.trim() : "";

  if (!label) {
    return response.status(400).json({
      error: "invalid_label",
      message: "Concept名を入力してください。",
    });
  }

  const timestamp = validateClientTimestamp(payload.clientTimestamp);
  if (!timestamp.valid) {
    return response.status(400).json({
      error: "invalid_client_timestamp",
      message: "clientTimestampにはISO 8601形式の日時を指定してください。",
    });
  }

  try {
    const concept = await withTransaction(async (client) => {
      const map = await lockMapForConcept(client, conceptId);
      if (!map) return null;
      ensureConceptStructureEditable(map);
      const mapId = map.mapId;

      const current = await getConceptForUpdate(client, conceptId, mapId);
      if (!current) return null;
      ensureConceptActive(current);

      if (current.label === label) return current;

      const result = await client.query<CreatedConceptRow>(
        `
          UPDATE concepts
          SET label = $2
          WHERE id = $1::uuid AND map_id = $3::uuid
          RETURNING
            id,
            map_id AS "mapId",
            label,
            position_x AS "positionX",
            position_y AS "positionY",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [conceptId, label, mapId],
      );
      const updatedConcept = result.rows[0];

      await appendMapOperationLog(client, {
        mapId,
        operationType: "EDIT_CONCEPT",
        targetType: "CONCEPT",
        targetId: conceptId,
        before: toConceptSnapshot(current),
        after: toConceptSnapshot(updatedConcept),
        clientTimestamp: timestamp.value,
      });

      return updatedConcept;
    });

    if (!concept) {
      return response.status(404).json({
        error: "concept_not_found",
        message: "Conceptが見つかりません。",
      });
    }

    return response.json(concept);
  } catch (error) {
    const readOnlyResponse = readOnlyMapResponse(response, error);
    if (readOnlyResponse) return readOnlyResponse;

    console.error("Failed to update Concept label", safeServerErrorCode(error));
    return response.status(500).json({
      error: "concept_label_update_failed",
      message: "Concept名を保存できませんでした。",
    });
  }
});

app.delete("/api/concepts/:conceptId", async (request, response) => {
  const { conceptId } = request.params;

  if (!uuidPattern.test(conceptId)) {
    return response.status(400).json({
      error: "invalid_concept_id",
      message: "Concept IDの形式が正しくありません。",
    });
  }

  const body = request.body === undefined ? {} : request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return response.status(400).json({
      error: "invalid_request",
      message: "JSON bodyを指定してください。",
    });
  }

  const timestamp = validateClientTimestamp(
    (body as Record<string, unknown>).clientTimestamp,
  );
  if (!timestamp.valid) {
    return response.status(400).json({
      error: "invalid_client_timestamp",
      message: "clientTimestampにはISO 8601形式の日時を指定してください。",
    });
  }

  try {
    const deletedConcept = await withTransaction(async (client) => {
      const map = await lockMapForConcept(client, conceptId);
      if (!map) return null;
      ensureConceptStructureEditable(map);
      const mapId = map.mapId;

      const current = await getConceptForUpdate(client, conceptId, mapId);
      if (!current) return null;
      ensureConceptActive(current);

      const mergeChildren = await client.query<{ isReferenced: boolean }>(
        `
          SELECT EXISTS (
            SELECT 1
            FROM concepts
            WHERE merged_into_concept_id = $1::uuid
          ) AS "isReferenced"
        `,
        [conceptId],
      );
      if (mergeChildren.rows[0]?.isReferenced) {
        throw new MergeResultProtectedError();
      }

      // Stage1 needs enough information to reverse concept deletions, including
      // FK-cascaded Links. Keep older protocol snapshots unchanged for compatibility.
      let deletionBefore: OperationSnapshot = toConceptSnapshot(current);
      if (map.sessionStageId !== null) {
        const owner = await client.query<{ protocolKey: string }>(
          `SELECT session.protocol_key AS "protocolKey"
           FROM session_stages AS stage
           JOIN sessions AS session ON session.id = stage.session_id
           WHERE stage.id = $1::uuid`,
          [map.sessionStageId],
        );
        if (owner.rows[0]?.protocolKey === STAGE1_PROTOCOL_KEY) {
          const incident = await client.query<LinkSnapshot>(
            `SELECT id, map_id AS "mapId",
                    source_concept_id AS "sourceConceptId",
                    target_concept_id AS "targetConceptId", label
             FROM links
             WHERE map_id = $1::uuid
               AND (source_concept_id = $2::uuid OR target_concept_id = $2::uuid)
             ORDER BY id FOR UPDATE`,
            [mapId, conceptId],
          );
          const [conceptWithProvenance] = await attachConceptProvenance(client, [
            {
              ...toConceptSnapshot(current),
              mergedIntoConceptId: current.mergedIntoConceptId,
            },
          ]);
          const linksWithProvenance = await attachLinkProvenance(
            client,
            incident.rows.map(toLinkSnapshot),
          );
          deletionBefore = {
            concept: conceptWithProvenance,
            incidentLinks: linksWithProvenance,
          };
        }
      }

      const result = await client.query<{ id: string }>(
        `
          DELETE FROM concepts
          WHERE id = $1::uuid AND map_id = $2::uuid
          RETURNING id
        `,
        [conceptId, mapId],
      );
      const deleted = result.rows[0];
      if (!deleted) return null;

      await appendMapOperationLog(client, {
        mapId,
        operationType: "DELETE_CONCEPT",
        targetType: "CONCEPT",
        targetId: deleted.id,
        before: deletionBefore,
        after: null,
        clientTimestamp: timestamp.value,
      });

      return deleted;
    });

    if (!deletedConcept) {
      return response.status(404).json({
        error: "concept_not_found",
        message: "Conceptが見つかりません。",
      });
    }

    return response.json({ id: deletedConcept.id });
  } catch (error) {
    const readOnlyResponse = readOnlyMapResponse(response, error);
    if (readOnlyResponse) return readOnlyResponse;

    if (isPostgresErrorCode(error, "23503")) {
      return response.status(409).json({
        error: "concept_lineage_protected",
        message:
          "ProvenanceまたはMerge lineageを保持するため、このConceptは削除できません。",
      });
    }

    console.error("Failed to delete Concept", safeServerErrorCode(error));
    return response.status(500).json({
      error: "concept_delete_failed",
      message: "Conceptを削除できませんでした。",
    });
  }
});

app.post("/api/kits/:kitId/kb-map", async (request, response) => {
  const { kitId } = request.params;

  if (!uuidPattern.test(kitId)) {
    return response.status(400).json({
      error: "invalid_kit_id",
      message: "Kit IDの形式が正しくありません。",
    });
  }

  let sessionStageId: string | null = null;
  if (request.body !== undefined) {
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return response.status(400).json({
        error: "invalid_request",
        message: "JSON bodyにはsessionStageIdだけを指定してください。",
      });
    }
    const payload = body as Record<string, unknown>;
    if (Object.keys(payload).some((key) => key !== "sessionStageId")) {
      return response.status(400).json({
        error: "invalid_request",
        message: "JSON bodyにはsessionStageIdだけを指定してください。",
      });
    }
    if (payload.sessionStageId !== undefined) {
      if (
        typeof payload.sessionStageId !== "string" ||
        !uuidPattern.test(payload.sessionStageId)
      ) {
        return response.status(400).json({
          error: "invalid_session_stage_id",
          message: "sessionStageIdには有効なUUIDを指定してください。",
        });
      }
      sessionStageId = payload.sessionStageId;
    }
  }

  try {
    const outcome = await withTransaction<KBInitializeOutcome>(
      async (client) => {
        if (sessionStageId !== null) {
          const validation = await lockSessionStageForMap(
            client,
            sessionStageId,
            "KB",
          );
          if (validation.kind !== "ready") return validation;
          const owner = await client.query<{
            protocolKey: string;
            researchKitDefinitionId: string | null;
          }>(
            `SELECT protocol_key AS "protocolKey",
                    research_kit_definition_id AS "researchKitDefinitionId"
             FROM sessions WHERE id = $1::uuid`,
            [validation.stage.sessionId],
          );
          if (
            owner.rows[0]?.protocolKey === STAGE1_PROTOCOL_KEY &&
            owner.rows[0]?.researchKitDefinitionId !== kitId
          ) {
            return { kind: "kit_not_found" };
          }
        }

        if (kitId === RETIRED_DEVELOPMENT_KIT_ID) {
          return { kind: "kit_not_found" };
        }

        const kitResult = await client.query<KitDefinitionRow>(
          `
          SELECT id, goal_map_id AS "goalMapId", name, created_at AS "createdAt"
          FROM kit_definitions
          WHERE id = $1::uuid
          FOR SHARE
        `,
          [kitId],
        );
        const kit = kitResult.rows[0];
        if (!kit) return { kind: "kit_not_found" };

        const goalResult = await client.query<{ type: MapType }>(
          "SELECT type FROM maps WHERE id = $1::uuid FOR SHARE",
          [kit.goalMapId],
        );
        if (goalResult.rows[0]?.type !== "GOAL") {
          return { kind: "invalid_kit_source" };
        }

        // Order by ID, independent of Goal positions and graph connections.
        const sourceResult = await client.query<{
          id: string;
          mapId: string;
          label: string;
        }>(
          `
          SELECT concept.id, concept.map_id AS "mapId", concept.label
          FROM kit_concept_items AS item
          INNER JOIN concepts AS concept ON concept.id = item.source_concept_id
          WHERE item.kit_definition_id = $1::uuid
          ORDER BY concept.id
          FOR SHARE OF item, concept
        `,
          [kitId],
        );
        if (
          sourceResult.rows.some((concept) => concept.mapId !== kit.goalMapId)
        ) {
          return { kind: "invalid_kit_source" };
        }

        const mapResult = await client.query<KBMapRow>(
          `
          INSERT INTO maps (type, status, kit_definition_id, session_stage_id)
          VALUES ('KB', 'DRAFT', $1::uuid, $2::uuid)
          RETURNING
            id, type, status,
            kit_definition_id AS "kitDefinitionId",
            based_on_map_id AS "basedOnMapId",
            session_stage_id AS "sessionStageId",
            submitted_at AS "submittedAt"
        `,
          [kit.id, sessionStageId],
        );
        const map = mapResult.rows[0];
        if (!map) throw new Error("KB Map insert returned no row");

        await createMapInitialSnapshot(client, map.id);

        return { kind: "created", map, conceptCount: 0 };
      },
    );

    if (outcome.kind === "created") {
      return response.status(201).json({
        ...outcome.map,
        conceptCount: outcome.conceptCount,
        linkCount: 0,
      });
    }

    if (outcome.kind === "kit_not_found") {
      return response.status(404).json({
        error: "kit_not_found",
        message: "KitDefinitionが見つかりません。",
      });
    }

    if (
      outcome.kind === "not_found" ||
      outcome.kind === "type_mismatch" ||
      outcome.kind === "already_assigned" ||
      outcome.kind === "session_not_in_progress" ||
      outcome.kind === "stage_not_current" ||
      outcome.kind === "stage_not_in_progress"
    ) {
      return sessionStageMapResponse(response, outcome);
    }


    return response.status(409).json({
      error: "invalid_kit_source",
      message: "Kitの参照元が同一Goal MapのConceptになっていません。",
    });
  } catch (error) {
    if (isPostgresErrorCode(error, "23505") && sessionStageId !== null) {
      return sessionStageMapResponse(response, {
        kind: "session_stage_already_assigned",
      });
    }
    console.error("Failed to initialize KB Map", safeServerErrorCode(error));
    return response.status(500).json({
      error: "kb_initialization_failed",
      message: "KB Mapを初期化できませんでした。",
    });
  }
});

app.get("/api/kits", async (_request, response) => {
  try {
    const result = await pool.query<KitDefinitionOption>(
      `SELECT kit.id, kit.name
       FROM kit_definitions AS kit
       INNER JOIN maps AS goal_map
         ON goal_map.id = kit.goal_map_id AND goal_map.type = 'GOAL'
       WHERE kit.id <> $1::uuid
       ORDER BY kit.created_at, kit.id`,
      [RETIRED_DEVELOPMENT_KIT_ID],
    );
    const principal = principalOf(response);
    return response.json({ kits: principal.role === "researcher"
      ? result.rows : result.rows.filter((kit) => kit.id === principal.kitId) });
  } catch (error) {
    console.error("Failed to list KitDefinitions", safeServerErrorCode(error));
    return response.status(500).json({
      error: "kit_list_failed",
      message: "KitDefinitionを取得できませんでした。",
    });
  }
});

app.get("/api/kits/:kitId", async (request, response) => {
  const { kitId } = request.params;

  if (!uuidPattern.test(kitId)) {
    return response.status(400).json({
      error: "invalid_kit_id",
      message: "Kit IDの形式が正しくありません。",
    });
  }

  try {
    if (kitId === RETIRED_DEVELOPMENT_KIT_ID) {
      return response.status(404).json({
        error: "kit_not_found",
        message: "KitDefinitionが見つかりません。",
      });
    }
    const kitResult = await pool.query<KitDefinitionRow>(
      `
        SELECT
          id,
          goal_map_id AS "goalMapId",
          name,
          created_at AS "createdAt"
        FROM kit_definitions
        WHERE id = $1::uuid
      `,
      [kitId],
    );
    const kit = kitResult.rows[0];
    if (!kit) {
      return response.status(404).json({
        error: "kit_not_found",
        message: "KitDefinitionが見つかりません。",
      });
    }

    const conceptsResult = await pool.query<{ kitConceptItemId: string; label: string }>(
      `
        SELECT
          item.id AS "kitConceptItemId",
          concept.label
        FROM kit_concept_items AS item
        INNER JOIN concepts AS concept
          ON concept.id = item.source_concept_id
          AND concept.map_id = $2::uuid
        WHERE item.kit_definition_id = $1::uuid
        ORDER BY item.created_at, item.id
      `,
      [kitId, kit.goalMapId],
    );

    const linksResult = await pool.query<{ kitLinkItemId: string; label: string }>(
      `
        SELECT
          item.id AS "kitLinkItemId",
          link.label
        FROM kit_link_items AS item
        INNER JOIN links AS link
          ON link.id = item.source_link_id
          AND link.map_id = $2::uuid
        INNER JOIN concepts AS source_concept
          ON source_concept.id = link.source_concept_id
          AND source_concept.map_id = link.map_id
        INNER JOIN concepts AS target_concept
          ON target_concept.id = link.target_concept_id
          AND target_concept.map_id = link.map_id
        WHERE item.kit_definition_id = $1::uuid
        ORDER BY item.created_at, item.id
      `,
      [kitId, kit.goalMapId],
    );

    // Learner-safe Kit view: only independent parts, never Goal positions,
    // source/target pairings, GoalMap ID or source entity IDs.
    return response.json({
      id: kit.id,
      name: kit.name,
      createdAt: kit.createdAt,
      concepts: conceptsResult.rows,
      links: linksResult.rows,
    });
  } catch (error) {
    console.error("Failed to fetch KitDefinition", safeServerErrorCode(error));
    return response.status(500).json({
      error: "kit_fetch_failed",
      message: "KitDefinitionの取得に失敗しました。",
    });
  }
});

app.get("/api/maps/:mapId/access", async (request, response) => {
  const { mapId } = request.params;
  if (!uuidPattern.test(mapId)) return response.status(404).json({ error: "not_found" });
  try {
    if (principalOf(response).role === "researcher") {
      const result = await pool.query("SELECT 1 FROM maps WHERE id = $1::uuid", [mapId]);
      if (!result.rowCount) return response.status(404).json({ error: "not_found" });
    }
    return response.status(204).end();
  } catch {
    return response.status(500).json({ error: "map_access_check_failed" });
  }
});

app.get("/api/maps/:mapId", async (request, response) => {
  const { mapId } = request.params;

  if (!uuidPattern.test(mapId)) {
    return response.status(400).json({
      error: "invalid_map_id",
      message: "Map IDの形式が正しくありません。",
    });
  }

  try {
    const result = await pool.query<MapConceptRow>(
      `
        SELECT
          m.id AS "mapId",
          m.type AS "mapType",
          m.status AS "mapStatus",
          m.title AS "mapTitle",
          m.created_at AS "mapCreatedAt",
          m.submitted_at AS "mapSubmittedAt",
          m.based_on_map_id AS "basedOnMapId",
          CASE WHEN m.type = 'GOAL' THEN source_kit.id ELSE m.kit_definition_id END AS "kitDefinitionId",
          m.session_stage_id AS "sessionStageId",
          stage.session_id AS "sessionId",
          stage.status AS "sessionStageStatus",
          session.protocol_key AS "sessionProtocolKey",
          CASE WHEN m.type = 'GOAL' THEN source_kit.name ELSE kit.name END AS "kitDefinitionName",
          c.id AS "conceptId",
          c.label,
          c.position_x AS "positionX",
          c.position_y AS "positionY",
          c.created_at AS "conceptCreatedAt",
          c.updated_at AS "conceptUpdatedAt",
          EXISTS (
            SELECT 1
            FROM concepts AS merged_source
            WHERE merged_source.merged_into_concept_id = c.id
          ) AS "isMergeResult"
        FROM maps AS m
        LEFT JOIN kit_definitions AS kit ON kit.id = m.kit_definition_id
        LEFT JOIN LATERAL (
          SELECT id, name
          FROM kit_definitions
          WHERE goal_map_id = m.id
          ORDER BY created_at, id
          LIMIT 1
        ) AS source_kit ON m.type = 'GOAL'
        LEFT JOIN session_stages AS stage ON stage.id = m.session_stage_id
        LEFT JOIN sessions AS session ON session.id = stage.session_id
        LEFT JOIN concepts AS c
          ON c.map_id = m.id
          AND c.merged_into_concept_id IS NULL
        WHERE m.id = $1::uuid
          AND (m.type = 'GOAL' OR (
            m.type IN ('PRIOR', 'KB', 'INTEGRATION')
            AND session.protocol_key IN ('STAGE1_4', 'STAGE1_6')
          ))
        ORDER BY c.created_at NULLS LAST, c.id
      `,
      [mapId],
    );

    const map = result.rows[0];

    if (!map) {
      return response.status(404).json({
        error: "map_not_found",
        message: "Mapが見つかりません。",
      });
    }

    const linksResult = await pool.query<MapLinkRow>(
      `
        SELECT
          link.id,
          link.map_id AS "mapId",
          link.source_concept_id AS "sourceConceptId",
          link.target_concept_id AS "targetConceptId",
          link.label, link.label_position_x AS "labelPositionX",link.label_position_y AS "labelPositionY",
          (
            SELECT item.id
            FROM link_provenance AS provenance
            INNER JOIN kit_link_items AS item
              ON item.source_link_id = provenance.source_link_id
            INNER JOIN maps AS owner_map
              ON owner_map.id = link.map_id
              AND owner_map.kit_definition_id = item.kit_definition_id
            WHERE provenance.target_link_id = link.id
              AND provenance.relation_type = CASE owner_map.type
                WHEN 'KB' THEN 'RECONSTRUCTED_FROM'
                WHEN 'INTEGRATION' THEN 'IMPORTED_FROM'
                ELSE NULL
              END
            LIMIT 1
          ) AS "kitLinkItemId"
        FROM links AS link
        INNER JOIN concepts AS source_concept
          ON source_concept.id = link.source_concept_id
          AND source_concept.map_id = link.map_id
          AND source_concept.merged_into_concept_id IS NULL
        INNER JOIN concepts AS target_concept
          ON target_concept.id = link.target_concept_id
          AND target_concept.map_id = link.map_id
          AND target_concept.merged_into_concept_id IS NULL
        WHERE link.map_id = $1::uuid
        ORDER BY link.created_at, link.id
      `,
      [mapId],
    );

    let kitLinks: MapKitLinkRow[] = [];
    if (
      (map.mapType === "KB" || map.mapType === "INTEGRATION") &&
      map.kitDefinitionId !== null
    ) {
      const kitLinksResult = await pool.query<MapKitLinkRow>(
        `
          SELECT
            item.id AS "kitLinkItemId",
            goal_link.label,
            EXISTS (
              SELECT 1
              FROM links AS map_link
              INNER JOIN link_provenance AS provenance
                ON provenance.target_link_id = map_link.id
                AND provenance.relation_type = CASE map_with_kit.type
                  WHEN 'KB' THEN 'RECONSTRUCTED_FROM'
                  WHEN 'INTEGRATION' THEN 'IMPORTED_FROM'
                  ELSE NULL
                END
              WHERE map_link.map_id = map_with_kit.id
                AND provenance.source_link_id = item.source_link_id
            ) AS used
          FROM maps AS map_with_kit
          INNER JOIN kit_link_items AS item
            ON item.kit_definition_id = map_with_kit.kit_definition_id
          INNER JOIN kit_definitions AS kit
            ON kit.id = item.kit_definition_id
          INNER JOIN links AS goal_link
            ON goal_link.id = item.source_link_id
            AND goal_link.map_id = kit.goal_map_id
          WHERE map_with_kit.id = $1::uuid
            AND map_with_kit.type IN ('KB', 'INTEGRATION')
          ORDER BY item.created_at, item.id
        `,
        [mapId],
      );
      kitLinks = kitLinksResult.rows;
    }

    let kitConcepts: MapKitConceptRow[] = [];
    if (
      (map.mapType === "KB" || map.mapType === "INTEGRATION") &&
      map.kitDefinitionId !== null
    ) {
      const kitConceptsResult = await pool.query<MapKitConceptRow>(
        `
          SELECT
            item.id AS "kitConceptItemId",
            source.label,
            EXISTS (
              SELECT 1
              FROM concept_provenance AS provenance
              INNER JOIN concepts AS imported
                ON imported.id = provenance.target_concept_id
              WHERE imported.map_id = integration_map.id
                AND provenance.source_concept_id = source.id
                AND provenance.relation_type = CASE integration_map.type
                  WHEN 'KB' THEN 'CLONED_FROM'
                  WHEN 'INTEGRATION' THEN 'IMPORTED_FROM'
                  ELSE NULL
                END
            ) AS imported
          FROM maps AS integration_map
          INNER JOIN kit_definitions AS kit
            ON kit.id = integration_map.kit_definition_id
          INNER JOIN kit_concept_items AS item
            ON item.kit_definition_id = kit.id
          INNER JOIN concepts AS source
            ON source.id = item.source_concept_id
            AND source.map_id = kit.goal_map_id
          WHERE integration_map.id = $1::uuid
            AND integration_map.type IN ('KB', 'INTEGRATION')
          ORDER BY item.created_at, item.id
        `,
        [mapId],
      );
      kitConcepts = kitConceptsResult.rows;
    }

    let availableKitDefinitions: KitDefinitionOption[] = [];
    if (map.mapType === "INTEGRATION" && map.kitDefinitionId === null) {
      const kitOptionsResult = await pool.query<KitDefinitionOption>(
        `
          SELECT id, name
          FROM kit_definitions
          WHERE id <> $1::uuid
          ORDER BY created_at, id
        `,
        [RETIRED_DEVELOPMENT_KIT_ID],
      );
      const principal = principalOf(response);
      availableKitDefinitions = principal.role === "learner"
        ? kitOptionsResult.rows.filter((kit) => kit.id === principal.kitId)
        : kitOptionsResult.rows;
    }

    return response.json({
      id: map.mapId,
      type: map.mapType,
      status: map.mapStatus,
      title: map.mapTitle,
      createdAt: map.mapCreatedAt,
      submittedAt: map.mapSubmittedAt,
      basedOnMapId: principalOf(response).role === "learner" ? null : map.basedOnMapId,
      kitDefinitionId: map.kitDefinitionId,
      sessionStageId: map.sessionStageId,
      sessionId: map.sessionId,
      sessionStageStatus: map.sessionStageStatus,
      sessionProtocolKey: map.sessionProtocolKey,
      kitDefinitionName: map.kitDefinitionName,
      concepts: result.rows.flatMap((row) =>
        row.conceptId === null
          ? []
          : [
              {
                id: row.conceptId,
                label: row.label,
                positionX: row.positionX,
                positionY: row.positionY,
                createdAt: row.conceptCreatedAt,
                updatedAt: row.conceptUpdatedAt,
                isMergeResult: row.isMergeResult,
              },
            ],
      ),
      links: linksResult.rows,
      kitLinks,
      kitConcepts,
      availableKitDefinitions,
    });
  } catch (error) {
    console.error("Failed to fetch Map", safeServerErrorCode(error));
    return response.status(500).json({
      error: "map_fetch_failed",
      message: "Mapの取得に失敗しました。",
    });
  }
});

app.get("/api/health", async (_request, response) => {
  try {
    const result = await pool.query<{ connected: number }>(
      "SELECT 1 AS connected",
    );
    response.json({
      status: "ok",
      database: result.rows[0]?.connected === 1,
    });
  } catch {
    response.status(503).json({ status: "error", database: false });
  }
});

function isPostgresErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

let autoSubmissionRunning = false;
async function submitExpiredIntegrationMaps() {
  if (autoSubmissionRunning) return;
  autoSubmissionRunning = true;
  try {
    await observeExpiredStages(pool);
    const candidates = await pool.query<{ id: string }>(`SELECT m.id FROM maps m JOIN session_stages st ON m.session_stage_id=st.id JOIN sessions s ON s.id=st.session_id
      WHERE m.type='INTEGRATION' AND m.status='DRAFT'
        AND s.protocol_key='STAGE1_6' AND s.study_group='EXPERIMENTAL' AND s.status='IN_PROGRESS'
        AND st.stage_type='INTEGRATION_MAP' AND st.status='IN_PROGRESS' AND st.started_at IS NOT NULL
        AND st.id=(SELECT current_stage.id FROM session_stages current_stage
          WHERE current_stage.session_id=s.id AND current_stage.status <> 'COMPLETED' ORDER BY current_stage.order_index LIMIT 1)
        AND clock_timestamp() >= st.started_at + s.group_activity_seconds * interval '1 second'`);
    for (const candidate of candidates.rows) {
      try {
        await withTransaction(async client => {
          const map = await lockMapById(client, candidate.id);
          if (!map || map.mapStatus !== "DRAFT") return;
          const hasEvents = (await client.query<{ name: string | null }>("SELECT to_regclass('map_history_boundaries')::text AS name")).rows[0]?.name;
          if (!hasEvents) throw new HistoryTransitionError("操作履歴のDB変更が未適用です。");
          const updated = await client.query(`WITH submission_clock AS (SELECT clock_timestamp() AS submitted_at)
            UPDATE maps m SET status='SUBMITTED', submitted_at=clock.submitted_at, auto_submitted_at=clock.submitted_at
            FROM session_stages st JOIN sessions s ON s.id=st.session_id CROSS JOIN submission_clock clock
            WHERE m.id=$1::uuid AND m.session_stage_id=st.id AND m.type='INTEGRATION' AND m.status='DRAFT'
              AND s.protocol_key='STAGE1_6' AND s.study_group='EXPERIMENTAL' AND s.status='IN_PROGRESS'
              AND st.stage_type='INTEGRATION_MAP' AND st.status='IN_PROGRESS' AND st.started_at IS NOT NULL
              AND st.id=(SELECT current_stage.id FROM session_stages current_stage WHERE current_stage.session_id=s.id AND current_stage.status <> 'COMPLETED' ORDER BY current_stage.order_index LIMIT 1)
              AND clock.submitted_at >= st.started_at + s.group_activity_seconds * interval '1 second' RETURNING m.id`, [candidate.id]);
          if (!updated.rowCount) return;
          await appendMapOperationLog(client, { mapId: candidate.id, operationType: "MAP_AUTO_SUBMIT", targetType: "MAP", targetId: candidate.id, before: null, after: null, clientTimestamp: null });
        });
      } catch {
        const saved=await recordAudit(pool,{eventType:"MAP_AUTO_SUBMIT",mapId:candidate.id},"SYSTEM","FAILURE","SERVER","auto-failure:"+candidate.id).catch(()=>false);
        console.error(saved?"automatic_submission_failed_event_saved":"automatic_submission_failed_event_missing");
      }
    }
  } catch {
    console.error("automatic_submission_scan_failed");
  } finally {
    autoSubmissionRunning = false;
  }
}

const autoSubmissionTimer = setInterval(() => void submitExpiredIntegrationMaps(), 1000);
autoSubmissionTimer.unref();
const server = app.listen(port, process.env.API_BIND_ADDRESS ?? "0.0.0.0", () => {
  void submitExpiredIntegrationMaps();
  console.log(`API listening on port ${port}`);
});

const shutdown = () => {
  clearInterval(autoSubmissionTimer);
  server.close(() => {
    void Promise.all([pool.end(),eventExports.dispose(),eventExportPool.end()]).then(() => process.exit(0));
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
