export type FolderEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  /** Older backends omit this; dot-prefixed folders are still hidden. */
  is_hidden?: boolean;
};

// Paths belong to the server, which may run a different OS from the browser.
function pathRoot(path: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(path)) return path.slice(0, 3);
  const share = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.exec(path);
  if (share) return share[0];
  return path.startsWith("/") ? "/" : null;
}

export function isAbsoluteFolderPath(path: string): boolean {
  return pathRoot(path) !== null;
}

/** Keep drive separators and stop at a UNC share, never its server name. */
export function parentFolderPath(path: string): string | null {
  const root = pathRoot(path);
  if (!root) return null;
  const trimmed = path.replace(root === "/" ? /\/+$/ : /[\\/]+$/, "");
  if (trimmed.length <= root.length) return null;
  const at = root === "/"
    ? trimmed.lastIndexOf("/")
    : Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at < root.length ? root : trimmed.slice(0, at);
}

/** Hide folders only; file mode can still pick configuration files like .env. */
export function visiblePickerEntries(entries: FolderEntry[], files: boolean): FolderEntry[] {
  return entries.filter((entry) => entry.is_dir
    ? !entry.is_hidden && !entry.name.startsWith(".")
    : files);
}
