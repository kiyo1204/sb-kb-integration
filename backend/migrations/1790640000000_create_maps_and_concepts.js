export const up = (pgm) => {
  pgm.createType("map_type", [
    "GOAL",
    "PRIOR",
    "KB",
    "INTEGRATION",
    "TUTORIAL",
  ]);
  pgm.createType("map_status", ["DRAFT", "SUBMITTED"]);

  pgm.createTable("maps", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    type: { type: "map_type", notNull: true },
    status: { type: "map_status", notNull: true, default: "DRAFT" },
    based_on_map_id: {
      type: "uuid",
      references: "maps",
      onDelete: "SET NULL",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    submitted_at: { type: "timestamptz" },
  });
  pgm.createIndex("maps", "based_on_map_id");

  pgm.createTable("concepts", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    map_id: {
      type: "uuid",
      notNull: true,
      references: "maps",
      onDelete: "CASCADE",
    },
    label: { type: "text", notNull: true },
    position_x: { type: "double precision", notNull: true },
    position_y: { type: "double precision", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.createIndex("concepts", "map_id");

  pgm.sql(`
    CREATE FUNCTION set_concept_updated_at() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER concepts_set_updated_at
    BEFORE UPDATE ON concepts
    FOR EACH ROW
    EXECUTE FUNCTION set_concept_updated_at();
  `);
};

export const down = (pgm) => {
  pgm.dropTable("concepts");
  pgm.sql("DROP FUNCTION set_concept_updated_at();");
  pgm.dropTable("maps");
  pgm.dropType("map_status");
  pgm.dropType("map_type");
};
