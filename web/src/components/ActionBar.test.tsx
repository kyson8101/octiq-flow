import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionBar, type BarAction } from "./ActionBar";
import { TasksButton } from "./ChatWorkflowBar";
import { ChatDeleteButton } from "./ChatDeleteButton";
import { CopyChatIdButton } from "./CopyChatIdButton";
import { FocusModeButton } from "./FocusMode";
import { FullscreenButton } from "./FullscreenButton";
import { InstalledReload } from "./InstalledReload";
import barCss from "./ActionBar.css?raw";
import stylesCss from "../styles.css?raw";
import appSource from "../App.tsx?raw";

// The buttons' modules reach the socket bridge, which opens a connection on import.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn(), on: vi.fn(() => () => {}), onState: vi.fn(() => () => {}) } }));

const button = (label: string) => <button type="button">{label}</button>;
const actions: BarAction[] = [
  { id: "tasks", keep: 100, attention: 2, node: button("Tasks") },
  { id: "git", keep: 85, node: button("Git") },
  { id: "copy", keep: 20, node: button("Copy ID") },
  { id: "delete", keep: 10, separated: true, node: button("Delete") },
];
const draw = (props: Partial<Parameters<typeof ActionBar>[0]> = {}) =>
  renderToStaticMarkup(<ActionBar actions={actions} scrolls={false} {...props} />);

describe("the action bar", () => {
  it("draws every action as a button of the row, in the order given", () => {
    const html = draw();
    const places = ["Tasks", "Git", "Copy ID", "Delete"].map((label) => html.indexOf(`>${label}<`));
    expect(places.every((place) => place > 0)).toBe(true);
    expect([...places].sort((a, b) => a - b)).toEqual(places);
    expect(html.match(/class="actionbar-item/g)).toHaveLength(4);
    // Nothing is behind a menu while everything fits.
    expect(html).not.toContain("mobile-actions");
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Actions"');
  });

  it("marks the destructive end with a rule", () => {
    expect(draw()).toContain('<span class="actionbar-item is-separated" data-action="delete">');
  });

  it("puts what does not fit behind one More, after what stays", () => {
    const html = draw({ initiallyOver: ["copy", "delete"], initiallyOpen: true });
    expect(html.match(/class="mobile-actions"/g)).toHaveLength(1);
    const more = html.indexOf('class="mobile-actions"');
    expect(html.indexOf(">Tasks<")).toBeLessThan(more);
    expect(html.indexOf(">Git<")).toBeLessThan(more);
    const menu = html.slice(html.indexOf('class="mobile-actions-panel"'));
    expect(menu).toContain("Copy ID");
    expect(menu.indexOf('role="separator"')).toBeGreaterThan(menu.indexOf("Copy ID"));
    expect(menu.indexOf('role="separator"')).toBeLessThan(menu.indexOf("Delete"));
    expect(html.match(/class="actionbar-item/g)).toHaveLength(2);
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain('<span class="topbar-action-label">More</span>');
  });

  it("keeps what waits on the person counted on More while its button is behind it", () => {
    const behind = draw({ initiallyOver: ["tasks", "copy", "delete"] });
    expect(behind).toContain('aria-label="More actions, 2 items need attention"');
    expect(behind).toContain('class="mobile-actions-attention"');
    expect(behind).toContain(">2</span>");
    // In the row the button carries its own mark, and More says nothing.
    const inRow = draw({ initiallyOver: ["copy", "delete"] });
    expect(inRow).toContain('aria-label="More actions"');
    expect(inRow).not.toContain("mobile-actions-attention");
  });

  it("puts nothing behind More on a phone: the row scrolls", () => {
    const html = draw({ scrolls: true, initiallyOver: ["copy", "delete"] });
    expect(html).toContain('class="actionbar is-scrolling"');
    expect(html).not.toContain("mobile-actions");
    expect(html.match(/class="actionbar-item/g)).toHaveLength(4);
  });

  it("keeps a page's own buttons ahead of the row and a phone's usage after it", () => {
    const html = draw({ lead: <div className="lead">Lead</div>, end: <div className="end">End</div> });
    expect(html.indexOf('class="lead"')).toBeLessThan(html.indexOf('class="actionbar-scroll"'));
    expect(html.indexOf('class="end"')).toBeGreaterThan(html.indexOf(">Delete<"));
  });

  it("is held for a chat's page before its buttons are known", () => {
    expect(renderToStaticMarkup(<ActionBar actions={[]} scrolls={false} reserved />)).toContain('class="actionbar is-held"');
    expect(renderToStaticMarkup(<ActionBar actions={[]} scrolls={false} />)).toContain('class="actionbar"');
  });
});

describe("the buttons of the action bar", () => {
  const drawn = [
    ["Tasks", <TasksButton tasks={3} decisions={1} open={false} onToggle={() => {}} />],
    ["Focus", <FocusModeButton onClick={() => {}} />],
    ["Full width", <FullscreenButton expanded={false} onToggle={() => {}} />],
    ["Reload", <InstalledReload show />],
    ["Copy ID", <CopyChatIdButton chatId="c1" />],
    ["Delete", <ChatDeleteButton deleting={false} deleteMs={2000} onDelete={() => {}} />],
    ["Undo", <ChatDeleteButton deleting deleteMs={2000} onDelete={() => {}} />],
  ] as const;

  it.each(drawn)("%s is an icon and a short word, with a name of its own", (label, node) => {
    const html = renderToStaticMarkup(node);
    expect(html).toContain("<svg");
    expect(html).toContain(`<span class="topbar-action-label">${label}</span>`);
    expect(html).toMatch(/aria-label="[^"]+"/);
    expect(label.length).toBeLessThanOrEqual(10);
  });

  it("keeps the Tasks count and the mark of what waits on the person on the button", () => {
    const html = renderToStaticMarkup(<TasksButton tasks={3} decisions={2} open={false} onToggle={() => {}} />);
    expect(html).toContain('<span class="tasks-toggle-count">3</span>');
    expect(html).toContain('class="tasks-toggle-owed"');
  });
});

/** The body of the first rule in `sheet` whose selector list has `selector`. */
function rule(sheet: string, selector: string): string {
  const at = sheet.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return sheet.slice(at, sheet.indexOf("}", at));
}

describe("the action bar's sheet", () => {
  it("gives the bar one height, whatever is in it", () => {
    const bar = rule(barCss, "\n.actionbar");
    expect(bar).toMatch(/height: var\(--actionbar-h\)/);
    expect(bar).toMatch(/flex: 0 0 auto/);
    expect(bar).toMatch(/white-space: nowrap/);
    expect(barCss).not.toMatch(/flex-wrap:\s*wrap/);
  });

  it("scrolls a phone's row sideways with no scrollbar, and 44px targets", () => {
    const row = rule(barCss, ".actionbar.is-scrolling .actionbar-row");
    expect(row).toMatch(/overflow-x: auto/);
    expect(row).toMatch(/overscroll-behavior-x: contain/);
    expect(row).toMatch(/scrollbar-width: none/);
    expect(barCss).toContain(".actionbar.is-scrolling .actionbar-row::-webkit-scrollbar { display: none; }");
    const target = rule(barCss, ".actionbar.is-scrolling .actionbar-item > .chat-task > .chat-task-action");
    expect(target).toMatch(/min-width: 44px/);
    expect(target).toMatch(/height: 44px/);
  });

  it("fades the cut edge over the row and never masks it", () => {
    expect(barCss).toContain('.actionbar-scroll[data-cut~="start"]::before');
    expect(barCss).toContain('.actionbar-scroll[data-cut~="end"]::after');
    expect(barCss).not.toMatch(/mask(-image)?:/);
  });

  it("draws no bar for a page with no actions, unless the page is a chat's", () => {
    expect(barCss).toContain(".actionbar:not(.is-held):not(:has(button, a[href], select, input)) { display: none; }");
  });

  it("uses no accent: nothing in the bar is a turn in flight", () => {
    expect(barCss).not.toMatch(/var\(--accent/);
  });

  it("gives the usage row one height and a sideways scroll with no scrollbar", () => {
    const strip = rule(stylesCss, "\n.usage-strip");
    expect(strip).toMatch(/height: 26px/);
    expect(strip).toMatch(/flex: 0 0 auto/);
    const scroll = rule(stylesCss, ".usage-strip-scroll");
    expect(scroll).toMatch(/overflow-x: auto/);
    expect(scroll).toMatch(/scrollbar-width: none/);
    expect(stylesCss).toContain(".usage-strip-scroll::-webkit-scrollbar { display: none; }");
    expect(rule(stylesCss, ".usage-strip-btn")).toMatch(/white-space: nowrap/);
  });
});

// An alarm on spelling, not a proof of behaviour: it reads App.tsx as text
// for the hand-off this file cannot make without mounting the whole page.
describe("App hands the actions to the bar", () => {
  it("draws the action bar once, and usage once whichever row holds it", () => {
    expect(appSource.match(/<ActionBar\b/g)).toHaveLength(1);
    expect(appSource.match(/<UsageRow\b/g)).toHaveLength(1);
    expect(appSource.match(/<Usage\b/g)).toHaveLength(1);
    expect(appSource).toContain("{!isMobile && <UsageRow />}");
    expect(appSource).toContain("scrolls={isMobile}");
    expect(appSource).toContain("end={usageInBar ? usageEntry : null}");
  });

  it("leaves nothing in the top bar but the page's name: no menu and no action there", () => {
    const header = appSource.slice(appSource.indexOf('<header className="topbar">'), appSource.indexOf("</header>"));
    expect(header).not.toMatch(/TopbarAction|ActionBar|barActions|TasksButton|GitButton|FocusModeButton/);
  });

  it("counts on More what waits behind the Tasks button", () => {
    expect(appSource).toContain("{ attention: columnShut ? taskCounts.decisions : 0 }");
  });
});
