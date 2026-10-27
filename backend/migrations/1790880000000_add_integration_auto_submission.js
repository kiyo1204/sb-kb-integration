export const up = (pgm) => {
  pgm.addColumns('maps', {
    auto_submitted_at: { type: 'timestamptz' },
  });
};

export const down = () => {
  throw new Error('Automatic submission timestamps are research data and cannot be discarded');
};
