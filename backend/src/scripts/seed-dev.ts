import { Pool } from "pg";
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({ connectionString: databaseUrl });
const developmentGoalMapId = "44444444-4444-4444-8444-444444444442";
const developmentGoalConceptIds = [
  "55555555-5555-4555-8555-555555555561",
  "55555555-5555-4555-8555-555555555562",
  "55555555-5555-4555-8555-555555555563",
] as const;
const developmentGoalLinkIds = [
  "99999999-9999-4999-8999-999999999981",
  "99999999-9999-4999-8999-999999999982",
] as const;
const developmentKitDefinitionId = "66666666-6666-4666-8666-666666666662";
const developmentKitConceptItemIds = [
  "77777777-7777-4777-8777-777777777781",
  "77777777-7777-4777-8777-777777777782",
  "77777777-7777-4777-8777-777777777783",
] as const;
const developmentKitLinkItemIds = [
  "88888888-8888-4888-8888-888888888882",
  "88888888-8888-4888-8888-888888888883",
] as const;
const concepts = [
  {
    id: "22222222-2222-4222-8222-222222222221",
    label: "植物",
    positionX: 80,
    positionY: 100,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    label: "光合成",
    positionX: 380,
    positionY: 220,
  },
  {
    id: "22222222-2222-4222-8222-222222222223",
    label: "二酸化炭素",
    positionX: 680,
    positionY: 100,
  },
];

const links = [
  {
    id: "33333333-3333-4333-8333-333333333331",
    sourceConceptId: concepts[0].id,
    targetConceptId: concepts[1].id,
    label: "行う",
  },
  {
    id: "33333333-3333-4333-8333-333333333332",
    sourceConceptId: concepts[1].id,
    targetConceptId: concepts[2].id,
    label: "必要とする",
  },
];

async function seedDevelopmentKit() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO maps (id, type, status)
       VALUES ($1::uuid, 'GOAL', 'DRAFT')
       ON CONFLICT (id) DO NOTHING`,
      [developmentGoalMapId],
    );
    const developmentConcepts = concepts.map((concept, index) => ({
      ...concept,
      id: developmentGoalConceptIds[index],
    }));
    const developmentConceptIdByDemoId = new Map(
      concepts.map((concept, index) => [
        concept.id,
        developmentGoalConceptIds[index],
      ]),
    );
    const developmentLinks = links.map((link, index) => ({
      ...link,
      id: developmentGoalLinkIds[index],
      sourceConceptId: developmentConceptIdByDemoId.get(link.sourceConceptId),
      targetConceptId: developmentConceptIdByDemoId.get(link.targetConceptId),
    }));
    for (const concept of developmentConcepts) {
      await client.query(
        `INSERT INTO concepts (id, map_id, label, position_x, position_y)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [
          concept.id,
          developmentGoalMapId,
          concept.label,
          concept.positionX,
          concept.positionY,
        ],
      );
    }
    for (const link of developmentLinks) {
      if (!link.sourceConceptId || !link.targetConceptId) {
        throw new Error("Development Kit Link endpoint could not be mapped");
      }
      await client.query(
        `INSERT INTO links (id, map_id, source_concept_id, target_concept_id, label)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)
         ON CONFLICT (id) DO NOTHING`,
        [
          link.id,
          developmentGoalMapId,
          link.sourceConceptId,
          link.targetConceptId,
          link.label,
        ],
      );
    }
    await client.query(
      `INSERT INTO kit_definitions (id, goal_map_id, name)
       VALUES ($1::uuid, $2::uuid, 'Development Kit：光合成')
       ON CONFLICT (id) DO NOTHING`,
      [developmentKitDefinitionId, developmentGoalMapId],
    );

    for (const [index, concept] of developmentConcepts.entries()) {
      await client.query(
        `INSERT INTO kit_concept_items (id, kit_definition_id, source_concept_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)
         ON CONFLICT (id) DO NOTHING`,
        [
          developmentKitConceptItemIds[index],
          developmentKitDefinitionId,
          concept.id,
        ],
      );
    }
    for (const [index, link] of developmentLinks.entries()) {
      await client.query(
        `INSERT INTO kit_link_items (id, kit_definition_id, source_link_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)
         ON CONFLICT (id) DO NOTHING`,
        [developmentKitLinkItemIds[index], developmentKitDefinitionId, link.id],
      );
    }

    const verification = await client.query<{
      goalMapId: string;
      goalMapType: string;
      name: string;
      conceptCount: number;
      linkCount: number;
    }>(
      `SELECT
         kit.goal_map_id AS "goalMapId",
         goal.type AS "goalMapType",
         kit.name,
         (SELECT count(*)::int FROM kit_concept_items WHERE kit_definition_id = kit.id) AS "conceptCount",
         (SELECT count(*)::int FROM kit_link_items WHERE kit_definition_id = kit.id) AS "linkCount"
       FROM kit_definitions AS kit
       INNER JOIN maps AS goal ON goal.id = kit.goal_map_id
       WHERE kit.id = $1::uuid`,
      [developmentKitDefinitionId],
    );
    const kit = verification.rows[0];
    if (
      !kit ||
      kit.goalMapId !== developmentGoalMapId ||
      kit.goalMapType !== "GOAL" ||
      kit.name !== "Development Kit：光合成" ||
      kit.conceptCount !== concepts.length ||
      kit.linkCount !== links.length
    ) {
      throw new Error("Development Kit IDs already contain conflicting data");
    }
    await client.query("COMMIT");
    console.log(`Development Kit ensured: ${developmentKitDefinitionId}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}


try {
  await seedDevelopmentKit();
} finally {
  await pool.end();
}
