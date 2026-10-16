export const up = (pgm) => {
  pgm.createTable("explanation_prompts", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    prompt_key: { type: "text", notNull: true },
    version: { type: "integer", notNull: true },
    text: { type: "text", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.addConstraint(
    "explanation_prompts",
    "explanation_prompts_prompt_key_version_uq",
    { unique: ["prompt_key", "version"] },
  );
  pgm.addConstraint("explanation_prompts", "explanation_prompts_key_chk", {
    check: "length(btrim(prompt_key)) > 0 AND version > 0",
  });

  pgm.addColumn("session_stages", {
    explanation_prompt_id: {
      type: "uuid",
      references: "explanation_prompts",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint(
    "session_stages",
    "session_stages_explanation_prompt_type_chk",
    {
      check: `stage_type IN ('PRE_EXPLANATION', 'POST_EXPLANATION')
        OR explanation_prompt_id IS NULL`,
    },
  );
  pgm.createIndex("session_stages", "explanation_prompt_id", {
    name: "session_stages_explanation_prompt_idx",
  });

  pgm.createTable("explanation_responses", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    session_stage_id: {
      type: "uuid",
      notNull: true,
      references: "session_stages",
      onDelete: "RESTRICT",
    },
    prompt_id: {
      type: "uuid",
      notNull: true,
      references: "explanation_prompts",
      onDelete: "RESTRICT",
    },
    response_text: { type: "text", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    submitted_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint(
    "explanation_responses",
    "explanation_responses_stage_prompt_uq",
    { unique: ["session_stage_id", "prompt_id"] },
  );
  pgm.addConstraint(
    "explanation_responses",
    "explanation_responses_submitted_after_created_chk",
    { check: "submitted_at >= created_at" },
  );
  pgm.createIndex("explanation_responses", "prompt_id", {
    name: "explanation_responses_prompt_idx",
  });
};

export const down = (pgm) => {
  pgm.dropTable("explanation_responses");
  pgm.dropIndex("session_stages", "explanation_prompt_id", {
    name: "session_stages_explanation_prompt_idx",
  });
  pgm.dropConstraint(
    "session_stages",
    "session_stages_explanation_prompt_type_chk",
  );
  pgm.dropColumn("session_stages", "explanation_prompt_id");
  pgm.dropTable("explanation_prompts");
};
