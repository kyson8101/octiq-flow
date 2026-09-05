// A project keeps the color it was given in the original desktop client. When
// it has no saved color, hash its name into the same fixed palette so every
// folder still has a stable identity after a reload.
const PROJECT_COLORS = [
  "#f87171",
  "#fb923c",
  "#fbbf24",
  "#a3e635",
  "#34d399",
  "#22d3ee",
  "#60a5fa",
  "#a78bfa",
  "#f472b6",
  "#94a3b8",
] as const;

export function projectColor(project: { id: string; name: string; color?: string }): string {
  const saved = project.color?.trim();
  if (saved && /^#[0-9a-f]{6}$/i.test(saved)) return saved;

  const seed = project.name || project.id;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return PROJECT_COLORS[hash % PROJECT_COLORS.length];
}
