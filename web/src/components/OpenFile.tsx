// One owner for "show me that file".
//
// Several places ask for it now — a row in the files panel, a path written into
// a reply, a file in the git panel — and there will be more. Each owning its
// own copy of the state would mean two viewers able to be open at once, and a
// file opened from a reply vanishing the moment the files panel it happened to
// live inside was closed.
//
// So the state lives above all of them, next to the confirm dialog and for the
// same reason: it is one thing the whole app shares. `useOpenFile()` hands back
// a function, and the caller does not have to know which of the two windows a
// given file wants.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { isImage, isPdf } from "../lib/files";
import { FilePanel } from "./FilePanel";
import { Viewer } from "./Viewer";

type Open = (path: string) => void;

const OpenFileContext = createContext<Open>(() => {});
const CloseFileContext = createContext<() => void>(() => {});

/** How long the panel takes to slide off a phone screen. Matches the transform
 *  transition in styles.css — unmount sooner and it disappears mid-slide. */
const SLIDE_MS = 220;

/** Open a file: a picture or a PDF full screen, anything else in the column
 *  beside the chat, where it can also be edited and quoted. */
export function useOpenFile(): Open {
  return useContext(OpenFileContext);
}

/** Put away whatever file is on screen, in either window.
 *
 *  The panel closes itself when its own X is clicked; this is for the caller
 *  that has nothing to do with the file — switching PROJECT. A file belongs to
 *  the project it was opened from, and left on screen beside the next
 *  project's chat it reads as one of that project's files. */
export function useCloseFile(): () => void {
  return useContext(CloseFileContext);
}

export function OpenFileProvider({ children }: { children: React.ReactNode }) {
  const [viewing, setViewing] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  /** The path the panel is still DRAWING, which outlives `opened` by one slide.
   *  Closing sets `opened` to null and leaves this, so the panel has a name to
   *  show on its way out. */
  const [drawn, setDrawn] = useState<string | null>(null);

  const close = useCallback(() => {
    setViewing(null);
    setOpened(null);
  }, []);

  const open = useCallback<Open>((path) => {
    // Whichever window this file wants, the other one closes. Two files on
    // screen at once is never what the click meant.
    if (isImage(path) || isPdf(path)) {
      setOpened(null);
      setViewing(path);
    } else {
      setViewing(null);
      setOpened(path);
      setDrawn(path);
    }
  }, []);

  useEffect(() => {
    if (opened) return;
    const timer = setTimeout(() => setDrawn(null), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [opened]);

  return (
    <OpenFileContext.Provider value={open}>
      <CloseFileContext.Provider value={close}>
        {children}
        {viewing && <Viewer path={viewing} onClose={() => setViewing(null)} />}
        {drawn && (
          <FilePanel path={drawn} open={!!opened} onClose={() => setOpened(null)} />
        )}
      </CloseFileContext.Provider>
    </OpenFileContext.Provider>
  );
}
