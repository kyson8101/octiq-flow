// A link inside a reply.
//
// The default anchor walks the whole app off the page: one click on a link an
// agent wrote and the chat, the live stream and the scroll position are gone,
// with the back button the only way home. Cmd+click (Ctrl elsewhere) always
// did the right thing, because that is the browser's own gesture — so this
// makes every click do what Cmd+click already did.
import type React from "react";

/** react-markdown hands every custom component the hast `node` it came from.
 *  It is a parser detail, not an attribute, and React would try to render it. */
type Props = React.ComponentPropsWithoutRef<"a"> & { node?: unknown };

export function ProseLink({ href, children, node: _node, ...rest }: Props) {
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
