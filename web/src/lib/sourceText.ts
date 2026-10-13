// Source read as text, for the tests that hold a hand-off to its spelling.
//
// Such a test reads a file with `?raw` and matches it. Git for Windows
// checks files out with CRLF line ends by default (`core.autocrlf=true`, and
// this repository has no `.gitattributes`), so a pattern or a replacement
// that names `\n` finds nothing there: a `/…\n/` match came back `null` and
// `![0]` threw, on a tree that was right. A test that reads source reads it
// through `lf`, once, where it is imported, and may then write `\n`.

/** The text with every line end as one line feed. */
export function lf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
