import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({
  bridge: { invoke: async () => true },
}));

import {
  ALLOW_NOT_SENT,
  allowForProjectReply,
  allowOnceReply,
  type AllowedOutage,
  answerClaude,
  answerJudged,
  CLAUDE_ALLOW_ROUTES,
  CLAUDE_BLOCKED_STATUS,
  answerOutage,
  judgedAllowedReply,
  outageAllowedReply,
  outageRetryReply,
  outageRules,
  RETRY_NOT_SENT,
  CLAUDE_REFUSAL_NOTE,
  LOCAL_ONLY_REPLY,
  SAFER_APPROACH_REPLY,
  saferReply,
  SafetyBlock,
  type SafetyBlockNotice,
} from "./SafetyBlock";

const block: SafetyBlockNotice = {
  id: "blocked-1",
  chatKey: "chat:c1",
  kind: "external-data",
  title: "Codex blocked external data sharing",
  summary: "This would send outline and constraints to DeepSeek/OpenCode.",
  detail: "The safety reviewer requires explicit approval before this external transfer.",
};

const draw = (startOpen = false) =>
  renderToStaticMarkup(
    <SafetyBlock block={block} onContinue={() => {}} onAnswered={() => {}} startOpen={startOpen} />,
  );

describe("SafetyBlock", () => {
  it("states that the rejected command did not run and offers the two safe next turns", () => {
    const html = draw();

    expect(html).toContain("Codex safety review");
    expect(html).toContain("OctiqFlow is okay");
    expect(html).toContain("Codex blocked external data sharing");
    expect(html).toContain("OctiqFlow is still running. The command did not run, and no data was sent.");
    expect(html).toContain("Keep it local");
    expect(html).toContain("Technical details");
    expect(html).toContain("Always allow in this project");
    expect(html).toContain("Allow once");
    expect(html).not.toContain(block.detail);
  });

  it("shows the reviewer reason only when details are opened", () => {
    const html = draw(true);

    expect(html).toContain("Hide technical details");
    expect(html).toContain(block.detail);
  });

  it("makes an allow explicit, narrow, and single-use", () => {
    const reply = allowOnceReply(block);

    expect(reply).toContain("explicitly authorize one retry");
    expect(reply).toContain(block.summary);
    expect(reply).toContain("single retry");
    expect(reply).toContain("same content and destination only");
  });

  it("can authorize matching future actions without broadening the boundary", () => {
    const reply = allowForProjectReply(block);

    expect(reply).toContain("future actions matching it");
    expect(reply).toContain("including new chats and sessions");
    expect(reply).toContain(block.summary);
    expect(reply).toContain("same kind of data, purpose, and external destination");
    expect(reply).toContain("does not authorize a different destination");
    expect(reply).toContain("Ask again only if any of those boundaries change");
  });

  it("keeps the safer continuation fully local", () => {
    expect(LOCAL_ONLY_REPLY).toContain("without sending any local data");
    expect(LOCAL_ONLY_REPLY).toContain("only local tools and local reasoning");
    expect(saferReply(block)).toBe(LOCAL_ONLY_REPLY);
  });

  it("explains a general safety refusal without making OctiqFlow look broken", () => {
    const generic = { ...block, kind: "high-risk-action" as const, title: "Codex blocked a high-risk action" };
    const html = renderToStaticMarkup(
      <SafetyBlock block={generic} onContinue={() => {}} onAnswered={() => {}} />,
    );

    expect(html).toContain("Codex blocked a high-risk action");
    expect(html).toContain("OctiqFlow is still running. The blocked action made no changes.");
    expect(html).toContain("Use safer approach");
    expect(saferReply(generic)).toBe(SAFER_APPROACH_REPLY);
    expect(allowForProjectReply(generic)).toContain(
      "same kind of action, files or resources, scope, and intended effect",
    );
  });

  describe("Claude auto-mode card (feedback d59f830a stays open)", () => {
    const claude: SafetyBlockNotice = {
      id: "claude-1",
      chatKey: "chat:w1",
      kind: "high-risk-action",
      title: "Claude's auto mode blocked an action",
      summary: "Production Deploy",
      detail: "Permission for this action was denied by the Claude Code auto mode classifier.",
      provider: "claude",
      action: "eas update --branch production",
    };
    const drawClaude = (notice: SafetyBlockNotice, startOpen = false) =>
      renderToStaticMarkup(
        <SafetyBlock block={notice} onContinue={() => {}} onAnswered={() => {}} startOpen={startOpen} />,
      );

    it("names the refused line and offers no way to allow it", () => {
      for (const html of [drawClaude(claude), drawClaude(claude, true)]) {
        expect(html).toContain("eas update --branch production");
        expect(html).toContain("Use safer approach");
        expect(html).toContain("Dismiss");
        expect(html).not.toMatch(/Always allow|Allow once|Retry/);
        expect(html).not.toContain("Codex");
      }
    });

    it("says plainly that the refusal stands, even if an older server still sends a grant", () => {
      const stale = { ...claude, exactGrant: "Bash(eas update --branch production)" } as SafetyBlockNotice;
      const html = drawClaude(stale, true);
      expect(html).not.toContain("Allow this exact command once");
      expect(html).not.toContain("Bash(");
      expect(html).toContain("cannot approve a call");
      expect(CLAUDE_REFUSAL_NOTE).toContain("will not rerun it");
    });

    describe("compact by default (\"it showing too much info\")", () => {
      const line = "rm -rf web/node_modules web/dist && git worktree prune && git status --short";
      const long: SafetyBlockNotice = { ...claude, summary: "Irreversible Local Destruction", action: line };
      const shown = line.replace(/&/g, "&amp;");

      it("says what was blocked, why, that nothing ran, and one next step", () => {
        const html = drawClaude(long);
        // Headline and reason, one quiet status line, the start of the line.
        expect(html).toContain("Claude&#x27;s auto mode blocked an action");
        expect(html).toContain('<span class="safety-card-reason">Irreversible Local Destruction</span>');
        expect(html).toContain(`<pre class="safety-card-action safety-card-preview"><span>${shown}</span></pre>`);
        expect(html).toContain(CLAUDE_BLOCKED_STATUS);
        // Primary, secondary, and a low-emphasis disclosure that is shut.
        expect(html).toContain("Use safer approach");
        expect(html).toContain("Dismiss");
        expect(html).toMatch(/<button class="safety-card-toggle" type="button" aria-expanded="false">Details/);
        expect(html.indexOf("Use safer approach")).toBeLessThan(html.indexOf("Dismiss"));
      });

      it("drops the eyebrow, the badge, the banner, the section labels and the notes", () => {
        const html = drawClaude(long);
        for (const gone of [
          "Claude auto-mode review", "OctiqFlow is okay", "safety-card-context", "safety-card-status",
          "Why it was blocked", "What it tried", "Technical details", "How to allow this",
          "Permission for this action was denied", "cannot approve a call", "Manual command approval",
          "safety-card-more",
        ]) expect(html).not.toContain(gone);
        // The line appears once: as the preview, not again in full.
        expect(html.split(shown).length - 1).toBe(1);
      });

      it("opens to the full line, the technical details and every way to allow it", () => {
        const html = drawClaude(long, true);
        expect(html).toMatch(/aria-expanded="true" aria-controls="([^"]+)">Details[\s\S]*class="safety-card-more" id="\1"/);
        expect(html).toContain(`<pre class="safety-card-action safety-card-full">${shown}</pre>`);
        expect(html).toContain('aria-label="Copy the command"');
        expect(html).toContain("Technical details");
        expect(html).toContain("Permission for this action was denied by the Claude Code auto mode classifier.");
        expect(html).toContain("How to allow this");
        for (const route of CLAUDE_ALLOW_ROUTES) expect(html).toContain(route.replace(/'/g, "&#x27;"));
        expect(html).toContain("Run it yourself.");
        expect(html).toContain("Claude permission rule");
        expect(html).toContain("choose Manual command approval");
        // The quick answers stay where they were.
        expect(html).toContain("Use safer approach");
        expect(html).toContain("Dismiss");
      });

      it("keeps the same shape without a command, and for a call that is not a shell line", () => {
        const bare = drawClaude({ ...claude, action: null, summary: "Blocked by auto mode" });
        expect(bare).not.toContain("safety-card-preview");
        expect(bare).toContain("Blocked by auto mode");
        expect(bare).toContain(CLAUDE_BLOCKED_STATUS);
        expect(bare).toContain("Use safer approach");
        const bareOpen = drawClaude({ ...claude, action: null }, true);
        expect(bareOpen).not.toContain("Copy the command");
        expect(bareOpen).toContain("How to allow this");

        const write = drawClaude({ ...claude, action: "Write /Users/me/.ssh/config", summary: "Credential Exposure" });
        expect(write).toContain("<span>Write /Users/me/.ssh/config</span>");
        expect(write).toContain("Credential Exposure");
      });
    });

    describe("the two answers do exactly what they did", () => {
      const record = () => {
        const order: string[] = [];
        const calls: [string, Record<string, unknown>][] = [];
        const sent: [string, unknown][] = [];
        return {
          order, calls, sent,
          io: {
            invoke: async <T,>(cmd: string, args: Record<string, unknown>) => {
              calls.push([cmd, args]); order.push(cmd); return true as T;
            },
            onAnswered: (id: string) => { order.push(`answered:${id}`); },
            onContinue: async (message: string, options?: { safetyBlock?: string }) => {
              sent.push([message, options]); order.push("send");
            },
          },
        };
      };

      it("Use safer approach takes the card down, then asks for a safer alternative", async () => {
        const t = record();
        await answerClaude("safer", claude, t.io);
        expect(t.calls).toEqual([["safety_block_dismiss", { id: "claude-1" }]]);
        expect(t.order).toEqual(["safety_block_dismiss", "answered:claude-1", "send"]);
        expect(t.sent).toEqual([[SAFER_APPROACH_REPLY, undefined]]);
      });

      it("Dismiss takes the card down and sends the agent nothing", async () => {
        const t = record();
        await answerClaude("dismiss", claude, t.io);
        expect(t.order).toEqual(["safety_block_dismiss", "answered:claude-1"]);
        expect(t.sent).toEqual([]);
      });

      it("a dismiss the host refuses leaves the card up and sends nothing", async () => {
        const t = record();
        t.io.invoke = async () => { throw new Error("no such card"); };
        await expect(answerClaude("safer", claude, t.io)).rejects.toThrow("no such card");
        expect(t.order).toEqual([]);
      });
    });

    it("is unchanged by the outage kind: same title, buttons and Manual route", () => {
      const html = drawClaude(claude, true);
      expect(html).toContain("Claude&#x27;s auto mode blocked an action");
      expect(html).toContain("Use safer approach");
      expect(html).toContain("Details");
      expect(html).toContain("Dismiss");
      expect(html).toContain("choose Manual command approval");
      expect(html).not.toContain("safety check was unavailable");
      expect(html).not.toContain("is-outage");
      // The outage retry is for outages only.
      expect(html).not.toContain("once more");
    });

    it("points to the supported route: a new task with Manual approval, never a rerun (d59f830a)", () => {
      const html = drawClaude(claude, true);
      expect(html).toContain("choose Manual command approval");
      expect(html).toContain("before you approve the plan");
      expect(html).toContain("does not run again unless you approve it there");
      // Still no button that could let the refused line through.
      expect(html).not.toMatch(/Always allow|Allow once|Retry/);
    });

    describe("Always allow on a judged refusal (the lasting rule, never once)", () => {
      const line = "rm -f web/pnpm-workspace.yaml; git status --short; sed -n '1,80p' web/package.json";
      const judged: SafetyBlockNotice = {
        ...claude,
        id: "judged-1",
        summary: "Irreversible Local Destruction",
        action: line,
        rules: [
          "Bash(rm -f web/pnpm-workspace.yaml)",
          "Bash(git status --short)",
          "Bash(sed -n '1,80p' web/package.json)",
        ],
        allow: {
          project: "/work/repo/.claude/settings.local.json",
          user: "/Users/me/.claude/settings.json",
        },
      };

      it("keeps the rules and their buttons behind Details, never a button without its rules", () => {
        const shut = drawClaude(judged);
        expect(shut).not.toContain("Always allow");
        expect(shut).not.toContain("Bash(");
        expect(shut).not.toContain("settings.json");
        expect(shut).toContain("Use safer approach");
        expect(shut).toContain('aria-expanded="false"');
      });

      it("shows every exact rule and both files before anything is written", () => {
        const html = drawClaude(judged, true);
        expect(html).toContain("Rules Always allow adds");
        expect(html).toContain("Bash(rm -f web/pnpm-workspace.yaml)");
        expect(html).toContain("Bash(git status --short)");
        expect(html).toContain("Bash(sed -n &#x27;1,80p&#x27; web/package.json)");
        expect(html).toContain("This project: /work/repo/.claude/settings.local.json");
        expect(html).toContain("Everywhere: /Users/me/.claude/settings.json");
        expect(html).toContain("Always allow in this project");
        expect(html).toContain("Always allow everywhere");
        // The copy says what the rule does, for good.
        expect(html).toContain("Always allow is permanent.");
        expect(html).toContain("from now on Claude runs exactly these commands without its safety check");
        expect(html).toContain("until you remove the rules");
        expect(html).toContain("OctiqFlow does not run the command");
        // Never a prefix, never a blanket rule, never "once".
        expect(html).not.toContain(":*");
        expect(html).not.toContain("Bash(*)");
        expect(html).not.toMatch(/Allow once|exact command once/);
        // The safer path and the record stay.
        expect(html).toContain("Use safer approach");
        expect(html).toContain("Dismiss");
      });

      it("lists the parts no rule names, and offers only the scopes the server named", () => {
        const partial = drawClaude({
          ...judged,
          rules: ["Bash(git status)"],
          uncovered: ["python3 -c 'print(1)'"],
          allow: { project: "/work/repo/.claude/settings.local.json" },
        }, true);
        expect(partial).toContain("Rule Always allow adds");
        expect(partial).toContain("Not covered: Claude still checks these");
        expect(partial).toContain("python3 -c &#x27;print(1)&#x27;");
        expect(partial).toContain("Always allow in this project");
        expect(partial).not.toContain("Always allow everywhere");
        expect(partial).not.toContain("Everywhere:");
      });

      it("no rule, or no file to write, means no button", () => {
        for (const notice of [
          { ...judged, rules: undefined },
          { ...judged, rules: [] },
          { ...judged, allow: undefined },
          { ...judged, allow: {} },
        ]) {
          const html = drawClaude(notice, true);
          expect(html).not.toContain("Always allow");
          expect(html).not.toContain("Bash(");
          expect(html).toContain("Use safer approach");
        }
      });

      it("says when the rule is written but the agent was not told yet", () => {
        expect(drawClaude({ ...judged, written: "project" }))
          .toContain("The rule is already in this project&#x27;s settings.");
        expect(drawClaude({ ...judged, written: "user" })).toContain("already in your own settings");
        expect(drawClaude(judged)).not.toContain("already in");
      });

      const io = (reply: unknown, taken: boolean | void = true) => {
        const calls: [string, Record<string, unknown>][] = [];
        const order: string[] = [];
        const sent: string[] = [];
        const naming: (string | undefined)[] = [];
        const wrote: AllowedOutage[] = [];
        return {
          calls, order, sent, naming, wrote,
          io: {
            invoke: async <T,>(cmd: string, args: Record<string, unknown>) => {
              calls.push([cmd, args]); order.push(cmd); return reply as T;
            },
            onAnswered: () => { order.push("answered"); },
            onContinue: async (message: string, options?: { safetyBlock?: string }) => {
              sent.push(message); naming.push(options?.safetyBlock); order.push("send"); return taken;
            },
            onWritten: (allowed: AllowedOutage) => { wrote.push(allowed); order.push("written"); },
          },
        };
      };

      it.each(["project", "user"] as const)("Always allow (%s) writes through the host, then tells the agent in a turn naming the card", async (scope) => {
        const path = scope === "project" ? "/work/repo/.claude/settings.local.json" : "/Users/me/.claude/settings.json";
        const allowed: AllowedOutage = { rules: judged.rules!, path, added: judged.rules!, present: [], uncovered: [] };
        const t = io(allowed);
        await answerJudged(scope, judged, t.io);
        // The page names only the card and the scope: never a rule or a path.
        expect(t.calls).toEqual([["safety_block_allow_rule", { id: "judged-1", scope }]]);
        expect(t.order).toEqual(["safety_block_allow_rule", "written", "send", "answered"]);
        expect(t.naming).toEqual(["judged-1"]);
        expect(t.sent[0]).toBe(judgedAllowedReply(allowed, line));
        expect(t.sent[0]).toContain(`allow rules \`Bash(rm -f web/pnpm-workspace.yaml)\`, \`Bash(git status --short)\``);
        expect(t.sent[0]).toContain(`to ${path}.`);
        expect(t.sent[0]).toContain("OctiqFlow did not run the refused command");
        expect(t.sent[0]).toContain(`run it again exactly as before:\n\`${line}\``);
        expect(t.sent[0]).toContain("Do not reword it");
      });

      it("tells the agent which parts no rule covers", () => {
        const reply = judgedAllowedReply(
          { rules: ["Bash(git status)"], path: "/p", added: [], present: ["Bash(git status)"], uncovered: ["node x.js"] },
          "node x.js; git status",
        );
        expect(reply).toContain("allow rule `Bash(git status)` was already in /p; nothing new was written.");
        expect(reply).not.toContain("I added");
        expect(reply).toContain("No rule covers `node x.js`");
        expect(reply).toContain("may be refused again");
      });

      it("says which rules it added and which were already there", () => {
        const both = judgedAllowedReply(
          { rules: ["Bash(a)", "Bash(b)", "Bash(c)"], path: "/p", added: ["Bash(a)"], present: ["Bash(b)", "Bash(c)"], uncovered: [] },
          "a; b; c",
        );
        expect(both).toContain("I added the Claude permission allow rule `Bash(a)` to /p. `Bash(b)`, `Bash(c)` were already there.");
        const none = judgedAllowedReply(
          { rules: ["Bash(a)", "Bash(b)"], path: "/p", added: [], present: ["Bash(a)", "Bash(b)"], uncovered: [] },
          "a; b",
        );
        expect(none).toContain("allow rules `Bash(a)`, `Bash(b)` were already in /p; nothing new was written.");
      });

      it("a refused write tells the agent nothing; a send not taken leaves the card up", async () => {
        const refused = io(null);
        refused.io.invoke = async () => { throw new Error("The settings file is not valid JSON. Nothing was written."); };
        await expect(answerJudged("project", judged, refused.io)).rejects.toThrow("Nothing was written");
        expect(refused.sent).toEqual([]);
        expect(refused.order).not.toContain("answered");

        const allowed: AllowedOutage = { rules: ["Bash(git status --short)"], path: "/p", added: [], present: [], uncovered: [] };
        const dropped = io(allowed, false);
        await expect(answerJudged("project", judged, dropped.io)).rejects.toThrow(ALLOW_NOT_SENT);
        expect(dropped.order).toEqual(["safety_block_allow_rule", "written", "send"]);
      });
    });
  });

  describe("Claude classifier outage card (feedback 664f03c0)", () => {
    const guidance =
      "Claude's safety check was unavailable, so the command did not run. It was not judged unsafe, and it was not approved. " +
      "Continue with your other steps. OctiqFlow never re-runs it. You may try the same command once more, as-is: Claude checks that try again. " +
      "If it is refused again, do not try it a third time. Never reword a command to get past the check. " +
      "Report every refused command in your worker report, and do not describe any of them as approved or as having run.";
    const outage: SafetyBlockNotice = {
      id: "outage-1",
      chatKey: "chat:w1",
      kind: "outage",
      title: "Claude's safety check was unavailable",
      summary: "Classifier unavailable",
      detail: "The server-side auto mode classifier gave no verdict (error).\n\nTool calls: toolu_1, toolu_2, toolu_3",
      provider: "claude",
      action: "git fetch",
      count: 3,
      commands: [{ action: "git fetch", count: 2 }, { action: "cat POLICY.md", count: 1 }],
      guidance,
    };
    const drawOutage = (notice: SafetyBlockNotice, startOpen = false) =>
      renderToStaticMarkup(<SafetyBlock block={notice} onContinue={() => {}} onAnswered={() => {}} startOpen={startOpen} />);

    it("says the check was unavailable and the commands did not run, never that they were unsafe", () => {
      const html = drawOutage(outage);
      expect(html).toContain("Claude&#x27;s safety check was unavailable");
      expect(html).toContain("did not run these commands");
      expect(html).toContain("Nothing was judged unsafe");
      // The refused calls did not run; the same line may still run on the
      // one as-is retry, so the card never says the command never ran.
      expect(html).toContain("These refused calls did not run. Nothing was approved.");
      expect(html).not.toContain("None of these commands ran");
      expect(html).not.toContain("blocked an action");
      expect(html).not.toContain("Why it was blocked");
      expect(html).toContain('role="status"');
    });

    it("lists each refused line once with its count, and the group's total", () => {
      const html = drawOutage(outage);
      expect(html).toContain("What it tried");
      expect(html).toContain("3 refused");
      expect(html.match(/git fetch/g)?.length).toBe(1);
      expect(html).toContain("×2");
      expect(html).toContain("cat POLICY.md");
    });

    it("offers Retry once, technical details and dismiss; no allow without a rule and a settings file", () => {
      const html = drawOutage(outage);
      expect(html).toContain("Retry once");
      expect(html).toContain("Technical details");
      expect(html).toContain("Dismiss");
      expect(html).not.toContain("Use safer approach");
      expect(html).not.toContain("Manual command approval");
      // This card's server named no rule and no file: nothing to allow.
      expect(html).not.toContain("Always allow");
      expect(html).not.toContain("Bash(");
      expect(drawOutage(outage, true)).toContain("Tool calls: toolu_1, toolu_2, toolu_3");
    });

    describe("recovery prompt: Retry once / Always allow (this project / everywhere)", () => {
      const notice =
        "The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash. " +
        "This is a transient failure of the check, not a judgment about the action: a later response may get a verdict. You may try the action again once, as-is.";
      const allowable: SafetyBlockNotice = {
        ...outage,
        id: "outage-2",
        count: 2,
        detail: `${notice}\n\nTool calls: toolu_a, toolu_b`,
        action: "ls | wc -l",
        commands: [
          { action: "git push origin main", count: 1, tool: "Bash", words: "git push", rule: "Bash(git push:*)" },
          { action: "ls | wc -l", count: 1, tool: "Bash" },
        ],
        allow: {
          project: "/work/repo/.claude/settings.local.json",
          user: "/Users/me/.claude/settings.json",
        },
      };

      it("shows all three choices, each naming the exact rule and file it writes", () => {
        const html = drawOutage(allowable);
        expect(html).toContain("Retry once");
        expect(html).toContain("Always allow in this project");
        expect(html).toContain("Always allow everywhere");
        expect(html).toContain("Adds Bash(git push:*) to /work/repo/.claude/settings.local.json, then retries");
        expect(html).toContain("Adds Bash(git push:*) to /Users/me/.claude/settings.json, then retries");
        expect(html).toContain("<code>Bash(git push:*)</code>");
        // Never a blanket Bash rule, and nothing for the piped line.
        expect(html).not.toContain("Bash(*)");
        expect(html).not.toContain("Bash(ls");
      });

      it("keeps the full harness notice collapsed until asked for", () => {
        const closed = drawOutage(allowable);
        expect(closed).not.toContain("gave no verdict (error)");
        expect(closed).toContain('aria-expanded="false"');
        const open = drawOutage(allowable, true);
        expect(open).toContain("gave no verdict (error), so auto mode cannot determine the safety of Bash");
        expect(open).toContain("You may try the action again once, as-is.");
        expect(open).toContain("This project: /work/repo/.claude/settings.local.json");
        expect(open).toContain("Everywhere: /Users/me/.claude/settings.json");
      });

      it("offers only the scopes the server named, and only Retry when no call has a rule", () => {
        const userOnly = drawOutage({ ...allowable, allow: { user: "/Users/me/.claude/settings.json" } });
        expect(userOnly).not.toContain("Always allow in this project");
        expect(userOnly).toContain("Always allow everywhere");
        const noRule = drawOutage({ ...allowable, commands: [{ action: "ls | wc -l", count: 1, tool: "Bash" }] });
        expect(noRule).toContain("Retry once");
        expect(noRule).not.toContain("Always allow");
        const lite = drawOutage({ ...allowable, allow: undefined });
        expect(lite).toContain("Retry once");
        expect(lite).not.toContain("Always allow");
      });

      // `taken` is what the page's send answers: false when the chat did not
      // take the turn (App.send, which shows the failure on the bubble).
      const io = (reply: unknown, taken: boolean | void = true) => {
        const calls: [string, Record<string, unknown>][] = [];
        const answered: string[] = [];
        const sent: string[] = [];
        const naming: (string | undefined)[] = [];
        const order: string[] = [];
        return {
          calls, answered, sent, naming, order,
          io: {
            invoke: async <T,>(cmd: string, args: Record<string, unknown>) => {
              calls.push([cmd, args]); order.push(cmd); return reply as T;
            },
            onAnswered: (id: string) => { answered.push(id); order.push("answered"); },
            onContinue: async (message: string, options?: { safetyBlock?: string }) => {
              sent.push(message); naming.push(options?.safetyBlock); order.push("send"); return taken;
            },
          },
        };
      };

      // Review finding (2f71bc6): the host superseded the card on ANY send,
      // before the turn was taken. The retry turn now names its card, and the
      // host closes it in the call that takes the turn; the page makes no
      // second call that could race it or record it as superseded.
      it("Retry once asks for the same calls, as-is, in a turn that names the card", async () => {
        const t = io(true);
        await answerOutage("retry", allowable, t.io);
        expect(t.calls).toEqual([]);
        expect(t.naming).toEqual(["outage-2"]);
        expect(t.order).toEqual(["send", "answered"]);
        expect(t.answered).toEqual(["outage-2"]);
        expect(t.sent).toHaveLength(1);
        expect(t.sent[0]).toBe(outageRetryReply(["git push origin main", "ls | wc -l"]));
        expect(t.sent[0]).toContain("`git push origin main`");
        expect(t.sent[0]).toContain("Do not reword");
        expect(t.sent[0]).toContain("do not try a third time");
      });

      it.each(["project", "user"] as const)("Always allow (%s) sends only the card and scope, then the retry naming the rule", async (scope) => {
        const path = scope === "project" ? "/work/repo/.claude/settings.local.json" : "/Users/me/.claude/settings.json";
        const t = io({ rules: ["Bash(git push:*)"], path, added: ["Bash(git push:*)"], present: [], uncovered: ["ls | wc -l"] });
        await answerOutage(scope, allowable, t.io);
        expect(t.calls).toEqual([["safety_block_allow_rule", { id: "outage-2", scope }]]);
        expect(t.order).toEqual(["safety_block_allow_rule", "send", "answered"]);
        expect(t.naming).toEqual(["outage-2"]);
        expect(t.answered).toEqual(["outage-2"]);
        expect(t.sent[0]).toContain(`I added the Claude permission allow rule \`Bash(git push:*)\` to ${path}.`);
        expect(t.sent[0]).toContain("No rule covers `ls | wc -l`");
        expect(t.sent[0]).toContain("Retry each of them once, exactly as before");
      });

      it("a refused allow write sends nothing and leaves the card up", async () => {
        const answered: string[] = [];
        const sent: string[] = [];
        await expect(answerOutage("project", allowable, {
          invoke: async () => { throw new Error("The settings file is not valid JSON. Nothing was written."); },
          onAnswered: (id) => { answered.push(id); },
          onContinue: (message) => { sent.push(message); },
        })).rejects.toThrow("Nothing was written");
        expect(answered).toEqual([]);
        expect(sent).toEqual([]);
      });

      // Review finding (5bf9f85): the card came down, and the host recorded
      // the decision, BEFORE the retry turn was sent, so a send that failed in
      // between left the agent never asked to retry. Now a rejected send
      // leaves the card up and undecided, to be answered again.
      it.each(["retry", "project", "user"] as const)("a send the chat did not take leaves the %s card recoverable", async (choice) => {
        const allowed = { rules: ["Bash(git push:*)"], path: "/p", added: ["Bash(git push:*)"], present: [], uncovered: [] };
        const refused = io(allowed, false);
        await expect(answerOutage(choice, allowable, refused.io)).rejects.toThrow(RETRY_NOT_SENT);
        expect(refused.answered).toEqual([]);
        expect(refused.sent).toHaveLength(1);

        const thrown = io(allowed);
        thrown.io.onContinue = async () => { throw new Error("socket closed"); };
        await expect(answerOutage(choice, allowable, thrown.io)).rejects.toThrow("socket closed");
        expect(thrown.answered).toEqual([]);

        // Answered again, the send goes through: now, and only now, it closes.
        const again = io(allowed);
        await answerOutage(choice, allowable, again.io);
        expect(again.order.slice(-2)).toEqual(["send", "answered"]);
        expect(again.naming).toEqual(["outage-2"]);
      });

      it("says when an allow rule is written but its retry was not sent", () => {
        expect(drawOutage({ ...allowable, written: "project" }))
          .toContain("The allow rule is already in this project&#x27;s settings");
        expect(drawOutage({ ...allowable, written: "user" })).toContain("already in your own settings");
        expect(drawOutage(allowable)).not.toContain("already in");
      });

      it("Dismiss sends no turn", async () => {
        const t = io(true);
        await answerOutage("dismiss", allowable, t.io);
        expect(t.calls).toEqual([["safety_block_dismiss", { id: "outage-2" }]]);
        expect(t.sent).toEqual([]);
      });

      it("derives each distinct rule once, in refusal order", () => {
        expect(outageRules([
          { action: "a", count: 1, rule: "mcp__s__t" },
          { action: "b", count: 1 },
          { action: "c", count: 1, rule: "Bash(git push:*)" },
          { action: "d", count: 1, rule: "mcp__s__t" },
        ])).toEqual(["mcp__s__t", "Bash(git push:*)"]);
        const one: AllowedOutage = { rules: ["mcp__s__t"], path: "/p", added: [], present: ["mcp__s__t"], uncovered: [] };
        const reply = outageAllowedReply(one, ["mcp__s__t"]);
        expect(reply).toContain("allow rule `mcp__s__t` to /p.");
        expect(reply).toContain("Retry it once, exactly as before:\n`mcp__s__t`");
      });
    });

    it("shows the host's guidance word for word, as the worker and snapshot get it", () => {
      const html = renderToStaticMarkup(<SafetyBlock block={{ ...outage, guidance: "Exactly this text." }} onContinue={() => {}} onAnswered={() => {}} />);
      expect(html).toContain("What the agent was told");
      expect(html).toContain("Exactly this text.");
      expect(drawOutage(outage)).toContain("do not try it a third time");
    });

    it("reads a single refusal in the singular and survives a server without the group fields", () => {
      const single = { ...outage, count: undefined, commands: undefined, guidance: undefined };
      const html = drawOutage(single);
      expect(html).toContain("did not run this command");
      expect(html).toContain("This refused call did not run. Nothing was approved.");
      expect(html).not.toContain("The command did not run.");
      expect(html).toContain("git fetch");
      expect(html).not.toContain("refused</span>");
      expect(html).toContain("OctiqFlow will not re-run it");
    });
  });
});
