export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE sessions DROP CONSTRAINT sessions_learner_token_hash_chk;
    ALTER TABLE sessions ADD CONSTRAINT sessions_learner_token_hash_chk CHECK (
      learner_access_token_hash IS NULL OR
      (protocol_key IN ('STAGE1_4', 'STAGE1_6') AND
       learner_access_token_hash ~ '^[0-9a-f]{64}$')
    );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM sessions
        WHERE protocol_key = 'STAGE1_6' AND learner_access_token_hash IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'Cannot remove support for Stage 1_6 learner tokens while they exist';
      END IF;
    END $$;
    ALTER TABLE sessions DROP CONSTRAINT sessions_learner_token_hash_chk;
    ALTER TABLE sessions ADD CONSTRAINT sessions_learner_token_hash_chk CHECK (
      learner_access_token_hash IS NULL OR
      (protocol_key = 'STAGE1_4' AND learner_access_token_hash ~ '^[0-9a-f]{64}$')
    );
  `);
};
