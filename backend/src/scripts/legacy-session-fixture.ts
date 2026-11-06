import type { Pool } from "pg";
import { createStage1Session } from "../sessions.js";
import { createLearnerToken, storeLearnerToken } from "../access-control.js";
import { insertAudit } from "../server-audit.js";
import { verifyMockTestUrl } from "./mock-db.js";
export async function legacySixFixture(
  pool: Pool,
  input: {
    participantCode: string;
    videoUrl: string;
    kitDefinitionId: string;
    studyGroup: "CONTROL" | "EXPERIMENTAL";
  },
) {
  await verifyMockTestUrl(process.env.DATABASE_URL ?? "");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const session = await createStage1Session(c, {
      ...input,
      lessonVideoUrl: input.videoUrl,
      groupActivitySeconds: 60,
    });
    const credential = createLearnerToken();
    await storeLearnerToken(c, session.id, credential.hash);
    await insertAudit(
      c,
      { eventType: "SESSION_CREATE", sessionId: session.id },
      "RESEARCHER",
    );
    await c.query("COMMIT");
    return { ...session, learnerAccessToken: credential.token };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
