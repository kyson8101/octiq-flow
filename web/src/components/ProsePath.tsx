// A file path inside a reply, and what happens when you click it.
//
// `rehypeFilePaths` marks anything shaped like a path. This decides whether it
// was one: the path is looked up in the shared store, and until that store says
// the file EXISTS the words render exactly as they were written. So a version
// number, a domain, a filename an agent invented while explaining itself — all
// of them stay plain text, and nothing on screen ever offers to open something
// that is not there.
//
// The answer usually arrives before the words do. The files panel scans the
// same transcript for the same strings, so by the time a reply has finished
// streaming most of its paths are already known and the link is simply there.
// When it is not, the word turns into a link a moment later, which is the one
// place this shows its working.
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { askPaths, knownPath, subscribePaths } from "../lib/pathStore";
import { useOpenFile } from "./OpenFile";

/** The folder a relative path in a reply is relative TO — the project's own,
 *  which only the app knows. Empty means "no project", and then only absolute
 *  paths can resolve. */
const CwdContext = createContext("");

export const PathCwdProvider = CwdContext.Provider;

export function ProsePath({
  path,
  code,
  children,
}: {
  /** The file to open, as the reply wrote it. Set by the plugin. */
  path?: string;
  /** Present when this was inline code, so it keeps looking like code. */
  code?: string;
  children?: React.ReactNode;
}) {
  const cwd = useContext(CwdContext);
  const open = useOpenFile();

  // The store is not React state, and several of these watch the same answer.
  // `useSyncExternalStore` is the one way to read it that cannot tear: every
  // path on screen sees the same map at the same render.
  const read = () => (path ? knownPath(path, cwd) : undefined);
  const target = useSyncExternalStore(subscribePaths, read, read);

  useEffect(() => {
    if (path) askPaths([path], cwd);
  }, [path, cwd]);

  // Not a file, or not yet known to be one. Either way: the words, as written.
  if (!path || !target) return code ? <code>{children}</code> : <>{children}</>;

  return (
    <button
      className={`prose-path ${code ? "is-code" : ""}`}
      type="button"
      // The whole resolved path, which is usually longer than what the reply
      // wrote — the answer to "which one of those is it" without opening it.
      title={target}
      onClick={() => open(target)}
    >
      {children}
    </button>
  );
}
