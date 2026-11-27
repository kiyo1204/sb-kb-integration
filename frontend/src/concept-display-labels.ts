export function buildDuplicateConceptDisplayLabels(
  concepts: readonly { id: string; label: string; createdAt: string }[],
): ReadonlyMap<string, string> {
  const byLabel = new Map<
    string,
    Array<{ id: string; label: string; createdAt: string }>
  >();
  for (const concept of concepts) {
    const group = byLabel.get(concept.label) ?? [];
    group.push(concept);
    byLabel.set(concept.label, group);
  }

  const displayLabels = new Map<string, string>();
  for (const group of byLabel.values()) {
    if (group.length < 2 || !group[0]?.label.trim()) continue;
    const ordered = [...group].sort((left, right) => {
      if (left.createdAt !== right.createdAt)
        return left.createdAt < right.createdAt ? -1 : 1;
      if (left.id !== right.id) return left.id < right.id ? -1 : 1;
      return 0;
    });
    ordered.forEach((concept, index) => {
      displayLabels.set(concept.id, `${concept.label} (${index + 1})`);
    });
  }
  return displayLabels;
}
