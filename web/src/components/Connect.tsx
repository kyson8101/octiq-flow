// The way in.
//
// This screen exists because of a specific failure: a browser that lands on the
// app with no access token gets its socket refused, and a refused handshake is
// indistinguishable from an unreachable server. The old behaviour was to
// retry forever behind a "Reconnecting…" banner, which is both wrong and
// unfixable by the person reading it.
//
// So when the server says the token is bad, we say so, and give somewhere to
// put a good one.
import { useState } from "react";
import { bridge } from "../lib/bridge";

export function Connect() {
  const [token, setToken] = useState("");

  return (
    <div className="gate">
      <div className="gate-card">
        <h1 className="gate-title">Connect to OctiqFlow</h1>
        <p className="gate-body">
          This browser needs the access token of the machine running OctiqFlow. It is printed in
          that machine's terminal at startup, and stored in <code>web.json</code> inside its
          profile folder.
        </p>

        <form
          className="gate-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) bridge.useToken(token);
          }}
        >
          <input
            className="gate-input"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste the token"
            autoFocus
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
          />
          <button className="gate-btn" type="submit" disabled={!token.trim()}>
            Connect
          </button>
        </form>

        <p className="gate-hint">
          Opening the full link the server prints — the one ending in <code>?token=…</code> — does
          this for you and is remembered afterwards.
        </p>
      </div>
    </div>
  );
}
