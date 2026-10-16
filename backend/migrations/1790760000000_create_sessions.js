export const up = (pgm) => {
  pgm.createTable("sessions", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    status: { type: "text", notNull: true, default: "NOT_STARTED" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    started_at: { type: "timestamptz" },
    completed_at: { type: "timestamptz" },
  });

  pgm.createTable("session_stages", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    session_id: {
      type: "uuid",
      notNull: true,
      references: "sessions",
      onDelete: "RESTRICT",
    },
    stage_type: { type: "text", notNull: true },
    order_index: { type: "integer", notNull: true },
    status: { type: "text", notNull: true, default: "PENDING" },
    started_at: { type: "timestamptz" },
    completed_at: { type: "timestamptz" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.sql(`
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_status_chk
        CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED')),
      ADD CONSTRAINT sessions_status_timing_chk CHECK (
        (status = 'NOT_STARTED' AND started_at IS NULL AND completed_at IS NULL)
        OR (status = 'IN_PROGRESS' AND started_at IS NOT NULL AND completed_at IS NULL)
        OR (status = 'COMPLETED' AND started_at IS NOT NULL AND completed_at IS NOT NULL
            AND completed_at >= started_at)
      );

    ALTER TABLE session_stages
      ADD CONSTRAINT session_stages_type_chk CHECK (stage_type IN (
        'TUTORIAL', 'PRE_EXPLANATION', 'PRIOR_MAP', 'LESSON',
        'KB_MAP', 'INTEGRATION_MAP', 'POST_EXPLANATION'
      )),
      ADD CONSTRAINT session_stages_status_chk
        CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED')),
      ADD CONSTRAINT session_stages_order_nonnegative_chk CHECK (order_index >= 0),
      ADD CONSTRAINT session_stages_status_timing_chk CHECK (
        (status = 'PENDING' AND started_at IS NULL AND completed_at IS NULL)
        OR (status = 'IN_PROGRESS' AND started_at IS NOT NULL AND completed_at IS NULL)
        OR (status = 'COMPLETED' AND started_at IS NOT NULL AND completed_at IS NOT NULL
            AND completed_at >= started_at)
      );
  `);

  pgm.addConstraint("session_stages", "session_stages_session_order_uq", {
    unique: ["session_id", "order_index"],
  });
  pgm.addColumn("maps", {
    session_stage_id: {
      type: "uuid",
      references: "session_stages",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("maps", "maps_session_stage_uq", {
    unique: ["session_stage_id"],
  });
};

export const down = (pgm) => {
  pgm.dropConstraint("maps", "maps_session_stage_uq");
  pgm.dropColumn("maps", "session_stage_id");
  pgm.dropTable("session_stages");
  pgm.dropTable("sessions");
};
