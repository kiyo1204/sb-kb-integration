export const up = (pgm) => {
  pgm.createTable("map_initial_snapshots", {
    map_id: {
      type: "uuid",
      primaryKey: true,
      references: "maps",
      onDelete: "CASCADE",
    },
    snapshot_version: { type: "integer", notNull: true },
    snapshot: { type: "jsonb", notNull: true },
    captured_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.sql(`
    ALTER TABLE map_initial_snapshots
      ADD CONSTRAINT map_initial_snapshots_version_chk CHECK (snapshot_version > 0)
  `);
};

export const down = (pgm) => {
  pgm.dropTable("map_initial_snapshots");
};
