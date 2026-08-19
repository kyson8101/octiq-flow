// Which CodeMirror grammar a file gets, and when it is downloaded.
//
// Every entry here is behind `import()` on purpose. A grammar is a parse table
// — the JavaScript one alone is bigger than this whole app's own code — and
// bundling fifteen of them would make the editor cost half a megabyte before it
// showed a single character. Vite splits each into its own chunk, so opening a
// `.md` file fetches the markdown grammar and nothing else, and a phone on a
// slow connection pays only for the languages it actually opens.
//
// A file we have no grammar for still opens: `languageFor` answers null and the
// editor runs without highlighting rather than refusing the file.
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

/** Wrap one of the ported CodeMirror 5 modes as a language. These are line-based
 *  tokenizers rather than real parsers — weaker than the `lang-*` packages, but
 *  they cover the long tail (shell, C#, Go, TOML…) for a few kB each. */
const stream = (parser: StreamParser<unknown>): Extension => StreamLanguage.define(parser);

/** Extension (lower-case, no dot) -> the grammar to fetch for it. */
const BY_EXTENSION: Record<string, () => Promise<Extension>> = {
  // JavaScript and its dialects all come from one grammar with flags, so these
  // four share a chunk.
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  mjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  cjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  ts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  mts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  cts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  tsx: () =>
    import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true })),

  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  jsonc: () => import("@codemirror/lang-json").then((m) => m.json()),

  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  mdx: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),

  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  htm: () => import("@codemirror/lang-html").then((m) => m.html()),
  // Razor and Vue are not HTML, but the markup around their islands is, and
  // that is most of the file.
  cshtml: () => import("@codemirror/lang-html").then((m) => m.html()),
  vue: () => import("@codemirror/lang-html").then((m) => m.html()),

  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  // SCSS and Less are supersets: the CSS grammar reads the plain parts and
  // shrugs at the rest, which beats no colour at all.
  scss: () => import("@codemirror/lang-css").then((m) => m.css()),
  less: () => import("@codemirror/lang-css").then((m) => m.css()),

  rs: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  pyi: () => import("@codemirror/lang-python").then((m) => m.python()),
  sql: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  yml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),

  // The long tail, from the ported CodeMirror 5 modes.
  sh: () => import("@codemirror/legacy-modes/mode/shell").then((m) => stream(m.shell)),
  bash: () => import("@codemirror/legacy-modes/mode/shell").then((m) => stream(m.shell)),
  zsh: () => import("@codemirror/legacy-modes/mode/shell").then((m) => stream(m.shell)),
  fish: () => import("@codemirror/legacy-modes/mode/shell").then((m) => stream(m.shell)),
  cs: () => import("@codemirror/legacy-modes/mode/clike").then((m) => stream(m.csharp)),
  c: () => import("@codemirror/legacy-modes/mode/clike").then((m) => stream(m.c)),
  h: () => import("@codemirror/legacy-modes/mode/clike").then((m) => stream(m.c)),
  cpp: () => import("@codemirror/legacy-modes/mode/clike").then((m) => stream(m.cpp)),
  hpp: () => import("@codemirror/legacy-modes/mode/clike").then((m) => stream(m.cpp)),
  java: () => import("@codemirror/legacy-modes/mode/clike").then((m) => stream(m.java)),
  kt: () => import("@codemirror/legacy-modes/mode/clike").then((m) => stream(m.kotlin)),
  swift: () => import("@codemirror/legacy-modes/mode/swift").then((m) => stream(m.swift)),
  go: () => import("@codemirror/legacy-modes/mode/go").then((m) => stream(m.go)),
  rb: () => import("@codemirror/legacy-modes/mode/ruby").then((m) => stream(m.ruby)),
  lua: () => import("@codemirror/legacy-modes/mode/lua").then((m) => stream(m.lua)),
  toml: () => import("@codemirror/legacy-modes/mode/toml").then((m) => stream(m.toml)),
  xml: () => import("@codemirror/legacy-modes/mode/xml").then((m) => stream(m.xml)),
  svg: () => import("@codemirror/legacy-modes/mode/xml").then((m) => stream(m.xml)),
  xaml: () => import("@codemirror/legacy-modes/mode/xml").then((m) => stream(m.xml)),
  csproj: () => import("@codemirror/legacy-modes/mode/xml").then((m) => stream(m.xml)),
  diff: () => import("@codemirror/legacy-modes/mode/diff").then((m) => stream(m.diff)),
  patch: () => import("@codemirror/legacy-modes/mode/diff").then((m) => stream(m.diff)),
  ps1: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => stream(m.powerShell)),
  properties: () =>
    import("@codemirror/legacy-modes/mode/properties").then((m) => stream(m.properties)),
  ini: () => import("@codemirror/legacy-modes/mode/properties").then((m) => stream(m.properties)),
  env: () => import("@codemirror/legacy-modes/mode/properties").then((m) => stream(m.properties)),
};

/** Files that carry their language in their NAME rather than an extension.
 *  Matched case-insensitively on the whole basename, and on the part after the
 *  first dot too, so `Dockerfile.dev` and `.env.local` both land. */
const BY_NAME: Record<string, () => Promise<Extension>> = {
  dockerfile: () =>
    import("@codemirror/legacy-modes/mode/dockerfile").then((m) => stream(m.dockerFile)),
  makefile: () => import("@codemirror/legacy-modes/mode/shell").then((m) => stream(m.shell)),
  ".env": () => import("@codemirror/legacy-modes/mode/properties").then((m) => stream(m.properties)),
  ".gitignore": () =>
    import("@codemirror/legacy-modes/mode/properties").then((m) => stream(m.properties)),
  ".dockerignore": () =>
    import("@codemirror/legacy-modes/mode/properties").then((m) => stream(m.properties)),
  ".editorconfig": () =>
    import("@codemirror/legacy-modes/mode/properties").then((m) => stream(m.properties)),
};

/** The grammar for `path`, downloaded on demand, or null when we have none.
 *  Rejects only if the chunk itself fails to load — the caller treats that the
 *  same as "no grammar" and shows the file anyway. */
export async function languageFor(path: string): Promise<Extension | null> {
  const name = (path.split("/").pop() ?? path).toLowerCase();

  const byName = BY_NAME[name] ?? BY_NAME[name.slice(0, name.indexOf(".", 1))];
  if (byName) return byName();

  // The LAST dot wins, so `App.test.tsx` is tsx rather than "test.tsx". A
  // leading dot is part of the name (`.gitignore`), never an extension.
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const loader = BY_EXTENSION[name.slice(dot + 1)];
  return loader ? loader() : null;
}
