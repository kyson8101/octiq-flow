import type { CSSProperties } from "react";

import { projectColor } from "../lib/projectColor";

export type ProjectAppearance = {
  id: string;
  name: string;
  color?: string;
  initial?: string;
  icon?: string;
};

export type ProjectAvatarSize = "tiny" | "small" | "medium" | "large";

/** The short fallback shown when a project has no uploaded icon. */
export function projectInitial(project: Pick<ProjectAppearance, "name" | "initial">): string {
  const custom = [...(project.initial ?? "").trim()].slice(0, 2).join("");
  if (custom) return custom.toLocaleUpperCase();
  return [...project.name.trim()][0]?.toLocaleUpperCase() ?? "?";
}

/** One project identity everywhere: uploaded artwork, then a stable letter tile. */
export function ProjectAvatar({
  project,
  size = "small",
  className = "",
}: {
  project: ProjectAppearance;
  size?: ProjectAvatarSize;
  className?: string;
}) {
  const icon = project.icon?.trim();
  const style = { "--project-color": projectColor(project) } as CSSProperties;

  return (
    <span
      className={[
        "project-avatar",
        `is-${size}`,
        icon ? "has-icon" : "",
        className,
      ].filter(Boolean).join(" ")}
      style={style}
      aria-hidden="true"
    >
      {icon
        ? <img className="project-avatar-image" src={icon} alt="" />
        : <span className="project-avatar-text">{projectInitial(project)}</span>}
    </span>
  );
}
