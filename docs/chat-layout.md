# Cross-project chat panes

Use **Open beside** on a sidebar chat, or the split icon in Chat actions to
search across projects. The chosen chat opens in the opposite pane. Selecting
an already-visible chat focuses that pane instead of opening a second composer.
Each pane owns its project, input draft, transcript, Files, Git and Terminal.

A split has a shareable URL:

```
#/split?left=<chat-id>&right=<chat-id>&focus=right
```

Old `#/p/<project>/c/<chat-id>` links remain valid. Chat IDs resolve their
projects through the existing server index. Navigation pushes browser history;
changing focus replaces the current entry. Refresh and Back/Forward restore the
layout. **Only this chat** leaves split mode, and **Return to split chat** restores
the latest split (also remembered locally). Selecting a chat inside one pane
changes only that pane.

Drag the divider to resize, or focus it and use Left/Right arrows. Home or a
double-click resets to equal widths. Width is stored locally, outside the URL.
On narrow screens use the Left chat / Right chat buttons. A missing/deleted chat
shows an unavailable state without a composer.

## Implementation

`ChatLayout` is a navigation shell around same-origin chat frames. This keeps
existing DOM-scoped editors, file providers, keyboard shortcuts, working
directories and WebSocket clients isolated. There is no new agent execution
path. A hidden right frame remains mounted when leaving split mode so its draft
and scroll position survive returning; closing the browser still leaves agents
running on the server as before. Two panes therefore use two chat clients and
connections. Desktop notifications are emitted only by the left client, using
the outer window's focused chat to avoid duplicate notifications.

Only messages from the two known frame windows at the same origin can update
the layout. Child URLs do not create browser history entries. The outer URL
owns navigation, while commands use the existing chat loading path inside each
frame. Pending navigation suppresses stale reports during restoration.

## Validation

Run the web unit suite with `pnpm --dir web test` and type-check with
`pnpm --dir web exec tsc -b`.

For the browser regression, run `pnpm --dir web dev` in one terminal, then:

```sh
validation_dir=$(mktemp -d)
npm install --prefix "$validation_dir" playwright@1.63.0 --no-audit --no-fund
PLAYWRIGHT_MODULE="$validation_dir/node_modules/playwright/index.mjs" node scripts/test-chat-layout.mjs
```

The script uses installed Google Chrome by default (`OCTIQ_TEST_BROWSER` can
select another installed Playwright channel). `OCTIQ_TEST_URL` defaults to the
local Vite server. All authentication and WebSocket RPCs are mocked: no real
agent is started and no real project is modified. It covers cross-project
opening, independent drafts and navigation, Back/Forward, refresh, the saved
split, missing chats, mobile actions, focus, resizing, message-source checks,
and send/stop routing. Screenshots go to a unique temporary directory printed
by the script.
