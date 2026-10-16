export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE concepts
      ADD COLUMN merged_into_concept_id uuid NULL;

    ALTER TABLE concepts
      ADD CONSTRAINT concepts_merged_into_not_self_chk
        CHECK (
          merged_into_concept_id IS NULL
          OR merged_into_concept_id <> id
        ),
      ADD CONSTRAINT concepts_id_map_id_uq
        UNIQUE (id, map_id);

    ALTER TABLE concepts
      ADD CONSTRAINT concepts_merged_into_same_map_fk
        FOREIGN KEY (merged_into_concept_id, map_id)
        REFERENCES concepts (id, map_id)
        ON DELETE RESTRICT;

    CREATE INDEX concepts_merged_into_concept_idx
      ON concepts (merged_into_concept_id)
      WHERE merged_into_concept_id IS NOT NULL;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX concepts_merged_into_concept_idx;
    ALTER TABLE concepts
      DROP CONSTRAINT concepts_merged_into_same_map_fk,
      DROP CONSTRAINT concepts_id_map_id_uq,
      DROP CONSTRAINT concepts_merged_into_not_self_chk,
      DROP COLUMN merged_into_concept_id;
  `);
};
