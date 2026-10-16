export const up = (pgm) => {
  pgm.addColumn("maps", {
    kit_definition_id: {
      type: "uuid",
      references: "kit_definitions",
      onDelete: "RESTRICT",
    },
  });
  pgm.createIndex("maps", "kit_definition_id");
  pgm.sql(`
    ALTER TABLE maps
      ADD CONSTRAINT maps_kit_definition_kb_only_chk
        CHECK (kit_definition_id IS NULL OR type = 'KB');
  `);
};

export const down = (pgm) => {
  pgm.dropConstraint("maps", "maps_kit_definition_kb_only_chk");
  pgm.dropColumn("maps", "kit_definition_id");
};
