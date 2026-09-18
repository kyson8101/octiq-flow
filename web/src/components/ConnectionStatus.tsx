import type { ConnectionState } from "../lib/bridge";

/** A quiet, persistent home for the socket state in the app chrome.
 *
 * The conversation remains usable while the browser reconnects, so this is an
 * indicator rather than a banner. The full wording stays available to screen
 * readers and in the native hover tooltip without taking a row from the app. */
export function ConnectionStatus({ state }: { state: ConnectionState }) {
  if (state === "open" || state === "unauthorized") return null;

  const label = state === "connecting" ? "Connecting to OctiqFlow" : "Reconnecting to OctiqFlow";

  return (
    <span className="connection-status" role="status" aria-label={label} title={label}>
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="2.5" y="8.5" width="5" height="7" rx="1.5" />
        <path className="connection-status-link" d="M9.5 12h5" />
        <rect x="16.5" y="8.5" width="5" height="7" rx="1.5" />
      </svg>
    </span>
  );
}
