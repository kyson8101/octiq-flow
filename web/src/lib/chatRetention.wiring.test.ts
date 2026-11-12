// App owns the windows; this reads App.tsx as text for the hand-offs that keep
// a retained window honest (no test renders the app, so it is an alarm on the
// wiring's spelling, not a proof of behaviour).
import { describe, expect, it } from "vitest";
import app from "../App.tsx?raw";
import composerSource from "../components/Composer.tsx?raw";
import { lf } from "./sourceText";

const source = lf(app);

describe("retained windows in App", () => {
  it("never evicts a window holding a prompt only this tab has", () => {
    expect(source).toMatch(/recentChatWindows\.current\.retain\([^;]*hasLocalPrompt\(next\[id\]\)/s);
  });
  it("forgets a chat's reading state when its window is released, invalidated or deleted", () => {
    expect((source.match(/chatReadingStates\.forget\(id\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
  it("does not widen the transcript subscription for retained windows", () => {
    expect(source).toMatch(/bridge\.watchChats\(ids\.map\(keyFor\)\)/);
    expect(source).not.toMatch(/watchChats\([^)]*retained/);
  });
  it("draws the sidebar from the host, not a window that is behind it", () => {
    expect(source).toMatch(/getPreviewMessages=\{\(id\) => !behind\.has\(id\) && catchUp\.current\.holds/);
    expect(source).toMatch(/windowBehind\(activity\.seq,/);
  });
  it("never fetches a page for a preview or writes one it did not see on screen", () => {
    expect(source).not.toMatch(/refreshOffscreenResponse/);
    // The only chat_page reads left are the hover preview (on demand), the
    // visible pane's open/catch-up and Load earlier; none is started by a turn
    // ending in a chat no pane shows.
    const ended = source.slice(source.indexOf("// A turn that ended in a chat no pane shows"));
    expect(ended.slice(0, 600)).not.toMatch(/chat_page|readChatPreview/);
  });
  it("takes the host's preview through hostPreview when the index answers", () => {
    expect(source).toMatch(/\.\.\.hostPreview\(cached, r\)/);
  });
  it("carries the version it heard on every index save", () => {
    const saves = source.match(/saveIndexEntry\(\{[^}]*?latestResponse: [^\n]*\n/gs) ?? [];
    expect(saves.length).toBeGreaterThanOrEqual(5);
    expect(source.match(/latestResponseVersion: \w+\.latestResponseVersion/g)?.length).toBeGreaterThanOrEqual(5);
  });
  it("keeps no closure of an App render in a long-lived listener, context value or store", () => {
    // V8 shares one scope between the closures of a render; see oldRenderRetention.test.ts.
    expect(source).toMatch(/useEffect\(\(\) => watchReading\(conversationId, push\.setReading\), \[conversationId\]\)/);
    expect(source).not.toMatch(/const tell = /);
    expect(source).toMatch(/makePendingActionsView\(pendingByRow\(pendingList\)/);
    expect(source).not.toMatch(/forRow: \(chatId\)/);
    const composer = lf(composerSource);
    expect(composer).toMatch(/const receive = useCommittedCallback\(/);
    expect(composer).not.toMatch(/const receive = \(pending/);
  });
});
