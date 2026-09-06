// A link inside a reply.
//
// The default anchor walks the whole app off the page: one click on a link an
// agent wrote and the chat, the live stream and the scroll position are gone,
// with the back button the only way home. Cmd+click (Ctrl elsewhere) always
// did the right thing, because that is the browser's own gesture — so this
// makes every click do what Cmd+click already did.
import type React from "react";
import { useOpenFile } from "./OpenFileContext";

/** react-markdown hands every custom component the hast `node` it came from.
 *  It is a parser detail, not an attribute, and React would try to render it. */
type Props = React.ComponentPropsWithoutRef<"a"> & { node?: unknown };

/** A Markdown destination beginning with `/` is an absolute file path in an
 * agent reply. Leaving it as an href makes the browser resolve it against the
 * app origin (`https://optiqflow.app/Users/...`) instead of opening the file
 * panel. Decode Markdown's URL escaping and drop the optional line suffix used
 * by clickable file references before handing the path to the preview. */
function localFilePath(href: string | undefined): string | null {
  if (!href?.startsWith("/")) return null;
  let path = href;
  try {
    path = decodeURIComponent(href);
  } catch {
    // A malformed escape is still a path. The file panel will give the useful
    // "not a file" answer if it does not exist.
  }
  return path.replace(/:\d+(?::\d+)?$/, "");
}

export function ProseLink({ href, children, node: _node, ...rest }: Props) {
  const openFile = useOpenFile();
  const path = localFilePath(href);

  if (path) {
    return (
      <button className="prose-path" type="button" title={path} onClick={() => openFile(path)}>
        {children}
      </button>
    );
  }

  // react-markdown empties the href of a scheme it will not vouch for
  // (`file://`, `javascript:`). That is no longer somewhere to go, and opening
  // a new tab onto ourselves is worse than leaving the words as words.
  if (!href) return <span>{children}</span>;

  // `noopener` so the new tab cannot reach back through `window.opener`;
  // `noreferrer` so we do not hand our URL — token and all — to the site.
  return (
    <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}
