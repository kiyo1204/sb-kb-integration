export const up = (pgm) => {
  pgm.createTable("map_operation_logs", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    map_id: {
      type: "uuid",
      notNull: true,
      references: "maps",
      onDelete: "RESTRICT",
    },
    operation_type: { type: "text", notNull: true },
    target_type: { type: "text", notNull: true },
    target_id: { type: "uuid", notNull: true },
    before: { type: "jsonb" },
    after: { type: "jsonb" },
    sequence_number: { type: "bigint", notNull: true },
    client_timestamp: { type: "timestamptz" },
    server_timestamp: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.createIndex("map_operation_logs", ["map_id", "sequence_number"], {
    unique: true,
    name: "map_operation_logs_map_sequence_uq",
  });
};

export const down = (pgm) => {
  pgm.dropTable("map_operation_logs");
};
