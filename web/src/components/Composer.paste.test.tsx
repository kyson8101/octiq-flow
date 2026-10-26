import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
import { AttachmentChip, type Attachment } from "./Composer";
import { Drafts } from "../lib/drafts";
import { attachmentPrompt, PASTED_TEXT_HEADING } from "../lib/attachmentPrompt";
import { frontDeskText } from "../lib/frontDesk";
import { reclaimedMessage } from "../lib/messageQueue";
import type { Message } from "../lib/chat";

const pasted: Attachment = { path: "/attachments/paste.txt", name: "pasted-text.txt", isImage: false, pasted: { text: "字😀\r\nexact", lines: 2 } };
const file: Attachment = { path: "/attachments/log.txt", name: "log.txt", isImage: false };
const image: Attachment = { path: "/attachments/shot.png", name: "shot.png", isImage: true };
const render = (attachment: Attachment) => renderToStaticMarkup(<AttachmentChip attachment={attachment} onRemove={() => {}} onInsert={() => {}} />);

describe("pasted text attachment", () => {
  it("renders a path tooltip, line label and real Insert as text/Remove buttons", () => {
    const html = render(pasted);
    expect(html).toContain('title="/attachments/paste.txt"');
    expect(html).toContain("Pasted text · 2 lines");
    expect(html).toContain('class="chip-insert" type="button"');
    expect(html).toContain(">Insert as text</button>");
    expect(html).toContain('aria-label="Remove Pasted text · 2 lines"');
    expect(html).not.toContain("字😀");
  });
  it("renders a restored attachment without undo metadata as an ordinary file", () => {
    const html = render({ ...pasted, pasted: undefined });
    expect(html).toContain("pasted-text.txt");
    expect(html).not.toContain("Insert as text");
  });
  it("keeps exact original text through chat draft take/keep and clear snapshots", () => {
    const drafts = new Drafts<Attachment>();
    const cleared = { text: "draft", attached: [pasted] };
    drafts.keep("a", cleared);
    drafts.keep("b", { text: "other", attached: [] });
    expect(drafts.take("a").attached[0].pasted?.text).toBe("字😀\r\nexact");
  });
  it("requires pasted files as message content, keeping ordinary files separate", () => {
    expect(attachmentPrompt("Read this", [pasted, file, image])).toBe(`Read this\n\n${PASTED_TEXT_HEADING}\n- ${pasted.path}\n\nFiles to look at:\n- ${file.path}`);
    expect(attachmentPrompt("", [pasted])).toBe(`${PASTED_TEXT_HEADING}\n- ${pasted.path}`);
    expect(attachmentPrompt(" hello ", [])).toBe(" hello ");
  });
  it("keeps every front desk path and marks pasted content as required", () => {
    expect(frontDeskText("Read this", [pasted, file, image])).toBe(`Read this\n\n${PASTED_TEXT_HEADING}\n- ${pasted.path}\n\nAttachments:\n- ${file.path}\n- ${image.path} (image)`);
  });
  it.each([false, true])("reclaims generated references and restores in-memory undo metadata (front desk %s)", (desk) => {
    const attachments = [pasted, file, image].map(({ path, name, isImage }) => ({ path, name, isImage }));
    const message: Message = { id: "user", role: "user", streaming: false, attachments, blocks: [{ kind: "text", text: attachmentPrompt("Read this", [pasted, file, image], desk) }] };
    const reclaimed = reclaimedMessage(message, new Map([[pasted.path, pasted.pasted!]]));
    expect(reclaimed.text).toBe("Read this");
    expect(reclaimed.attachments[0].pasted?.text).toBe(pasted.pasted!.text);
    expect(reclaimedMessage(message).attachments[0]).not.toHaveProperty("pasted");
  });
});
