export const up = (pgm) => {
  pgm.addColumn("map_operation_logs", {
    related_operation_log_id: {
      type: "uuid",
      references: "map_operation_logs",
      onDelete: "RESTRICT",
    },
    idempotency_key: { type: "uuid" },
  });

  pgm.createIndex("map_operation_logs", ["map_id", "idempotency_key"], {
    unique: true,
    where: "idempotency_key IS NOT NULL",
    name: "map_operation_logs_map_idempotency_key_uq",
  });
};

export const down = (pgm) => {
  pgm.dropIndex("map_operation_logs", ["map_id", "idempotency_key"], {
    name: "map_operation_logs_map_idempotency_key_uq",
  });
  pgm.dropColumn("map_operation_logs", [
    "related_operation_log_id",
    "idempotency_key",
  ]);
};
