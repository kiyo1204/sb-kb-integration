import { normaliseEvent } from "../event-export-query.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { sampleFiles, sampleEvents } from "../event-export-samples.js";
import { commonColumns, csvRows } from "../event-export-contract.js";
import { validateEvent } from "../research-events.js";
import { eventTargets, type EventType } from "../research-event-catalog.js";
import { eventTestMatrix } from "../event-test-matrix.js";
const files = sampleFiles();
const ids = new Set(sampleEvents.map((x) => x.event_id));
assert.equal(ids.size, sampleEvents.length);
for (const [name, text] of Object.entries(files)) {
  assert.equal(
    await readFile("../docs/samples/event-export/" + name, "utf8"),
    text,
    name + ": sample drift",
  );
  if (!name.endsWith(".csv")) continue;
  const rows = parse(text, { columns: true, bom: true }) as Record<
    string,
    string
  >[];
  const expected = sampleEvents.filter((e) => Object.hasOwn(csvRows(e), name));
  assert.equal(rows.length, expected.length);
  for (const [index, row] of rows.entries()) {
    assert.ok(ids.has(row.event_id));
    for (const key of commonColumns)
      assert.equal(
        row[key],
        expected[index][key] == null ? "" : String(expected[index][key]),
      );
  }
}
const mapOwners = new Map<string, string | null>(),
  stageActivities = new Map<string, string | null>();
for (const e of sampleEvents) {
  if (e.map_id) {
    if (mapOwners.has(e.map_id))
      assert.equal(mapOwners.get(e.map_id), e.session_id);
    mapOwners.set(e.map_id, e.session_id);
  }
  if (e.stage_id) {
    if (stageActivities.has(e.stage_id))
      assert.equal(stageActivities.get(e.stage_id), e.activity);
    stageActivities.set(e.stage_id, e.activity);
  }
  if(e.schema_version===5 || e.schema_version===6){
    const actual=await normaliseEvent({...e,pseudonym:e.learner_id??undefined,before_payload:e.before,after_payload:e.after,oversized:false,stream_order:1});
    for(const key of ["outcome","feedback_match","payload_status","before","after","details","server_timestamp","client_timestamp","target_id"] as const)assert.deepEqual(actual[key],e[key],e.event_id+":"+key+" must match real normalization");
  }
  if (e.source_format !== "EVENT") continue;
  if (e.schema_version === 4) {
    // v4 is server-only; never make the client validation API accept it.
    const type = e.event_type as EventType;
    assert.ok(Object.hasOwn(eventTestMatrix, type));
    assert.ok((eventTestMatrix[type].versions as number[]).includes(4));
    assert.equal(e.target_type, eventTargets[type]);
    assert.ok(["RESEARCHER", "SYSTEM"].includes(e.actor_type));
    if (["STAGE_DEADLINE", "MAP_AUTO_SUBMIT"].includes(type)) assert.equal(e.actor_type,"SYSTEM");
    assert.equal(e.before,null);
    assert.equal(e.after,null);
    assert.deepEqual(e.details,{});
    assert.equal(e.client_time_quality,"NOT_APPLICABLE");
    assert.equal(e.before_quality,"NOT_APPLICABLE");
    assert.equal(e.after_quality,"NOT_APPLICABLE");
    assert.equal(e.client_timestamp,null);
    assert.ok(Number.isFinite(Date.parse(e.server_timestamp)));
    continue;
  }
  assert.ok(
    validateEvent({
      schemaVersion: e.schema_version,
      eventType: e.event_type,
      targetType: e.target_type,
      ...(e.stage_id ? { stageId: e.stage_id } : {}),
      ...(e.map_id ? { mapId: e.map_id } : {}),
      ...(e.target_id ? { targetId: e.target_id } : {}),
      outcome: e.outcome,
      ...(e.reason_code ? { reasonCode: e.reason_code } : {}),
      clientTimeQuality: e.client_time_quality,
      ...(e.client_timestamp ? { clientTimestamp: e.client_timestamp } : {}),
      beforeQuality: e.before_quality,
      afterQuality: e.after_quality,
      ...(e.before !== null ? { before: e.before } : {}),
      ...(e.after !== null ? { after: e.after } : {}),
      ...(Object.keys(e.details).length ? { details: e.details } : {}),
    }),
    e.event_id,
  );
}
for(const event of JSON.parse((await readFile("../docs/samples/event-export/events.json","utf8"))).events){if(event.session_id!==null)assert.match(event.learner_id,/^P-[a-f0-9-]{36}$/);}

console.log(
  "Dummy samples: exact generated files, event references/count/time/outcome, v1-v3/v5/v6 validation + server-only v4 contract, Map/Stage ownership: PASS",
);

