// The text editor, on a phone.
//
// CodeMirror 6, not Monaco. The desktop client vendors Monaco (src/filetabs.js)
// and it is the wrong tool on a phone: it draws its own selection and caret on
// top of a hidden textarea, which fights the phone's native text handles, and
// it expects a window wide enough for a minimap. CodeMirror edits a real
// contenteditable, so tap-to-place-caret, the selection handles, autocomplete
// off the keyboard and the clipboard all behave the way they do in any other
// text field on the device. Its grammars are also separate downloads
// (lib/language.ts), so the editor is small until you open something exotic.
//
// Deliberately NOT switched on: autocompletion and linting. Both open floating
// panels the moment you type, and on a 390px screen a popup over the line you
// are editing is worse than no suggestion at all.
//
// The document lives in CodeMirror, not in React state. `initialDoc` seeds it
// once and is never read again — pushing every keystroke back down through a
// prop would fight the editor for control of the caret. The owner keeps up
// through `onChange`, and re-seeds by changing this component's `key`.
import { useEffect, useRef } from "react";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  rectangularSelection,
} from "@codemirror/view";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { languageFor } from "../lib/language";

/** Colours lifted from the terminal theme the desktop app ships, so a Rust file
 *  read in the editor and the same file printed by an agent in the terminal
 *  drawer are not two different-looking things. */
const HIGHLIGHT = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "#5c6370", fontStyle: "italic" },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword], color: "#c678dd" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#98c379" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#d19a66" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: "#61afef" },
  { tag: [t.typeName, t.className, t.namespace, t.self], color: "#e5c07b" },
  { tag: [t.propertyName, t.attributeName], color: "#e06c75" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "#c9c9c5" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "#abb2bf" },
  { tag: [t.tagName], color: "#e06c75" },
  { tag: [t.heading], color: "#61afef", fontWeight: "600" },
  { tag: [t.link, t.url], color: "#56b6c2", textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "600" },
  { tag: [t.invalid], color: "#e06c75" },
]);

/** The editor's own chrome. Sizes come from CSS custom properties rather than
 *  literals so styles.css can raise the text to 16px on a narrow screen — below
 *  that, iOS Safari zooms the whole page the moment the field takes focus, and
 *  the user is left panning a document that no longer fits. */
const THEME = EditorView.theme(
  {
    "&": {
      height: "100%",
      fontSize: "var(--ws-code-size)",
      backgroundColor: "var(--bg-0)",
      color: "var(--fg-1)",
    },
    ".cm-scroller": {
      fontFamily: "var(--mono)",
      lineHeight: "1.55",
      overflow: "auto",
      // Clear of the home indicator, and of the phone's own keyboard toolbar.
      paddingBottom: "calc(28px + env(safe-area-inset-bottom))",
    },
    ".cm-content": { caretColor: "var(--accent)", padding: "10px 0 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(10, 132, 255, 0.28)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--bg-0)",
      color: "var(--fg-3)",
      border: "0",
      paddingRight: "4px",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.035)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg-2)" },
    ".cm-selectionMatch": { backgroundColor: "rgba(229, 192, 123, 0.2)" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(10, 132, 255, 0.24)",
      outline: "0",
    },
    ".cm-panels": { backgroundColor: "var(--bg-sunken)", color: "var(--fg-1)" },
    ".cm-panels input, .cm-panels button": {
      backgroundColor: "var(--bg-1)",
      color: "var(--fg-1)",
      border: "1px solid var(--border)",
      borderRadius: "var(--r-sm)",
      padding: "3px 6px",
      font: "inherit",
    },
  },
  { dark: true },
);

export function CodeEditor({
  path,
  initialDoc,
  readOnly = false,
  onChange,
  onSave,
  onSelect,
}: {
  /** Only used to pick the grammar. Changing it does NOT reload the document —
   *  give the component a new `key` for that. */
  path: string;
  initialDoc: string;
  /** A file we could not read in full is shown but not editable: an edit that
   *  can never be saved is a trap, not a feature. */
  readOnly?: boolean;
  onChange: (text: string) => void;
  /** ⌘S / Ctrl-S. Returns nothing; the owner decides whether a save is possible. */
  onSave: () => void;
  /** Card 89 — what is highlighted, in CHARACTER OFFSETS.
   *
   *  The chat dock offers to put a highlight into the prompt box with the lines
   *  it came from, and it used to read those straight off a `<textarea>`'s
   *  `selectionStart`. This editor has no textarea to ask. Finding the text in
   *  the document with `indexOf` would be near enough most of the time and
   *  wrong exactly when it matters — a short snippet that appears twice would
   *  be quoted against the first line it happens to match. So the editor, which
   *  is the only thing that actually knows, says. */
  onSelect?: (sel: { from: number; to: number; text: string }) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // The keymap and the update listener are baked into the state at creation, so
  // they close over whatever the callbacks were then. These keep them pointing
  // at the current ones instead of a stale render's.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onSelectRef = useRef(onSelect);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onSelectRef.current = onSelect;

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    // Filled in later, once the grammar has downloaded. Held in a compartment
    // so it can be swapped into a running editor without rebuilding the state
    // and losing the caret.
    const language = new Compartment();

    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        rectangularSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true }),
        // Long lines wrap instead of scrolling sideways. A phone has no
        // horizontal room to spare, and a line you have to drag to read is a
        // line you do not read.
        EditorView.lineWrapping,
        indentUnit.of("  "),
        syntaxHighlighting(HIGHLIGHT),
        THEME,
        language.of([]),
        // Both, not one: `readOnly` alone leaves the content editable so text
        // can still be selected, which means a phone pops its keyboard up over
        // a file that will refuse every key. `editable` is what actually takes
        // the contenteditable away.
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        // The phone's keyboard treats a contenteditable like a message box
        // otherwise: capitalising every line, "correcting" identifiers, and
        // underlining half the file in red.
        EditorView.contentAttributes.of({
          autocapitalize: "off",
          autocorrect: "off",
          spellcheck: "false",
        }),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              onSaveRef.current();
              return true;
            },
          },
          // Escape hands the focus back to the page. Tab is bound to indent
          // below, which is what a code editor is for, so this is the way out
          // for anyone driving the app from the keyboard.
          {
            key: "Escape",
            run: (v) => {
              v.contentDOM.blur();
              return true;
            },
          },
          ...searchKeymap,
          ...historyKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          // Reported on every selection change, including the collapse to a
          // caret — the button that offers a quote has to GO when the highlight
          // does, not only appear when one is made.
          if (update.selectionSet || update.docChanged) {
            const { from, to } = update.state.selection.main;
            onSelectRef.current?.({
              from,
              to,
              text: from === to ? "" : update.state.doc.sliceString(from, to),
            });
          }
        }),
      ],
    });

    const editor = new EditorView({ state, parent });
    view.current = editor;

    let alive = true;
    languageFor(path)
      .then((support) => {
        // A grammar that arrives after the tab was closed has nowhere to go.
        if (!alive || !support) return;
        editor.dispatch({ effects: language.reconfigure(support as Extension) });
      })
      .catch(() => {
        /* the chunk failed to load: the file still opens, just without colour */
      });

    return () => {
      alive = false;
      editor.destroy();
      view.current = null;
    };
    // Built once. `initialDoc` and the callbacks are deliberately not
    // dependencies — see the note at the top of the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly]);

  // Tabs are kept mounted and hidden rather than unmounted, so the file you
  // switch away from keeps its caret, its scroll position and its undo history.
  // A hidden editor measures itself as zero-sized, so it has to be told to look
  // again when it comes back.
  useEffect(() => {
    const parent = host.current;
    if (!parent || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) view.current?.requestMeasure();
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  return <div className="ws-cm" ref={host} />;
}
