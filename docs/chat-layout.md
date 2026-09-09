# Chat workspace

Chats open in a single workspace. Select another chat from the sidebar to switch
conversations; browser Back and Forward return to previously visited chats.
Switching chats preserves drafts and leaves server-owned agents running.

Project links (`#/p/<project>/c/<chat-id>`) and direct chat links (`#/c/<chat-id>`)
remain supported. Retired `#/split?...` bookmarks open their focused chat in the
single workspace, falling back to an available target if necessary. Old saved
split layouts and widths are ignored.

## Browser regression check

Run a Vite dev server, then `node scripts/test-chat-layout.mjs`.
`PLAYWRIGHT_MODULE` can point to an isolated Playwright installation;
`OCTIQ_TEST_URL` overrides the default `http://127.0.0.1:5273/`.
All auth and WebSocket RPCs are mocked: no real agents or projects are modified.
The check covers single-workspace rendering, draft preservation, Back/Forward,
legacy bookmarks, reload, missing chats, mobile actions, and send/stop routing.
Screenshots go to a unique temporary directory printed by the script.
