import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AttentionInbox, AttentionInboxPanel, type AttentionInboxProps } from "./AttentionInbox";
import type { AttentionEntry } from "../lib/attention";

const entry: AttentionEntry = {
  conversation: { id: "c", projectId: "p", title: "Fix retries", messages: [], createdAt: 0, updatedAt: 0 },
  projectName: "OctiqFlow", kind: "completed", reason: "New reply ready to review", stale: false,
};
const props: AttentionInboxProps = { entries: [entry], connected: true, onOpen: () => {}, onDismissCompletion: () => {} };

describe("attention inbox", () => {
  it("starts as a compact accessible disclosure with the current count", () => {
    const html = renderToStaticMarkup(<AttentionInbox {...props} />);
    expect(html).toContain('aria-label="Attention inbox, 1 item"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("aria-controls=");
    expect(html).not.toContain("Fix retries");
  });
  it("renders project, conversation and reason in a direct navigation button", () => {
    const html = renderToStaticMarkup(<AttentionInboxPanel {...props} />);
    expect(html).toContain("OctiqFlow");
    expect(html).toContain("Fix retries");
    expect(html).toContain("New reply ready to review");
    expect(html).toContain('class="attention-open"');
    expect(html).toContain('aria-label="Dismiss completion for Fix retries"');
  });
  it("does not provide dismiss controls for unresolved requests", () => {
    const html = renderToStaticMarkup(<AttentionInboxPanel {...props} entries={[{ ...entry, kind: "permission", reason: "1 permission request" }]} />);
    expect(html).not.toContain("attention-dismiss");
    expect(html).toContain("1 permission request");
  });
  it("makes offline limits and stale records explicit", () => {
    const html = renderToStaticMarkup(<AttentionInboxPanel {...props} connected={false} entries={[{ ...entry, kind: "failure", stale: true }]} />);
    expect(html).toContain("Live requests will update after reconnecting");
    expect(html).toContain("last known");
  });
  it("describes an empty inbox without claiming all unopened chats were checked", () => {
    const html = renderToStaticMarkup(<AttentionInboxPanel {...props} entries={[]} />);
    expect(html).toContain("Unopened history is not checked");
    expect(html).not.toContain("attention-dismiss");
  });
});
