export const up = (pgm) => {
  pgm.createTable("kit_definitions", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    goal_map_id: {
      type: "uuid",
      notNull: true,
      references: "maps",
      onDelete: "RESTRICT",
    },
    name: { type: "text", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.sql(`
    ALTER TABLE kit_definitions
      ADD CONSTRAINT kit_definitions_name_nonblank_chk
        CHECK (btrim(name) <> '');
  `);
  pgm.createIndex("kit_definitions", "goal_map_id", {
    name: "kit_definitions_goal_map_id_idx",
  });

  pgm.createTable("kit_concept_items", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    kit_definition_id: {
      type: "uuid",
      notNull: true,
      references: "kit_definitions",
      onDelete: "CASCADE",
    },
    source_concept_id: {
      type: "uuid",
      notNull: true,
      references: "concepts",
      onDelete: "RESTRICT",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.sql(`
    ALTER TABLE kit_concept_items
      ADD CONSTRAINT kit_concept_items_kit_source_uq
        UNIQUE (kit_definition_id, source_concept_id);
  `);
  pgm.createIndex("kit_concept_items", "source_concept_id", {
    name: "kit_concept_items_source_concept_id_idx",
  });

  pgm.createTable("kit_link_items", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    kit_definition_id: {
      type: "uuid",
      notNull: true,
      references: "kit_definitions",
      onDelete: "CASCADE",
    },
    source_link_id: {
      type: "uuid",
      notNull: true,
      references: "links",
      onDelete: "RESTRICT",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.sql(`
    ALTER TABLE kit_link_items
      ADD CONSTRAINT kit_link_items_kit_source_uq
        UNIQUE (kit_definition_id, source_link_id);
  `);
  pgm.createIndex("kit_link_items", "source_link_id", {
    name: "kit_link_items_source_link_id_idx",
  });
};

export const down = (pgm) => {
  pgm.dropTable("kit_link_items");
  pgm.dropTable("kit_concept_items");
  pgm.dropTable("kit_definitions");
};
