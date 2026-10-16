export const up = (pgm) => {
  pgm.addColumn("maps", {
    title: { type: "text" },
  });
};

export const down = (pgm) => {
  pgm.dropColumn("maps", "title");
};
