# PR dashboard integration verification

Review the committed HEAD of `feature/pr-dashboard-integration` in
`/Users/kyson/03-projects/.worktrees/octiq-flow/feature/pr-dashboard-integration`.
The implementation includes all three Sol worker stacks and their follow-up
fixes, coordinator dispatch wiring, and the latest `develop` commit `fcdc4e8`.
The primary checkout and individual worker branches are not the combined review
target. Compare the integration branch with `develop`.

Checks completed on 24 September 2026:

- Combined `cargo test`: 553 library tests passed, one existing notification test
  ignored; 12 CLI and 16 notification binary tests passed.
- The browser-command routing regression confirms that later branch movement
  and working-copy changes cannot change an already selected local diff.
- After adding pinned head/base/trigger evidence to ticket-agent instructions,
  all 10 workflow tests passed again.
- `pnpm exec tsc -b --pretty false` passed; all 156 Vitest files and 1,452 tests
  passed in the integration checkout.
- Production Vite build passed to `/tmp/octiq-pr-dashboard-integrated-build`.
  The existing large-bundle warning remains. `web/dist` was not changed.
- `cargo fmt --check` and `git diff --check` passed.
- `scripts/test-pr-dashboard.mjs` passed against synthetic HTTP/WebSocket data
  in headless Chrome, without a real server, agent launch, PR, or ticket write.
  It covers exact-SHA lazy diffs, binary files, source lines beginning `+++`,
  read-only Study with a separate durable chat, merged-default tracking,
  approved completion, delayed save across PR navigation, ticket launch
  failure/retry, save-before-claim-before-start ordering, confirmation withheld
  while the agent is busy, explicit user confirmation, unavailable GitHub with
  Local still usable, and a 390px viewport without horizontal overflow.
- Desktop and mobile screenshots were inspected. Radio controls were corrected
  after that inspection; the browser checks and production build passed again.

Run the browser checks from the repo root. `PLAYWRIGHT_MODULE` may point to an
isolated Playwright installation; `OCTIQ_TEST_BROWSER` defaults to installed
Chrome. The script creates its own temporary Vite server and prints the path
to its screenshots. The development run used
`/tmp/octiq-pr-dashboard-tools/node_modules/playwright/index.mjs`.

The remaining step is independent read-only Sol review. No live deployment,
GitHub publication, external ticket update, push, or server restart occurred.
