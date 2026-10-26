export const PASTED_TEXT_HEADING = "Pasted text (read it, it is part of this message):";

/** Only metadata is used here; the original paste never enters the prompt. */
export function attachmentPrompt(
  text: string,
  attachments: readonly { path: string; isImage?: boolean; pasted?: unknown }[],
  frontDesk = false,
): string {
  const pasted = attachments.filter((a) => !!a.pasted);
  const other = attachments.filter((a) => !a.pasted && (frontDesk || !a.isImage));
  const sections = [text];
  if (pasted.length) sections.push(`${PASTED_TEXT_HEADING}\n${pasted.map((a) => `- ${a.path}`).join("\n")}`);
  if (other.length) sections.push(`${frontDesk ? "Attachments:" : "Files to look at:"}\n${other.map((a) => `- ${a.path}${frontDesk && a.isImage ? " (image)" : ""}`).join("\n")}`);
  return sections.length === 1 ? text : sections.join("\n\n").trim();
}
