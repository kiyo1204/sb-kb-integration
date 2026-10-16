export const up = (pgm) => {
  pgm.addColumn("sessions", {
    learner_access_token_hash: { type: "text", unique: true },
  });
  pgm.sql(`ALTER TABLE sessions ADD CONSTRAINT sessions_learner_token_hash_chk
    CHECK (learner_access_token_hash IS NULL OR
      (protocol_key = 'STAGE1_4' AND learner_access_token_hash ~ '^[0-9a-f]{64}$'))`);
};

export const down = (pgm) => {
  pgm.sql("ALTER TABLE sessions DROP CONSTRAINT sessions_learner_token_hash_chk");
  pgm.dropColumn("sessions", "learner_access_token_hash");
};
