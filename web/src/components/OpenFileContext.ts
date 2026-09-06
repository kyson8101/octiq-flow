// The lightweight context shared by file-opening controls. Kept apart from
// OpenFile.tsx so a small renderer such as ProseLink does not import the bridge
// singleton merely to obtain the callback.
import { createContext, useContext } from "react";

export type OpenFile = (path: string) => void;

export const OpenFileContext = createContext<OpenFile>(() => {});
export const CloseFileContext = createContext<() => void>(() => {});

/** Open a file: an HTML page in the native browser, a picture or PDF full
 * screen, anything else in the column beside the chat. */
export function useOpenFile(): OpenFile {
  return useContext(OpenFileContext);
}

/** Put away whatever file is on screen, in either window. */
export function useCloseFile(): () => void {
  return useContext(CloseFileContext);
}
