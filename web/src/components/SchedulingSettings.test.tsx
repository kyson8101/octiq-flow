import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn(), on: () => () => {}, onState: () => () => {} } }));
import { SchedulingBlock } from "./SchedulingSettings";
const props = { settings: { orientation: "agents" as const, hostCap: 4 }, unread: false, loading: false, busy: false,
  running: 2, error: "", done: false, changed: true, onChange: () => {}, onSave: () => {} };
it("offers no Save if scheduling was unread", () => {
  const html = renderToStaticMarkup(<SchedulingBlock {...props} unread error="The profile folder is away." />);
  expect(html).not.toContain("Save scheduling");
  expect(html).toContain("<details"); expect(html).toContain("The profile folder is away.");
});
it("keeps refusal words behind a disclosure and never says Saved", () => {
  const html = renderToStaticMarkup(<SchedulingBlock {...props} error="Cannot change orientation while workers run." done />);
  expect(html).toContain("<summary>Not saved</summary><p>Cannot change orientation while workers run.</p>");
  expect(html).not.toContain(">Saved<");
  expect(html).toContain("2 workers running now");
  expect(html).toContain("one batch at a time");
  expect(html).not.toContain("Parallel tasks");
});

it("explains orientation when Agents mode is off without merging the settings", () => {
  expect(renderToStaticMarkup(<SchedulingBlock {...props} agentsMode={false} />)).toContain("Agents orientation takes effect when Agents mode is on.");
  expect(renderToStaticMarkup(<SchedulingBlock {...props} agentsMode />)).not.toContain("Agents orientation takes effect when Agents mode is on.");
});
