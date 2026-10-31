import type { Pool, PoolClient } from "pg";

export const STAGE1_PROTOCOL_KEY = "STAGE1_4" as const;

export type SessionStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
export type SessionStageStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED";
export type SessionStageType =
  | "PRIOR_MAP"
  | "LESSON"
  | "KB_MAP"
  | "INTEGRATION_MAP" | "PRE_ASSESSMENT" | "POST_ASSESSMENT" | "SELF_STUDY";

export type SessionMapType = "PRIOR" | "KB" | "INTEGRATION";

export const SESSION_STAGE_TYPES_BY_MAP_TYPE = {
  PRIOR: "PRIOR_MAP",
  KB: "KB_MAP",
  INTEGRATION: "INTEGRATION_MAP",
} as const satisfies Record<SessionMapType, SessionStageType>;

export type LockedSessionStageForMap = {
  id: string;
  sessionId: string;
  stageType: SessionStageType;
  status: SessionStageStatus;
  orderIndex: number;
  currentStageId: string | null;
  mapId: string | null;
  sessionStatus: SessionStatus;
};

export type LockedSessionStageProgress = {
  id: string;
  sessionId: string;
  stageType: SessionStageType;
  orderIndex: number;
  status: SessionStageStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  sessionStatus: SessionStatus;
};

export type SessionStageMapValidation =
  | { kind: "ready"; stage: LockedSessionStageForMap }
  | { kind: "not_found" }
  | { kind: "type_mismatch"; stageType: SessionStageType }
  | { kind: "already_assigned"; stage: LockedSessionStageForMap }
  | { kind: "session_not_in_progress"; sessionStatus: SessionStatus }
  | { kind: "stage_not_current"; currentStageId: string | null }
  | { kind: "stage_not_in_progress"; status: SessionStageStatus };

// Locking the Stage serializes competing Map creation requests for that Stage.
// The unique maps.session_stage_id constraint remains the final DB guard.
export async function lockSessionStageForMap(
  client: PoolClient,
  stageId: string,
  expectedMapType: SessionMapType,
): Promise<SessionStageMapValidation> {
  const expectedStageType = SESSION_STAGE_TYPES_BY_MAP_TYPE[expectedMapType];
  const result = await client.query<LockedSessionStageForMap>(
    `
      SELECT
        stage.id,
        stage.session_id AS "sessionId",
        stage.stage_type AS "stageType",
        stage.status,
        stage.order_index AS "orderIndex",
        current_stage.id AS "currentStageId",
        map.id AS "mapId",
        session.status AS "sessionStatus"
      FROM session_stages AS stage
      INNER JOIN sessions AS session ON session.id = stage.session_id
      LEFT JOIN maps AS map ON map.session_stage_id = stage.id
      LEFT JOIN LATERAL (
        SELECT candidate.id
        FROM session_stages AS candidate
        WHERE candidate.session_id = stage.session_id
          AND candidate.status <> 'COMPLETED'
        ORDER BY candidate.order_index
        LIMIT 1
      ) AS current_stage ON true
      WHERE stage.id = $1::uuid
        AND session.protocol_key IN ($2, 'STAGE1_6')
      FOR UPDATE OF session, stage
    `,
    [stageId, STAGE1_PROTOCOL_KEY],
  );
  const stage = result.rows[0];
  if (!stage) return { kind: "not_found" };
  if (stage.stageType !== expectedStageType) {
    return { kind: "type_mismatch", stageType: stage.stageType };
  }
  if (stage.sessionStatus !== "IN_PROGRESS") {
    return {
      kind: "session_not_in_progress",
      sessionStatus: stage.sessionStatus,
    };
  }
  if (stage.currentStageId !== stage.id) {
    return {
      kind: "stage_not_current",
      currentStageId: stage.currentStageId,
    };
  }
  if (stage.status !== "IN_PROGRESS") {
    return { kind: "stage_not_in_progress", status: stage.status };
  }
  if (stage.mapId !== null) return { kind: "already_assigned", stage };
  return { kind: "ready", stage };
}

// A lifecycle transition must serialize with other transitions for the same
// Stage and observe the owning Session's status in the same transaction.
// IDs are unchanged: NO KEY UPDATE excludes concurrent writers while letting
// research_events FK checks finish without a Stage/Session -> counter cycle.
export async function lockSessionStageProgress(
  client: PoolClient,
  stageId: string,
): Promise<LockedSessionStageProgress | null> {
  const result = await client.query<LockedSessionStageProgress>(
    `
      SELECT
        stage.id,
        stage.session_id AS "sessionId",
        stage.stage_type AS "stageType",
        stage.order_index AS "orderIndex",
        stage.status,
        stage.started_at AS "startedAt",
        stage.completed_at AS "completedAt",
        session.status AS "sessionStatus"
      FROM session_stages AS stage
      INNER JOIN sessions AS session ON session.id = stage.session_id
      WHERE stage.id = $1::uuid
        AND session.protocol_key IN ($2, 'STAGE1_6')
      FOR NO KEY UPDATE OF session, stage
    `,
    [stageId, STAGE1_PROTOCOL_KEY],
  );
  return result.rows[0] ?? null;
}

export type SessionStage = {
  id: string;
  sessionId: string;
  stageType: SessionStageType;
  orderIndex: number;
  status: SessionStageStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  mapId: string | null;
};

export type Session = {
  id: string;
  status: SessionStatus;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  protocolKey: string;
  participantCode: string | null;
  lessonVideoUrl: string | null;
  researchKitDefinitionId: string | null;
  studyGroup: "EXPERIMENTAL" | "CONTROL" | null;
  groupActivitySeconds: number | null;
  stages: SessionStage[];
};

export type SessionFlow = {
  session: Omit<Session, "stages">;
  stages: SessionStage[];
  currentStage: SessionStage | null;
  nextStage: SessionStage | null;
};

export type CurrentStageValidation =
  | { kind: "ready"; currentStageId: string }
  | { kind: "session_not_in_progress"; sessionStatus: SessionStatus }
  | { kind: "stage_not_current"; currentStageId: string | null };

type SessionStageJoinRow = Omit<Session, "stages"> & {
  stageId: string | null;
  stageSessionId: string;
  stageType: SessionStageType;
  orderIndex: number;
  stageStatus: SessionStageStatus;
  stageStartedAt: Date | null;
  stageCompletedAt: Date | null;
  stageCreatedAt: Date;
  mapId: string | null;
};

export async function getSession(
  client: Pool | PoolClient,
  sessionId: string,
): Promise<Session | null> {
  // One query keeps the Session and its Stage list in the same DB snapshot.
  const result = await client.query<SessionStageJoinRow>(
    `
      SELECT
        session.id,
        session.status,
        session.created_at AS "createdAt",
        session.started_at AS "startedAt",
        session.completed_at AS "completedAt",
        session.protocol_key AS "protocolKey",
        session.participant_code AS "participantCode",
        session.lesson_video_url AS "lessonVideoUrl",
        session.research_kit_definition_id AS "researchKitDefinitionId",
        session.study_group AS "studyGroup", session.group_activity_seconds AS "groupActivitySeconds",
        stage.id AS "stageId",
        stage.session_id AS "stageSessionId",
        stage.stage_type AS "stageType",
        stage.order_index AS "orderIndex",
        stage.status AS "stageStatus",
        stage.started_at AS "stageStartedAt",
        stage.completed_at AS "stageCompletedAt",
        stage.created_at AS "stageCreatedAt",
        map.id AS "mapId"
      FROM sessions AS session
      LEFT JOIN session_stages AS stage ON stage.session_id = session.id
      LEFT JOIN maps AS map ON map.session_stage_id = stage.id
      WHERE session.id = $1::uuid
        AND session.protocol_key IN ($2, 'STAGE1_6')
      ORDER BY stage.order_index
    `,
    [sessionId, STAGE1_PROTOCOL_KEY],
  );
  const session = result.rows[0];
  if (!session) return null;

  return {
    id: session.id,
    status: session.status,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    protocolKey: session.protocolKey,
    participantCode: session.participantCode,
    lessonVideoUrl: session.lessonVideoUrl,
    researchKitDefinitionId: session.researchKitDefinitionId,
    studyGroup: session.studyGroup, groupActivitySeconds: session.groupActivitySeconds,
    stages: result.rows.flatMap((stage) =>
      stage.stageId === null
        ? []
        : [
            {
              id: stage.stageId,
              sessionId: stage.stageSessionId,
              stageType: stage.stageType,
              orderIndex: stage.orderIndex,
              status: stage.stageStatus,
              startedAt: stage.stageStartedAt,
              completedAt: stage.stageCompletedAt,
              createdAt: stage.stageCreatedAt,
              mapId: stage.mapId,
            },
          ],
    ),
  };
}

export async function getCurrentStage(
  client: Pool | PoolClient,
  sessionId: string,
): Promise<Pick<SessionStage, "id" | "orderIndex"> | null> {
  const result = await client.query<Pick<SessionStage, "id" | "orderIndex">>(
    `
      SELECT id, order_index AS "orderIndex"
      FROM session_stages
      WHERE session_id = $1::uuid AND status <> 'COMPLETED'
      ORDER BY order_index
      LIMIT 1
    `,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export async function getSessionFlow(
  client: Pool | PoolClient,
  sessionId: string,
): Promise<SessionFlow | null> {
  const session = await getSession(client, sessionId);
  if (!session) return null;

  const currentStage =
    session.status === "IN_PROGRESS"
      ? (session.stages.find((stage) => stage.status !== "COMPLETED") ?? null)
      : null;
  const nextStage = currentStage
    ? (session.stages.find(
        (stage) => stage.orderIndex > currentStage.orderIndex,
      ) ?? null)
    : null;

  const { stages, ...sessionSummary } = session;
  return {
    session: sessionSummary,
    stages,
    currentStage,
    nextStage,
  };
}

export async function assertStageIsCurrent(
  client: PoolClient,
  stage: Pick<LockedSessionStageProgress, "id" | "sessionId" | "sessionStatus">,
): Promise<CurrentStageValidation> {
  if (stage.sessionStatus !== "IN_PROGRESS") {
    return {
      kind: "session_not_in_progress",
      sessionStatus: stage.sessionStatus,
    };
  }

  const current = await getCurrentStage(client, stage.sessionId);
  if (!current || current.id !== stage.id) {
    return {
      kind: "stage_not_current",
      currentStageId: current?.id ?? null,
    };
  }

  return { kind: "ready", currentStageId: current.id };
}

/**
 * Stage 1 uses PRIOR_MAP as the post-lesson Scratch-Build map.
 * New sessions use the six-activity protocol; existing four-stage sessions stay unchanged.
 */
export async function createStage1Session(
  client: PoolClient,
  input: {
    participantCode: string;
    lessonVideoUrl: string;
    kitDefinitionId: string;
    studyGroup: "EXPERIMENTAL" | "CONTROL";
    groupActivitySeconds: number;
  },
): Promise<Session> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO sessions (
       protocol_key, participant_code, lesson_video_url, research_kit_definition_id, study_group, group_activity_seconds
     ) VALUES ($1, $2, $3, $4::uuid, $5, $6) RETURNING id`,
    ["STAGE1_6", input.participantCode, input.lessonVideoUrl, input.kitDefinitionId, input.studyGroup, input.groupActivitySeconds],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Stage1 Session insert returned no row");
  const steps = ["LESSON", "PRIOR_MAP", "KB_MAP", "PRE_ASSESSMENT", input.studyGroup === "EXPERIMENTAL" ? "INTEGRATION_MAP" : "SELF_STUDY", "POST_ASSESSMENT"] as const;
  for (let index = 0; index < steps.length; index += 1) {
    await client.query(
      `INSERT INTO session_stages (session_id, stage_type, order_index)
       VALUES ($1::uuid, $2, $3)`,
      [id, steps[index], index],
    );
  }
  const session = await getSession(client, id);
  if (!session) throw new Error("New Stage1 Session could not be retrieved");
  return session;
}
