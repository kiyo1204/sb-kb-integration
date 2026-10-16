export const up = (pgm) => {
  pgm.createTable("concept_provenance", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    target_concept_id: {
      type: "uuid",
      notNull: true,
      references: "concepts",
      onDelete: "CASCADE",
    },
    source_concept_id: {
      type: "uuid",
      notNull: true,
      references: "concepts",
      onDelete: "RESTRICT",
    },
    relation_type: { type: "text", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.sql(`
    ALTER TABLE concept_provenance
      ADD CONSTRAINT concept_provenance_distinct_endpoints_chk
        CHECK (target_concept_id <> source_concept_id),
      ADD CONSTRAINT concept_provenance_relation_type_nonblank_chk
        CHECK (btrim(relation_type) <> ''),
      ADD CONSTRAINT concept_provenance_target_source_type_uq
        UNIQUE (target_concept_id, source_concept_id, relation_type);
  `);
  pgm.createIndex("concept_provenance", "source_concept_id", {
    name: "concept_provenance_source_concept_idx",
  });

  pgm.createTable("link_provenance", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    target_link_id: {
      type: "uuid",
      notNull: true,
      references: "links",
      onDelete: "CASCADE",
    },
    source_link_id: {
      type: "uuid",
      notNull: true,
      references: "links",
      onDelete: "RESTRICT",
    },
    relation_type: { type: "text", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.sql(`
    ALTER TABLE link_provenance
      ADD CONSTRAINT link_provenance_distinct_endpoints_chk
        CHECK (target_link_id <> source_link_id),
      ADD CONSTRAINT link_provenance_relation_type_nonblank_chk
        CHECK (btrim(relation_type) <> ''),
      ADD CONSTRAINT link_provenance_target_source_type_uq
        UNIQUE (target_link_id, source_link_id, relation_type);
  `);
  pgm.createIndex("link_provenance", "source_link_id", {
    name: "link_provenance_source_link_idx",
  });
};

export const down = (pgm) => {
  pgm.dropTable("link_provenance");
  pgm.dropTable("concept_provenance");
};
