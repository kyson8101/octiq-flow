type SiblingProject = {
  id: string;
  sibling_ids?: readonly string[];
};

function lastMatchingIndex(ids: readonly string[], matches: (id: string) => boolean): number {
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    if (matches(ids[index])) return index;
  }
  return -1;
}

/** Every project connected to `start`, including indirect sibling links. */
export function siblingGroupIds(projects: readonly SiblingProject[], start: string): Set<string> {
  const byId = new Map(projects.map((project) => [project.id, project]));
  if (!byId.has(start)) return new Set();

  const group = new Set([start]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const project of projects) {
      if (group.has(project.id)) continue;
      const pointsAtGroup = (project.sibling_ids ?? []).some((id) => group.has(id));
      const pointedToByGroup = [...group].some((id) =>
        (byId.get(id)?.sibling_ids ?? []).includes(project.id),
      );
      if (pointsAtGroup || pointedToByGroup) {
        group.add(project.id);
        changed = true;
      }
    }
  }
  return group;
}

/** Move a sibling-connected group to an edge of another sibling group. */
export function moveSiblingGroupAt(
  projects: readonly SiblingProject[],
  moving: string,
  target: string,
  edge: "before" | "after",
): string[] {
  const ids = projects.map((project) => project.id);
  const movingGroup = siblingGroupIds(projects, moving);
  const targetGroup = siblingGroupIds(projects, target);
  if (!movingGroup.size || !targetGroup.size || movingGroup.has(target)) return ids;

  const carried = ids.filter((id) => movingGroup.has(id));
  const next = ids.filter((id) => !movingGroup.has(id));
  const targetIndex = edge === "before"
    ? next.findIndex((id) => targetGroup.has(id))
    : lastMatchingIndex(next, (id) => targetGroup.has(id));
  if (targetIndex < 0) return ids;
  next.splice(targetIndex + (edge === "after" ? 1 : 0), 0, ...carried);
  return next;
}

/** Move a sibling-connected group past the neighbouring sibling group. */
export function moveSiblingGroupBy(
  projects: readonly SiblingProject[],
  moving: string,
  direction: -1 | 1,
): string[] {
  const ids = projects.map((project) => project.id);
  const group = siblingGroupIds(projects, moving);
  if (!group.size) return ids;

  const boundary = direction === -1
    ? ids.findIndex((id) => group.has(id)) - 1
    : lastMatchingIndex(ids, (id) => group.has(id)) + 1;
  if (boundary < 0 || boundary >= ids.length) return ids;
  return moveSiblingGroupAt(projects, moving, ids[boundary], direction === -1 ? "before" : "after");
}
