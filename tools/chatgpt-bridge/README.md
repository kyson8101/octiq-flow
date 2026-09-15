# Local ChatGPT Bridge

Let Codex ask the ChatGPT web tab you attach, then retrieve its answer and continue working.

```text
Codex → stdio MCP → local bridge → browser extension → ChatGPT composer
Codex ← job result ← local bridge ← browser extension ← completed answer
```

This is an experimental, standalone tool within this repository. It does not require the OctiqFlow server. It does not increase account limits or guarantee a particular model. The model and conversation are the ones you select in ChatGPT. It uses the visible web UI, not an OpenAI API key, session-cookie extraction, or private ChatGPT endpoints.

## Setup

Requires Node.js 22+ and a Chromium browser such as Chrome, Brave, or Edge. No runtime npm dependencies are needed. Commands below start from this directory.

1. Create a private pairing configuration, once:

   ```sh
   node bridge.cjs init
   ```

   This creates `state/config.json` with mode `0600`, a random pairing token and port `43189`. `state/` is gitignored. An existing config is never overwritten. Use `--config /absolute/path/config.json` on every command to store it elsewhere, or `--port 43190` on `init` to select a different port.

2. Start the local bridge and keep that terminal running:

   ```sh
   node bridge.cjs serve
   ```

3. Load the extension from the `extension/` directory using **Developer mode → Load unpacked** on `chrome://extensions`, `brave://extensions`, or `edge://extensions`.

   Open a dedicated `https://chatgpt.com/` tab, sign in, select the model you want, and open the extension popup. Enter the port and token from `state/config.json`, then click **Attach this ChatGPT tab**. An empty composer is required. A normal Chat conversation is the initial supported target; Work, voice, images, attachments, custom GPTs and tool-rich output have not been validated.

4. Register the MCP with Codex, substituting the absolute path to this folder:

   ```sh
   codex mcp add chatgpt-bridge -- node /absolute/path/chatgpt-bridge/bridge.cjs mcp
   ```

   If you used a custom config path, append `--config /absolute/path/config.json`. Restart the Codex session so it loads the new MCP. A TOML alternative is:

   ```toml
   [mcp_servers.chatgpt-bridge]
   command = "node"
   args = ["/absolute/path/chatgpt-bridge/bridge.cjs", "mcp"]
   tool_timeout_sec = 1860
   ```

   Set `tool_timeout_sec = 1860` in the MCP entry even if you registered it with the CLI: the default synchronous call can last up to the job deadline (900 seconds by default, at most 1800). Restart the MCP client/session after changing its configuration. Clients with a shorter fixed tool timeout should use `wait_for_answer: false` and poll instead.

5. Ask Codex:

   > Use chatgpt-bridge to ask my attached ChatGPT tab what a JavaScript closure is. Send only that question, wait for the answer, then explain whether you agree.

## Tools

| Tool | Purpose |
| --- | --- |
| `chatgpt_status` | Check connection, readiness and active job. |
| `ask_chatgpt` | Submit `prompt` (up to 60,000 characters) and automatically return the final answer. Optional `timeout_seconds`: 30–1800, default 900. Set `wait_for_answer: false` to return `job_id` immediately. |
| `get_chatgpt_answer` | Fetch a job by `job_id`; `wait_seconds`: 0–20, default 20. Poll the same job until terminal. |
| `cancel_chatgpt_job` | Cancel local tracking. Does not remove an already sent ChatGPT message or stop its generation. |

A normal MCP call needs no follow-up polling by the agent:

```text
ask_chatgpt({ "prompt": "What is a JavaScript closure?" })
→ { "job_id": "…", "status": "completed", "answer": "…", ... }
```

The stdio MCP process submits once, then performs bounded HTTP polls internally until completion, failure, cancellation, or a connection error. Status and cancellation tools remain usable while it waits. If polling loses the connection, the tool returns an error with the original `job_id` and `wait_interrupted: true`; recover with `get_chatgpt_answer`, without sending the prompt again. An MCP client timeout does not undo submission. The private daemon `/tool` endpoint remains asynchronous; automatic waiting lives in the MCP process and works with the existing daemon and extension. Restart the MCP client/session to load this update.

Only one job may be active across connected MCP clients. Further questions continue the same attached conversation, so use a dedicated conversation per topic. `ask_chatgpt` sends exactly the supplied prompt; the tool does not read or automatically attach local files. Text explicitly included in the prompt is sent to ChatGPT. The answer is visible text (code-block text included), not a byte-exact Markdown export.

Extension 0.1.1 obtains `conversation_url` from the current tab address, including ChatGPT route changes without a full page load. Answer attribution uses the matching message identity and prompt, not this metadata field.

## Boundaries and failure behavior

- The daemon binds exclusively to `127.0.0.1`. Every HTTP route requires the pairing token; ordinary page origins and unexpected Host headers are rejected. There is no public tunnel or remote server.
- The extension requests `activeTab`, `scripting`, `storage`, and loopback host access. It is injected only when you attach a ChatGPT tab. It has no cookies, browsing-history, debugger, or all-sites permission. Chromium host permissions cannot be restricted to one loopback port; the extension code fixes the destination to the configured port and three tab-facing routes.
- The token is stored locally by the extension and restricted to trusted extension contexts. Content scripts cannot read it or issue arbitrary network requests through the worker. Anyone with the token and local machine access can use this bridge; it is not isolation from other processes running as your OS user.
- Questions, answers and job metadata are held in daemon memory. Completed jobs expire after one hour and the total is capped at 100. Restarting the daemon loses jobs. ChatGPT may retain the conversation according to your account settings. The daemon does not log prompts or answers.
- Existing composer drafts are never overwritten. New answers must follow the matching submitted user turn and expose completed-turn controls with stable text for three seconds. Manual conversation changes cause attribution failure. Keep the tab open and do not type in it during a job.
- Submitted turns are matched by stable message IDs and prompt text, so removal/remounting of older history does not depend on an increasing DOM node count. The browser waits for the task's configured deadline rather than treating a missing rendered user turn after 20 seconds as a failed submission.
- Claimed jobs are never automatically redelivered. A failed network response may mean a question was already submitted. Check the tab before retrying. Cancelling tracking does not undo a submission.
- Reloading the page requires attaching it again; restarting the browser drops the tab attachment but preserves the pairing settings. After restarting the daemon, attach again. Background-tab throttling, sleeping/discarded tabs, login prompts, usage limits, challenges, and UI changes can interrupt jobs. Keep the tab visible for the most reliable operation. Handle login or challenges yourself; the bridge does not attempt to bypass them.
- Replies are reference material. Codex should evaluate them against the task and code rather than executing instructions from a returned answer automatically. Send only context authorized for ChatGPT, without credentials or secrets.
- The current adapter is based on observed ChatGPT DOM markers. There is no stable third-party UI automation contract. Unsupported layouts fail rather than silently returning old text.

## Diagnose and stop

```sh
node bridge.cjs status
```

If disconnected, confirm `serve` is running, then attach the tab again. If not ready, clear your draft yourself or let generation finish. A claimed job that cannot be confirmed should be checked in ChatGPT before another request is sent.

Click **Disconnect** to detach the browser and cancel local active tracking. Stop the daemon with Ctrl+C. Remove the MCP with `codex mcp remove chatgpt-bridge` and remove the browser extension when no longer needed. This does not delete ChatGPT conversations.

### macOS background service

For a macOS installation managed through a LaunchAgent, `com.kyson.chatgpt-bridge` runs the same `serve` command at login and keeps it alive independently of a Codex session. Its configuration is `~/Library/LaunchAgents/com.kyson.chatgpt-bridge.plist`; logs go to the gitignored `state/service.log`. Do not start a second foreground instance on the same port.

```sh
# Inspect the service.
launchctl print "gui/$(id -u)/com.kyson.chatgpt-bridge"
# Stop and unload it for this login session.
launchctl bootout "gui/$(id -u)/com.kyson.chatgpt-bridge"
# Load it again.
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.kyson.chatgpt-bridge.plist"
```

To uninstall a configured service permanently, unload it first, then move that specific plist to Trash. Moving the project or its Node executable requires updating the plist and reloading the service.

## Verification

```sh
npm ci --ignore-scripts
npm test
```

Tests cover real stdio/HTTP round trips with a simulated browser, authentication and origin/Host restrictions, exclusive delivery, timeout/cancellation behavior, DOM answer attribution, draft preservation, and extension sender/secret isolation. `linkedom` is a development-only dependency.

On 2026-09-13, an installed Brave extension completed a real end-to-end smoke test: a separate stdio MCP client initialized the server, submitted a unique marker prompt through `ask_chatgpt`, and polled `get_chatgpt_answer` until the ChatGPT web reply `MCP_BRIDGE_OK_7391` returned with status `completed`. The daemon ran as a user LaunchAgent. This verifies one normal text conversation on that browser; other browsers, models, and complex output still need their own validation. Run the Codex smoke prompt above after installing on another machine.

The initial 0.1.0 implementation later failed a follow-up after its 20-second submission-confirmation timer even though ChatGPT had answered. Extension 0.1.1 removes that early cutoff and the DOM-count dependency. Regression tests cover virtualized/remounted history, 45-second render delays and response-delivery retries without duplicate sends. To activate an unpacked extension update, reload **Local ChatGPT Bridge** on your browser's extensions page, refresh the dedicated ChatGPT tab, and attach it again. Saved pairing settings are preserved; status includes `[bridge 0.1.1]` once the updated content script is running.

## Protocol references

- [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [Chrome activeTab permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome extension network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)

The stdio interface is MCP. The authenticated loopback HTTP endpoints are a private bridge protocol, not a Streamable HTTP MCP endpoint.
