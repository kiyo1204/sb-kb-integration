import type { PoolClient } from "pg";

const EXPECTED_STAGE_TYPES = [
  "LESSON",
  "PRIOR_MAP",
  "KB_MAP",
  "INTEGRATION_MAP",
] as const;

const MAP_TYPE_BY_STAGE = {
  PRIOR_MAP: "PRIOR",
  KB_MAP: "KB",
  INTEGRATION_MAP: "INTEGRATION",
} as const;

export type SessionRawExportWarning = {
  code: string;
  message: string;
  stageId?: string;
};

export type SessionRawExport = {
  exportVersion: 1;
  exportedAt: string;
  warnings: SessionRawExportWarning[];
  session: {
    id: string;
    status: string;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    protocolKey: string;
    participantCode: string | null;
    lessonVideoUrl: string | null;
    researchKitDefinitionId: string | null;
  };
  stages: Array<Record<string, unknown>>;
  maps: Array<Record<string, unknown>>;
  goalMaps: Array<Record<string, unknown>>;
  kitDefinitions: Array<Record<string, unknown>>;
};

export type SessionRawExportResult =
  | { kind: "not_found" }
  | { kind: "not_completed"; status: string }
  | { kind: "inconsistent"; detail: string }
  | { kind: "exported"; value: SessionRawExport };

type SessionRow = {
  id: string;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  protocolKey: string;
  participantCode: string | null;
  lessonVideoUrl: string | null;
  researchKitDefinitionId: string | null;
};

type StageRow = {
  id: string;
  sessionId: string;
  stageType: string;
  orderIndex: number;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

type MapRow = {
  id: string;
  type: string;
  status: string;
  basedOnMapId: string | null;
  sessionStageId: string | null;
  kitDefinitionId: string | null;
  createdAt: Date;
  submittedAt: Date | null;
};

type ConceptRow = {
  id: string;
  mapId: string;
  label: string;
  positionX: number;
  positionY: number;
  mergedIntoConceptId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type LinkRow = {
  id: string;
  mapId: string;
  sourceConceptId: string;
  targetConceptId: string;
  label: string;
  createdAt: Date;
  updatedAt: Date;
};

function unique(values: Array<string | null>): string[] {
  return [
    ...new Set(values.filter((value): value is string => value !== null)),
  ];
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function assertSameSet(values: string[], expected: readonly string[]) {
  return (
    values.length === expected.length &&
    values.every((value, index) => value === expected[index])
  );
}

export async function buildSessionRawExport(
  client: PoolClient,
  sessionId: string,
): Promise<SessionRawExportResult> {
  const sessionResult = await client.query<SessionRow>(
    `SELECT id, status, created_at AS "createdAt",
            started_at AS "startedAt", completed_at AS "completedAt",
            protocol_key AS "protocolKey",
            participant_code AS "participantCode",
            lesson_video_url AS "lessonVideoUrl",
            research_kit_definition_id AS "researchKitDefinitionId"
     FROM sessions WHERE id = $1::uuid`,
    [sessionId],
  );
  const session = sessionResult.rows[0];
  if (!session) return { kind: "not_found" };
  if (session.protocolKey !== "STAGE1_4") return { kind: "not_found" };
  if (session.status !== "COMPLETED") {
    return { kind: "not_completed", status: session.status };
  }

  const stageResult = await client.query<StageRow>(
    `SELECT id, session_id AS "sessionId", stage_type AS "stageType",
            order_index AS "orderIndex", status,
            started_at AS "startedAt", completed_at AS "completedAt",
            created_at AS "createdAt"
     FROM session_stages
     WHERE session_id = $1::uuid
     ORDER BY order_index ASC, id ASC`,
    [sessionId],
  );
  const stages = stageResult.rows;
  if (
    !assertSameSet(
      stages.map((stage) => stage.stageType),
      EXPECTED_STAGE_TYPES,
    ) ||
    stages.some(
      (stage, index) =>
        stage.orderIndex !== index ||
        stage.status !== "COMPLETED" ||
        !stage.startedAt ||
        !stage.completedAt,
    )
  ) {
    return {
      kind: "inconsistent",
      detail: "COMPLETED Stage 1 Session does not have four ordered completed stages.",
    };
  }

  const stageIds = stages.map((stage) => stage.id);
  const assignedMapResult = await client.query<MapRow>(
    `SELECT id, type, status, based_on_map_id AS "basedOnMapId",
            session_stage_id AS "sessionStageId",
            kit_definition_id AS "kitDefinitionId",
            created_at AS "createdAt", submitted_at AS "submittedAt"
     FROM maps
     WHERE session_stage_id = ANY($1::uuid[])
     ORDER BY session_stage_id ASC, created_at ASC, id ASC`,
    [stageIds],
  );
  const sessionMaps = assignedMapResult.rows;
  const stageOrderById = new Map(
    stages.map((stage) => [stage.id, stage.orderIndex]),
  );
  sessionMaps.sort(
    (left, right) =>
      (stageOrderById.get(left.sessionStageId ?? "") ??
        Number.MAX_SAFE_INTEGER) -
      (stageOrderById.get(right.sessionStageId ?? "") ??
        Number.MAX_SAFE_INTEGER),
  );
  const mapByStageId = new Map(
    sessionMaps.map((map) => [map.sessionStageId, map]),
  );
  const warnings: SessionRawExportWarning[] = [];

  for (const stage of stages) {
    const expectedMapType =
      MAP_TYPE_BY_STAGE[stage.stageType as keyof typeof MAP_TYPE_BY_STAGE];
    const map = mapByStageId.get(stage.id);
    if (!expectedMapType) {
      if (map) {
        return {
          kind: "inconsistent",
          detail: `Non-map stage ${stage.id} unexpectedly has a Map.`,
        };
      }
      continue;
    }
    if (!map) {
      warnings.push({
        code: "MISSING_MAP_FOR_STAGE",
        message: `No Map is associated with completed ${stage.stageType} stage.`,
        stageId: stage.id,
      });
      continue;
    }
    if (map.type !== expectedMapType) {
      return {
        kind: "inconsistent",
        detail: `Map ${map.id} has type ${map.type}; expected ${expectedMapType}.`,
      };
    }
    if (map.status !== "SUBMITTED" || !map.submittedAt) {
      return {
        kind: "inconsistent",
        detail: `Map ${map.id} is not submitted although its Session is completed.`,
      };
    }
  }

  const kitIds = unique(sessionMaps.map((map) => map.kitDefinitionId));
  const kitResult = kitIds.length
    ? await client.query<{
        id: string;
        goalMapId: string;
        name: string;
        createdAt: Date;
      }>(
        `SELECT id, goal_map_id AS "goalMapId", name,
                created_at AS "createdAt"
         FROM kit_definitions
         WHERE id = ANY($1::uuid[])
         ORDER BY id ASC`,
        [kitIds],
      )
    : { rows: [] };
  if (kitResult.rows.length !== kitIds.length) {
    return {
      kind: "inconsistent",
      detail: "A Session Map references a missing KitDefinition.",
    };
  }

  const goalMapIds = unique(kitResult.rows.map((kit) => kit.goalMapId));
  const goalMapResult = goalMapIds.length
    ? await client.query<MapRow>(
        `SELECT id, type, status, based_on_map_id AS "basedOnMapId",
                session_stage_id AS "sessionStageId",
                kit_definition_id AS "kitDefinitionId",
                created_at AS "createdAt", submitted_at AS "submittedAt"
         FROM maps WHERE id = ANY($1::uuid[])
         ORDER BY id ASC`,
        [goalMapIds],
      )
    : { rows: [] };
  if (goalMapResult.rows.length !== goalMapIds.length) {
    return {
      kind: "inconsistent",
      detail: "A KitDefinition references a missing Goal Map.",
    };
  }
  if (goalMapResult.rows.some((map) => map.type !== "GOAL")) {
    return {
      kind: "inconsistent",
      detail: "A KitDefinition source Map is not a GOAL Map.",
    };
  }

  const allMaps = [...sessionMaps, ...goalMapResult.rows].filter(
    (map, index, values) =>
      values.findIndex((item) => item.id === map.id) === index,
  );
  const allMapIds = allMaps.map((map) => map.id);
  const conceptsResult = allMapIds.length
    ? await client.query<ConceptRow>(
        `SELECT id, map_id AS "mapId", label, position_x AS "positionX",
                position_y AS "positionY",
                merged_into_concept_id AS "mergedIntoConceptId",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM concepts
         WHERE map_id = ANY($1::uuid[])
         ORDER BY map_id ASC, created_at ASC, id ASC`,
        [allMapIds],
      )
    : { rows: [] };
  const concepts = conceptsResult.rows;
  const conceptIds = concepts.map((concept) => concept.id);

  const linksResult = allMapIds.length
    ? await client.query<LinkRow>(
        `SELECT id, map_id AS "mapId",
                source_concept_id AS "sourceConceptId",
                target_concept_id AS "targetConceptId", label,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM links
         WHERE map_id = ANY($1::uuid[])
         ORDER BY map_id ASC, created_at ASC, id ASC`,
        [allMapIds],
      )
    : { rows: [] };
  const links = linksResult.rows;
  const linkIds = links.map((link) => link.id);

  const conceptProvenanceResult = conceptIds.length
    ? await client.query<{
        id: string;
        targetConceptId: string;
        sourceConceptId: string;
        relationType: string;
        createdAt: Date;
      }>(
        `SELECT id, target_concept_id AS "targetConceptId",
                source_concept_id AS "sourceConceptId",
                relation_type AS "relationType", created_at AS "createdAt"
         FROM concept_provenance
         WHERE target_concept_id = ANY($1::uuid[])
         ORDER BY created_at ASC, id ASC`,
        [conceptIds],
      )
    : { rows: [] };
  const linkProvenanceResult = linkIds.length
    ? await client.query<{
        id: string;
        targetLinkId: string;
        sourceLinkId: string;
        relationType: string;
        createdAt: Date;
      }>(
        `SELECT id, target_link_id AS "targetLinkId",
                source_link_id AS "sourceLinkId",
                relation_type AS "relationType", created_at AS "createdAt"
         FROM link_provenance
         WHERE target_link_id = ANY($1::uuid[])
         ORDER BY created_at ASC, id ASC`,
        [linkIds],
      )
    : { rows: [] };
  const operationLogResult = allMapIds.length
    ? await client.query<{
        id: string;
        mapId: string;
        operationType: string;
        targetType: string;
        targetId: string;
        before: unknown;
        after: unknown;
        sequenceNumber: string;
        relatedOperationLogId: string | null;
        clientTimestamp: Date | null;
        serverTimestamp: Date;
      }>(
        `SELECT id, map_id AS "mapId", operation_type AS "operationType",
                target_type AS "targetType", target_id AS "targetId",
                before, after, sequence_number AS "sequenceNumber",
                related_operation_log_id AS "relatedOperationLogId",
                client_timestamp AS "clientTimestamp",
                server_timestamp AS "serverTimestamp"
         FROM map_operation_logs
         WHERE map_id = ANY($1::uuid[])
         ORDER BY map_id ASC, sequence_number ASC, id ASC`,
        [allMapIds],
      )
    : { rows: [] };

  const conceptProvenanceByTarget = new Map<
    string,
    Array<Record<string, unknown>>
  >();
  for (const item of conceptProvenanceResult.rows) {
    const entries = conceptProvenanceByTarget.get(item.targetConceptId) ?? [];
    entries.push({
      id: item.id,
      targetConceptId: item.targetConceptId,
      sourceConceptId: item.sourceConceptId,
      relationType: item.relationType,
      createdAt: iso(item.createdAt),
    });
    conceptProvenanceByTarget.set(item.targetConceptId, entries);
  }
  const linkProvenanceByTarget = new Map<
    string,
    Array<Record<string, unknown>>
  >();
  for (const item of linkProvenanceResult.rows) {
    const entries = linkProvenanceByTarget.get(item.targetLinkId) ?? [];
    entries.push({
      id: item.id,
      targetLinkId: item.targetLinkId,
      sourceLinkId: item.sourceLinkId,
      relationType: item.relationType,
      createdAt: iso(item.createdAt),
    });
    linkProvenanceByTarget.set(item.targetLinkId, entries);
  }
  const logsByMap = new Map<string, Array<Record<string, unknown>>>();
  for (const log of operationLogResult.rows) {
    const entries = logsByMap.get(log.mapId) ?? [];
    entries.push({
      id: log.id,
      mapId: log.mapId,
      operationType: log.operationType,
      targetType: log.targetType,
      targetId: log.targetId,
      before: log.before,
      after: log.after,
      sequenceNumber: log.sequenceNumber,
      relatedOperationLogId: log.relatedOperationLogId,
      clientTimestamp: iso(log.clientTimestamp),
      serverTimestamp: iso(log.serverTimestamp),
    });
    logsByMap.set(log.mapId, entries);
  }

  const conceptsByMap = new Map<string, Array<Record<string, unknown>>>();
  for (const concept of concepts) {
    const entries = conceptsByMap.get(concept.mapId) ?? [];
    entries.push({
      id: concept.id,
      mapId: concept.mapId,
      label: concept.label,
      positionX: concept.positionX,
      positionY: concept.positionY,
      mergedIntoConceptId: concept.mergedIntoConceptId,
      createdAt: iso(concept.createdAt),
      updatedAt: iso(concept.updatedAt),
      provenance: conceptProvenanceByTarget.get(concept.id) ?? [],
    });
    conceptsByMap.set(concept.mapId, entries);
  }
  const linksByMap = new Map<string, Array<Record<string, unknown>>>();
  for (const link of links) {
    const entries = linksByMap.get(link.mapId) ?? [];
    entries.push({
      id: link.id,
      mapId: link.mapId,
      sourceConceptId: link.sourceConceptId,
      targetConceptId: link.targetConceptId,
      label: link.label,
      createdAt: iso(link.createdAt),
      updatedAt: iso(link.updatedAt),
      provenance: linkProvenanceByTarget.get(link.id) ?? [],
    });
    linksByMap.set(link.mapId, entries);
  }

  const initialSnapshotResult = allMapIds.length
    ? await client.query<{
        mapId: string;
        snapshotVersion: number;
        snapshot: unknown;
        capturedAt: Date;
      }>(
        `SELECT map_id AS "mapId", snapshot_version AS "snapshotVersion",
                snapshot, captured_at AS "capturedAt"
         FROM map_initial_snapshots WHERE map_id = ANY($1::uuid[])
         ORDER BY map_id`,
        [allMapIds],
      )
    : { rows: [] };
  const initialSnapshotsByMap = new Map(
    initialSnapshotResult.rows.map((item) => [item.mapId, item]),
  );

  const rawMaps = allMaps.map((map) => {
    const history = initialSnapshotsByMap.get(map.id);
    return {
    id: map.id,
    type: map.type,
    status: map.status,
    basedOnMapId: map.basedOnMapId,
    sessionStageId: map.sessionStageId,
    kitDefinitionId: map.kitDefinitionId,
    createdAt: iso(map.createdAt),
    submittedAt: iso(map.submittedAt),
    concepts: conceptsByMap.get(map.id) ?? [],
    links: linksByMap.get(map.id) ?? [],
    operationLogs: logsByMap.get(map.id) ?? [],
    historySnapshotVersion: history?.snapshotVersion ?? null,
    initialSnapshot: history?.snapshot ?? null,
    initialSnapshotCapturedAt: history ? iso(history.capturedAt) : null,
  };
  });
  const conceptItemsResult = kitIds.length
    ? await client.query<{
        id: string;
        kitDefinitionId: string;
        sourceConceptId: string;
        createdAt: Date;
      }>(
        `SELECT id, kit_definition_id AS "kitDefinitionId",
                source_concept_id AS "sourceConceptId", created_at AS "createdAt"
         FROM kit_concept_items
         WHERE kit_definition_id = ANY($1::uuid[])
         ORDER BY kit_definition_id ASC, created_at ASC, id ASC`,
        [kitIds],
      )
    : { rows: [] };
  const linkItemsResult = kitIds.length
    ? await client.query<{
        id: string;
        kitDefinitionId: string;
        sourceLinkId: string;
        createdAt: Date;
      }>(
        `SELECT id, kit_definition_id AS "kitDefinitionId",
                source_link_id AS "sourceLinkId", created_at AS "createdAt"
         FROM kit_link_items
         WHERE kit_definition_id = ANY($1::uuid[])
         ORDER BY kit_definition_id ASC, created_at ASC, id ASC`,
        [kitIds],
      )
    : { rows: [] };

  const kits = kitResult.rows.map((kit) => ({
    id: kit.id,
    goalMapId: kit.goalMapId,
    name: kit.name,
    createdAt: iso(kit.createdAt),
    conceptItems: conceptItemsResult.rows
      .filter((item) => item.kitDefinitionId === kit.id)
      .map((item) => ({
        id: item.id,
        kitDefinitionId: item.kitDefinitionId,
        sourceConceptId: item.sourceConceptId,
        createdAt: iso(item.createdAt),
      })),
    linkItems: linkItemsResult.rows
      .filter((item) => item.kitDefinitionId === kit.id)
      .map((item) => ({
        id: item.id,
        kitDefinitionId: item.kitDefinitionId,
        sourceLinkId: item.sourceLinkId,
        createdAt: iso(item.createdAt),
      })),
  }));

  const exportedAtResult = await client.query<{ exportedAt: Date }>(
    `SELECT transaction_timestamp() AS "exportedAt"`,
  );
  const exportedAt = exportedAtResult.rows[0]?.exportedAt;
  if (!exportedAt) {
    return { kind: "inconsistent", detail: "Could not read export timestamp." };
  }

  const mapsWithProvenance = rawMaps.map((map) => ({
    ...map,
    conceptProvenance: conceptProvenanceResult.rows
      .filter((item) =>
        concepts.some(
          (concept) =>
            concept.id === item.targetConceptId && concept.mapId === map.id,
        ),
      )
      .map((item) => ({
        id: item.id,
        targetConceptId: item.targetConceptId,
        sourceConceptId: item.sourceConceptId,
        relationType: item.relationType,
        createdAt: iso(item.createdAt),
      })),
    linkProvenance: linkProvenanceResult.rows
      .filter((item) =>
        links.some(
          (link) => link.id === item.targetLinkId && link.mapId === map.id,
        ),
      )
      .map((item) => ({
        id: item.id,
        targetLinkId: item.targetLinkId,
        sourceLinkId: item.sourceLinkId,
        relationType: item.relationType,
        createdAt: iso(item.createdAt),
      })),
  }));

  return {
    kind: "exported",
    value: {
      exportVersion: 1,
      exportedAt: exportedAt.toISOString(),
      warnings,
      session: {
        id: session.id,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
        startedAt: iso(session.startedAt),
        completedAt: iso(session.completedAt),
        protocolKey: session.protocolKey,
        participantCode: session.participantCode,
        lessonVideoUrl: session.lessonVideoUrl,
        researchKitDefinitionId: session.researchKitDefinitionId,
      },
      stages: stages.map((stage) => ({
        id: stage.id,
        sessionId: stage.sessionId,
        stageType: stage.stageType,
        orderIndex: stage.orderIndex,
        status: stage.status,
        startedAt: iso(stage.startedAt),
        completedAt: iso(stage.completedAt),
        createdAt: iso(stage.createdAt),
        mapId: mapByStageId.get(stage.id)?.id ?? null,
      })),
      maps: mapsWithProvenance
        .filter((map) => map.sessionStageId !== null)
        .map((map) => ({
          ...map,
          researchRole: map.type === "PRIOR" ? "learner_map"
            : map.type === "KB" ? "kitbuild_map"
            : map.type === "INTEGRATION" ? "integration_map" : null,
        })),
      goalMaps: mapsWithProvenance.filter((map) => map.type === "GOAL"),
      kitDefinitions: kits,
    },
  };
}
