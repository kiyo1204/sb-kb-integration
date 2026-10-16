export const up = (pgm) => {
  pgm.createTable("links", {
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
    source_concept_id: {
      type: "uuid",
      notNull: true,
      references: "concepts",
      onDelete: "CASCADE",
    },
    target_concept_id: {
      type: "uuid",
      notNull: true,
      references: "concepts",
      onDelete: "CASCADE",
    },
    label: { type: "text", notNull: true },
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

  pgm.createIndex("links", "map_id");
  pgm.createIndex("links", "source_concept_id");
  pgm.createIndex("links", "target_concept_id");

  pgm.sql(`
    CREATE FUNCTION set_link_updated_at() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER links_set_updated_at
    BEFORE UPDATE ON links
    FOR EACH ROW
    EXECUTE FUNCTION set_link_updated_at();
  `);
};

export const down = (pgm) => {
  pgm.dropTable("links");
  pgm.sql("DROP FUNCTION set_link_updated_at();");
};
