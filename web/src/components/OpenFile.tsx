// One owner for "show me that file".
//
// Two places ask for it now — a row in the files panel, and a path written into
// a reply — and there will be more. Each owning its own copy of the state would
// mean two viewers able to be open at once, and a file opened from a reply
// vanishing the moment the files panel it happened to live inside was closed.
//
// So the state lives above both, next to the confirm dialog and for the same
// reason: it is one thing the whole app shares. `useOpenFile()` hands back a
// function, and the caller does not have to know which of the two windows a
// given file wants.
import { createContext, useCallback, useContext, useState } from "react";
import { isImage, isPdf } from "../lib/files";
import { FilePanel } from "./FilePanel";
import { Viewer } from "./Viewer";

type Open = (path: string) => void;

const OpenFileContext = createContext<Open>(() => {});

/** Open a file: a picture or a PDF full screen, anything else in the side
 *  panel, where it can also be edited. */
export function useOpenFile(): Open {
  return useContext(OpenFileContext);
}

export function OpenFileProvider({ children }: { children: React.ReactNode }) {
  const [viewing, setViewing] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  const open = useCallback<Open>((path) => {
    // Whichever window this file wants, the other one closes. Two files on
    // screen at once is never what the click meant.
    if (isImage(path) || isPdf(path)) {
      setOpened(null);
      setViewing(path);
    } else {
      setViewing(null);
      setOpened(path);
    }
  }, []);

  return (
    <OpenFileContext.Provider value={open}>
      {children}
      {viewing && <Viewer path={viewing} onClose={() => setViewing(null)} />}
      {opened && <FilePanel path={opened} onClose={() => setOpened(null)} />}
    </OpenFileContext.Provider>
  );
}
