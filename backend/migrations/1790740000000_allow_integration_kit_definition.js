export const up = (pgm) => {
  pgm.dropConstraint("maps", "maps_kit_definition_kb_only_chk");
  pgm.sql(`
    ALTER TABLE maps
      ADD CONSTRAINT maps_kit_definition_supported_type_chk
        CHECK (kit_definition_id IS NULL OR type IN ('KB', 'INTEGRATION'));
  `);
};

export const down = (pgm) => {
  pgm.dropConstraint("maps", "maps_kit_definition_supported_type_chk");
  pgm.sql(`
    ALTER TABLE maps
      ADD CONSTRAINT maps_kit_definition_kb_only_chk
        CHECK (kit_definition_id IS NULL OR type = 'KB');
  `);
};
