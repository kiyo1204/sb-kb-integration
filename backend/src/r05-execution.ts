import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { digest, isUuid } from "./delivery-reliability.js";
import {
  R05StorageError,
  mutateR05Storage,
  readR05Test,
} from "./r05-storage.js";
import { loadResearchTextSafety } from "./research-output-safety.js";
import { validMapLabel, mapStateLabels } from "./research-event-map-v2.js";
import {
  validateMapStateV5,
  validMapCoordinate,
} from "./research-event-map-v5.js";
import type {
  HistoryConcept,
  MapHistorySnapshot,
  HistoryOperation,
} from "./map-history.js";
import { deriveUndoRedoAvailability } from "./map-undo-redo.js";
import { releaseMerge } from "./merge-release.js";
import { readKitBuildFeedbackWithSignature } from "./kit-build-feedback.js";
type Actor = { role: string };
type Data = Record<string, unknown>;
type Command = {
  action: string;
  executionId: string;
  expectedRevision: number;
  data?: Data;
};
function fail(code: string, status = 409): never {
  throw new R05StorageError(code, status);
}
const researcher = (a: Actor) => {
  if (a.role !== "researcher") fail("forbidden", 403);
};
const label = (v: unknown) => {
  if (!validMapLabel(v)) fail("invalid_label", 422);
  return v as string;
};
const point = (v: unknown) => {
  if (!validMapCoordinate(v)) fail("invalid_position", 422);
  return v as number;
};
export async function r05Material(c: PoolClient, version: string) {
  const row = (
    await c.query(
      `SELECT v.body,v.foundation_version_id FROM material_catalog_versions v WHERE v.id=$1 AND v.state='PUBLISHED'`,
      [version],
    )
  ).rows[0];
  if (!row) fail("published_material_required");
  const b = row.body as {
    title: string;
    videoRef: string;
    sbInstructions: string;
    kbInstructions: string;
    integrationInstructions: string;
    kitId: string;
    seedConceptItemIds: string[];
    integrationSeconds: number;
  };
  const concepts = (
    await c.query(
      `SELECT i.id,c.id AS "sourceId",c.label,c.position_x AS "positionX",c.position_y AS "positionY" FROM public.kit_concept_items i JOIN public.concepts c ON c.id=i.source_concept_id WHERE i.kit_definition_id=$1 ORDER BY i.id`,
      [b.kitId],
    )
  ).rows as {
    id: string;
    sourceId: string;
    label: string;
    positionX: number;
    positionY: number;
  }[];
  const links = (
    await c.query(
      `SELECT i.id,l.id AS "sourceId",l.label,l.source_concept_id AS "sourceConceptId",l.target_concept_id AS "targetConceptId" FROM public.kit_link_items i JOIN public.links l ON l.id=i.source_link_id WHERE i.kit_definition_id=$1 ORDER BY i.id`,
      [b.kitId],
    )
  ).rows as {
    id: string;
    sourceId: string;
    label: string;
    sourceConceptId: string;
    targetConceptId: string;
  }[];
  return { body: b, concepts, links };
}
function clonedConcept(
  id: string,
  mapId: string,
  label: string,
  x: number,
  y: number,
  source?: string,
  relation = "CLONED_FROM",
): HistoryConcept {
  return {
    id,
    mapId,
    label,
    positionX: x,
    positionY: y,
    mergedIntoConceptId: null,
    provenance: source
      ? [
          {
            id: randomUUID(),
            targetConceptId: id,
            sourceConceptId: source,
            relationType: relation,
            createdAt: new Date().toISOString(),
          },
        ]
      : [],
  };
}
async function createMap(
  c: PoolClient,
  run: string,
  kind: string,
  version: string,
) {
  const m = await r05Material(c, version),
    id = randomUUID();
  const state: MapHistorySnapshot = {
    snapshotVersion: 1,
    mapId: id,
    mapType: kind === "SB" ? "PRIOR" : kind,
    basedOnMapId: null,
    kitDefinitionId: m.body.kitId,
    concepts: [],
    links: [],
  };
  if (kind === "SB")
    state.concepts = m.concepts
      .filter((x) => m.body.seedConceptItemIds.includes(x.id))
      .map((x) =>
        clonedConcept(
          randomUUID(),
          id,
          x.label,
          x.positionX,
          x.positionY,
          x.sourceId,
        ),
      );
  if (kind === "INTEGRATION") {
    const sb = (
      await c.query(
        `SELECT state,id FROM r05_test_maps WHERE test_run_id=$1 AND map_kind='SB' AND submitted_at IS NOT NULL`,
        [run],
      )
    ).rows[0];
    if (!sb) fail("submitted_sb_required");
    state.basedOnMapId = sb.id;
    const source = sb.state as MapHistorySnapshot,
      ids = new Map(source.concepts.map((x) => [x.id, randomUUID()]));
    state.concepts = source.concepts.map((x) => ({
      ...clonedConcept(
        ids.get(x.id)!,
        id,
        x.label,
        x.positionX,
        x.positionY,
        x.id,
      ),
      mergedIntoConceptId: x.mergedIntoConceptId
        ? ids.get(x.mergedIntoConceptId)!
        : null,
    }));
    state.links = source.links.map((x) => {
      const lid = randomUUID();
      return {
        ...x,
        id: lid,
        mapId: id,
        sourceConceptId: ids.get(x.sourceConceptId)!,
        targetConceptId: ids.get(x.targetConceptId)!,
        provenance: [
          {
            id: randomUUID(),
            targetLinkId: lid,
            sourceLinkId: x.id,
            relationType: "CLONED_FROM",
            createdAt: new Date().toISOString(),
          },
        ],
      };
    });
  }
  if (!validateMapStateV5(state, id)) fail("initial_map_invalid");
  const safety = await loadResearchTextSafety(c);
  if (mapStateLabels(state).some((x) => safety.containsSecret(x)))
    fail("sensitive_text", 422);
  await c.query(
    "INSERT INTO r05_test_maps(id,test_run_id,map_kind,state,initial_state) VALUES($1,$2,$3,$4,$4)",
    [id, run, kind, state],
  );
}
// Reuse the exact existing matcher against connection-local shadow tables only.
// Goal rows are copied read-only from the pinned Kit. ON COMMIT DROP + SET LOCAL
// prevent connection-pool leakage and no public research row is written.
async function feedback(c: PoolClient, state: MapHistorySnapshot) {
  await c.query(`CREATE TEMP TABLE maps(id uuid,type text,kit_definition_id uuid) ON COMMIT DROP;
 CREATE TEMP TABLE concepts(id uuid,map_id uuid,label text,merged_into_concept_id uuid) ON COMMIT DROP;
 CREATE TEMP TABLE links(id uuid,map_id uuid,label text,source_concept_id uuid,target_concept_id uuid) ON COMMIT DROP;
 CREATE TEMP TABLE concept_provenance(target_concept_id uuid,source_concept_id uuid,relation_type text) ON COMMIT DROP;
 CREATE TEMP TABLE link_provenance(target_link_id uuid,source_link_id uuid,relation_type text) ON COMMIT DROP;
 SET LOCAL search_path=pg_temp,public;`);
  await c.query(
    `INSERT INTO pg_temp.concepts SELECT c.id,c.map_id,c.label,c.merged_into_concept_id FROM public.concepts c JOIN public.kit_definitions k ON k.goal_map_id=c.map_id WHERE k.id=$1`,
    [state.kitDefinitionId],
  );
  await c.query(
    `INSERT INTO pg_temp.links SELECT l.id,l.map_id,l.label,l.source_concept_id,l.target_concept_id FROM public.links l JOIN public.kit_definitions k ON k.goal_map_id=l.map_id WHERE k.id=$1`,
    [state.kitDefinitionId],
  );
  await c.query("INSERT INTO pg_temp.maps VALUES($1,'KB',$2)", [
    state.mapId,
    state.kitDefinitionId,
  ]);
  for (const x of state.concepts) {
    await c.query("INSERT INTO pg_temp.concepts VALUES($1,$2,$3,$4)", [
      x.id,
      x.mapId,
      x.label,
      x.mergedIntoConceptId,
    ]);
    for (const p of x.provenance)
      await c.query("INSERT INTO pg_temp.concept_provenance VALUES($1,$2,$3)", [
        x.id,
        p.sourceConceptId,
        p.relationType,
      ]);
  }
  for (const x of state.links) {
    await c.query("INSERT INTO pg_temp.links VALUES($1,$2,$3,$4,$5)", [
      x.id,
      x.mapId,
      x.label,
      x.sourceConceptId,
      x.targetConceptId,
    ]);
    for (const p of x.provenance)
      await c.query("INSERT INTO pg_temp.link_provenance VALUES($1,$2,$3)", [
        x.id,
        p.sourceLinkId,
        p.relationType,
      ]);
  }
  const f = await readKitBuildFeedbackWithSignature(c, state.mapId);
  if (!f) fail("feedback_unavailable");
  return f;
}
export async function startR05(
  pool: Pool,
  actor: Actor,
  version: string,
  key: string,
  executionId: string,
) {
  researcher(actor);
  if (!isUuid(executionId)) fail("invalid_request", 400);
  return mutateR05Storage(
    pool,
    actor,
    "CREATE",
    key,
    version,
    { executionId },
    async (c, id) => {
      await r05Material(c, version);
      await c.query(
        `INSERT INTO r05_execution(test_run_id,execution_id,phase) VALUES($1,$2,'LESSON')`,
        [id, executionId],
      );
    },
  );
}
export async function viewR05(pool: Pool, actor: Actor, version: string) {
  researcher(actor);
  if (!isUuid(version)) fail("invalid_request", 400);
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const material = await r05Material(c, version);
    const run =
      (
        await c.query(
          `SELECT r.id,e.phase,e.revision,e.integration_started_at AS "integrationStartedAt",e.last_check AS "lastCheck" FROM r05_test_runs r LEFT JOIN r05_execution e ON e.test_run_id=r.id WHERE r.material_version_id=$1`,
          [version],
        )
      ).rows[0] ?? null;
    const acceptance =
      (
        await c.query(
          "SELECT submission_kind,accepted_at FROM r05_submission_acceptances WHERE material_version_id=$1",
          [version],
        )
      ).rows[0] ?? null;
    const data = run
      ? {
          maps: (
            await c.query(
              "SELECT * FROM r05_test_maps WHERE test_run_id=$1 ORDER BY map_kind",
              [run.id],
            )
          ).rows,
          history: (
            await c.query(
              "SELECT h.* FROM r05_test_history h JOIN r05_test_maps m ON m.id=h.test_map_id WHERE m.test_run_id=$1 ORDER BY h.recorded_at,h.sequence_number",
              [run.id],
            )
          ).rows,
        }
      : null;
    const audit = run
      ? (
          await c.query(
            "SELECT action,http_status,outcome,reason_code,recorded_at FROM r05_execution_audit WHERE test_run_id=$1 ORDER BY recorded_at,id",
            [run.id],
          )
        ).rows
      : [];
    const output = (await loadResearchTextSafety(c)).redact({
      material,
      run,
      acceptance,
      data,
      audit,
    });
    await c.query("COMMIT");
    return output;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
export async function deleteR05(
  pool: Pool,
  actor: Actor,
  version: string,
  id: string,
  key: string,
  confirmation: string,
) {
  return mutateR05Storage(pool, actor, "DELETE", key, version, {
    runId: id,
    confirmation,
  });
}
export const deletionR05 = (pool: Pool, actor: Actor, id: string) =>
  readR05Test(pool, actor, id);
export async function operateR05(
  pool: Pool,
  actor: Actor,
  version: string,
  id: string,
  key: string,
  cmd: Command,
) {
  researcher(actor);
  if (
    !cmd ||
    typeof cmd !== "object" ||
    typeof cmd.action !== "string" ||
    (cmd.data !== undefined &&
      (!cmd.data || typeof cmd.data !== "object" || Array.isArray(cmd.data)))
  )
    fail("invalid_request", 400);
  if (
    !isUuid(version) ||
    !isUuid(id) ||
    !isUuid(key) ||
    !isUuid(cmd.executionId) ||
    !Number.isSafeInteger(cmd.expectedRevision) ||
    JSON.stringify(cmd).length > 100000 ||
    Object.keys(cmd).some(
      (x) => !["action", "executionId", "expectedRevision", "data"].includes(x),
    )
  )
    fail("invalid_request", 400);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "r05-request:" + key.toLowerCase(),
    ]);
    const hash = digest({ version, id, cmd });
    const old = (
      await c.query(
        "SELECT * FROM r05_operation_receipts WHERE request_key=$1",
        [key],
      )
    ).rows[0];
    if (old) {
      if (old.request_hash !== hash) fail("request_conflict");
      await c.query("COMMIT");
      return old.result;
    }
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "r05-version:" + version.toLowerCase(),
    ]);
    const e = (
      await c.query(
        `SELECT e.* FROM r05_execution e JOIN r05_test_runs r ON r.id=e.test_run_id WHERE r.id=$1 AND r.material_version_id=$2 FOR UPDATE OF e`,
        [id, version],
      )
    ).rows[0];
    if (!e) fail("not_found", 404);
    if (e.execution_id !== cmd.executionId) fail("execution_not_owned");
    if (e.phase === "COMPLETE" || e.phase === "INTERRUPTED")
      fail("execution_closed");
    if (e.revision !== cmd.expectedRevision) fail("revision_conflict");
    const material = await r05Material(c, version);
    let phase = e.phase as string,
      check = e.last_check as string | null;
    const map = (
      await c.query(
        "SELECT * FROM r05_test_maps WHERE test_run_id=$1 AND map_kind=$2 FOR UPDATE",
        [id, phase],
      )
    ).rows[0];
    const expired =
      phase === "INTEGRATION" &&
      (
        await c.query(
          "SELECT clock_timestamp()>=$1::timestamptz+$2*interval '1 second' AS expired",
          [e.integration_started_at, material.body.integrationSeconds],
        )
      ).rows[0].expired;
    let action = cmd.action;
    const d = cmd.data ?? {};
    let accepted = false;
    let outcome: unknown = null;
    if (action === "INTERRUPT") {
      phase = "INTERRUPTED";
    } else if (expired) {
      action = "AUTO_SUBMIT";
    } else if (action === "TICK") {
      await c.query("COMMIT");
      return { revision: e.revision, accepted: false };
    } else if (phase === "LESSON") {
      if (action !== "LESSON_COMPLETE" || d.viewed !== true)
        fail("view_confirmation_required");
      await createMap(c, id, "SB", version);
      phase = "SB";
    } else if (action === "CHECK") {
      if (phase !== "KB") fail("feedback_not_available", 404);
      const f = await feedback(c, map.state);
      check = f.matched ? f.mapSignature : null;
      outcome = {
        matched: f.matched,
        concepts: f.concepts,
        relations: f.relations,
        mapSignature: f.mapSignature,
      };
    } else if (action === "SUBMIT") {
      if (phase === "KB") {
        const f = await feedback(c, map.state);
        if (!f.matched || check !== f.mapSignature)
          fail("kb_current_match_required");
      }
    } else {
      const before = structuredClone(map.state) as MapHistorySnapshot;
      let state = structuredClone(before);
      const operations = (
        await c.query(
          "SELECT operation FROM r05_test_history WHERE test_map_id=$1 ORDER BY sequence_number",
          [map.id],
        )
      ).rows.map((x) => x.operation as HistoryOperation);
      const type = action;
      let target = typeof d.id === "string" ? d.id : map.id,
        related: string | null = null;
      const concept = () => {
        const v = state.concepts.find(
          (x) => x.id === d.id && x.mergedIntoConceptId === null,
        );
        if (!v) fail("concept_not_found", 404);
        return v;
      };
      const link = () => {
        const v = state.links.find((x) => x.id === d.id);
        if (!v) fail("link_not_found", 404);
        return v;
      };
      const seed = (v: HistoryConcept) =>
        phase === "SB" &&
        v.provenance.some((p) =>
          material.concepts.some(
            (x) =>
              material.body.seedConceptItemIds.includes(x.id) &&
              x.sourceId === p.sourceConceptId,
          ),
        );
      const endpoints = () => {
        if (
          !state.concepts.some(
            (x) => x.id === d.sourceId && x.mergedIntoConceptId === null,
          ) ||
          !state.concepts.some(
            (x) => x.id === d.targetId && x.mergedIntoConceptId === null,
          )
        )
          fail("invalid_endpoints", 422);
        return {
          sourceConceptId: d.sourceId as string,
          targetConceptId: d.targetId as string,
        };
      };
      if (action === "ADD_CONCEPT" || action === "IMPORT_KIT_CONCEPT") {
        if (action === "ADD_CONCEPT" && phase === "KB") fail("kit_parts_only");
        const part = material.concepts.find((x) => x.id === d.partId);
        if (action === "IMPORT_KIT_CONCEPT" && !part)
          fail("kit_part_not_found", 404);
        if (
          part &&
          state.concepts.some(
            (x) =>
              x.mergedIntoConceptId === null &&
              x.provenance.some((p) => p.sourceConceptId === part.sourceId),
          )
        )
          fail("kit_part_used");
        target = randomUUID();
        state.concepts.push(
          clonedConcept(
            target,
            map.id,
            part?.label ?? label(d.label),
            point(d.x ?? 100),
            point(d.y ?? 100),
            part?.sourceId,
          ),
        );
      } else if (action === "EDIT_CONCEPT") {
        if (phase === "KB" || seed(concept())) fail("protected_concept");
        concept().label = label(d.label);
      } else if (action === "MOVE_CONCEPT") {
        const v = concept();
        v.positionX = point(d.x);
        v.positionY = point(d.y);
      } else if (action === "DELETE_CONCEPT") {
        const v = concept();
        if (seed(v)) fail("protected_concept");
        if (v.provenance.some((p) => p.relationType === "MERGED_FROM")) {
          state = releaseMerge(map.initial_state, operations, state, v.id);
        } else {
          state.concepts = state.concepts.filter((x) => x.id !== v.id);
          state.links = state.links.filter(
            (x) => x.sourceConceptId !== v.id && x.targetConceptId !== v.id,
          );
        }
      } else if (action === "ADD_LINK" || action === "IMPORT_KIT_LINK") {
        if (action === "ADD_LINK" && phase === "KB") fail("kit_parts_only");
        const part = material.links.find((x) => x.id === d.partId);
        if (action === "IMPORT_KIT_LINK" && !part)
          fail("kit_part_not_found", 404);
        if (
          part &&
          state.links.some((x) =>
            x.provenance.some((p) => p.sourceLinkId === part.sourceId),
          )
        )
          fail("kit_part_used");
        target = randomUUID();
        state.links.push({
          id: target,
          mapId: map.id,
          label: part?.label ?? label(d.label),
          ...endpoints(),
          provenance: part
            ? [
                {
                  id: randomUUID(),
                  targetLinkId: target,
                  sourceLinkId: part.sourceId,
                  relationType: "RECONSTRUCTED_FROM",
                  createdAt: new Date().toISOString(),
                },
              ]
            : [],
        });
      } else if (action === "EDIT_LINK") {
        if (phase === "KB") fail("kit_label_locked");
        link().label = label(d.label);
      } else if (action === "MOVE_LINK") {
        link().labelPositionX = point(d.x);
        link().labelPositionY = point(d.y);
      } else if (action === "RECONNECT_LINK") {
        Object.assign(link(), endpoints());
      } else if (action === "DELETE_LINK") {
        link();
        state.links = state.links.filter((x) => x.id !== d.id);
      } else if (action === "MERGE_CONCEPT") {
        if (phase !== "INTEGRATION") fail("merge_not_available");
        const a = state.concepts.find(
            (x) => x.id === d.sourceId && x.mergedIntoConceptId === null,
          ),
          b = state.concepts.find(
            (x) => x.id === d.targetId && x.mergedIntoConceptId === null,
          );
        if (!a || !b || a === b) fail("invalid_merge", 422);
        target = randomUUID();
        const v = clonedConcept(
          target,
          map.id,
          label(d.label),
          (a.positionX + b.positionX) / 2,
          (a.positionY + b.positionY) / 2,
        );
        v.provenance = [a, b].map((x) => ({
          id: randomUUID(),
          targetConceptId: target,
          sourceConceptId: x.id,
          relationType: "MERGED_FROM",
          createdAt: new Date().toISOString(),
        }));
        state.concepts.push(v);
        a.mergedIntoConceptId = target;
        b.mergedIntoConceptId = target;
        state.links = state.links.map((x) => ({
          ...x,
          sourceConceptId: [a.id, b.id].includes(x.sourceConceptId)
            ? target
            : x.sourceConceptId,
          targetConceptId: [a.id, b.id].includes(x.targetConceptId)
            ? target
            : x.targetConceptId,
        }));
      } else if (action === "UNDO" || action === "REDO") {
        const availability = deriveUndoRedoAvailability(operations),
          op =
            action === "UNDO"
              ? availability.undoOperation
              : availability.redoOperation;
        if (!op) fail("undo_redo_unavailable");
        related = op.id;
        state = structuredClone(
          (action === "UNDO" ? op.before : op.after) as MapHistorySnapshot,
        );
        target = op.targetId;
      } else fail("invalid_action", 400);
      if (!validateMapStateV5(state, map.id)) fail("invalid_map", 422);
      const safety = await loadResearchTextSafety(c);
      if (mapStateLabels(state).some((x) => safety.containsSecret(x)))
        fail("sensitive_text", 422);
      await c.query("UPDATE r05_test_maps SET state=$2 WHERE id=$1", [
        map.id,
        state,
      ]);
      const op: HistoryOperation = {
        id: randomUUID(),
        mapId: map.id,
        sequenceNumber: String(operations.length + 1),
        operationType: type,
        targetId: target,
        targetType: action.includes("LINK") ? "LINK" : "CONCEPT",
        before,
        after: state,
        relatedOperationLogId: related,
        historyFormat: "V5",
        outcome: "SUCCESS",
      };
      await c.query(
        "INSERT INTO r05_test_history(id,test_map_id,sequence_number,operation) VALUES($1,$2,$3,$4)",
        [op.id, map.id, op.sequenceNumber, op],
      );
    }
    if (action === "SUBMIT" || action === "AUTO_SUBMIT") {
      if (!map) fail("map_required");
      const kind = action === "AUTO_SUBMIT" ? "AUTOMATIC" : "MANUAL";
      const sequence = (
        await c.query(
          "SELECT coalesce(max(sequence_number),0)+1 AS n FROM r05_test_history WHERE test_map_id=$1",
          [map.id],
        )
      ).rows[0].n;
      const operation = {
        id: randomUUID(),
        mapId: map.id,
        sequenceNumber: String(sequence),
        operationType:
          action === "AUTO_SUBMIT" ? "MAP_AUTO_SUBMIT" : "MAP_SUBMIT",
        targetType: "MAP",
        targetId: map.id,
        before: map.state,
        after: map.state,
        historyFormat: "V5",
        outcome: "SUCCESS",
      };
      await c.query(
        "INSERT INTO r05_test_history(id,test_map_id,sequence_number,operation) VALUES($1,$2,$3,$4)",
        [operation.id, map.id, sequence, operation],
      );
      await c.query(
        "UPDATE r05_test_maps SET submitted_at=clock_timestamp(),submission_kind=$2 WHERE id=$1 AND submitted_at IS NULL",
        [map.id, kind],
      );
      if (phase === "INTEGRATION") {
        await c.query(
          `INSERT INTO r05_submission_acceptances(test_run_id,material_version_id,submission_kind,accepted_at) SELECT test_run_id,$2,submission_kind,submitted_at FROM r05_test_maps WHERE id=$1`,
          [map.id, version],
        );
        phase = "COMPLETE";
        accepted = true;
      } else {
        phase = phase === "SB" ? "KB" : "INTEGRATION";
        await createMap(c, id, phase, version);
        if (phase === "INTEGRATION")
          await c.query(
            "UPDATE r05_execution SET integration_started_at=clock_timestamp() WHERE test_run_id=$1",
            [id],
          );
        check = null;
      }
    }
    await c.query(
      "UPDATE r05_execution SET phase=$2,revision=revision+1,last_check=$3 WHERE test_run_id=$1",
      [id, phase, check],
    );
    const result = { revision: e.revision + 1, accepted, outcome };
    await c.query("INSERT INTO r05_operation_receipts VALUES($1,$2,$3,$4)", [
      key,
      hash,
      id,
      result,
    ]);
    await c.query(
      `INSERT INTO r05_execution_audit(test_run_id,action,http_status,outcome,reason_code) VALUES($1,$2,200,'SUCCESS','ok')`,
      [id, action],
    );
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
