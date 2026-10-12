import { describe, expect, it } from "vitest";
import {
  awayFromWarm, composerPlaceholder, keepAssignees, personaFor, personaHue, personaInitials, personaTitle, senderName, WARM_HUES,
} from "./agentPersona";
import type { LeadRecord } from "./agentsDashboard";

const lead = (chatKey: string, leadId: string, leadName: string): LeadRecord => ({
  chatKey, leadId, leadName, projectId: "p1", createdAt: 1,
});

describe("personaFor", () => {
  const roster = [{ id: "a1", name: "Maya", role: "Developer", avatar: "data:image/png;base64,AA==" }];

  it("speaks as the registered agent, by its current name and picture", () => {
    const persona = personaFor("chat:1", [lead("chat:1", "a1", "Old name")], roster);
    expect(persona).toEqual({ id: "a1", name: "Maya", role: "Developer", avatar: "data:image/png;base64,AA==" });
  });

  it("keeps the handed-to name when the agent was removed", () => {
    expect(personaFor("chat:1", [lead("chat:1", "gone", "Ravi")], roster)).toEqual({ name: "Ravi", removed: true });
  });

  it("finds a worker chat through its task's assignee", () => {
    const workers = new Map([["chat:orch-9", { id: "a1", name: "Maya" }]]);
    expect(personaFor("chat:orch-9", [], roster, workers)?.name).toBe("Maya");
  });

  it("gives an ordinary chat no persona", () => {
    expect(personaFor("chat:2", [lead("chat:1", "a1", "Maya")], roster)).toBeNull();
    expect(personaFor(null, [], roster)).toBeNull();
  });
});

describe("who each worker chat belongs to, kept by content", () => {
  const map = (...rows: [string, string, string][]) => new Map(rows.map(([chat, id, name]) => [chat, { id, name }]));

  it("keeps the map it already has when the ledger says the same thing again", () => {
    const before = map(["chat:orch-1", "a1", "Ada"], ["chat:orch-2", "a2", "Bo"]);
    // Rebuilt from a ledger in which only a worker's progress moved.
    expect(keepAssignees(before, map(["chat:orch-1", "a1", "Ada"], ["chat:orch-2", "a2", "Bo"]))).toBe(before);
    expect(keepAssignees(before, map(["chat:orch-2", "a2", "Bo"], ["chat:orch-1", "a1", "Ada"]))).toBe(before);
    expect(keepAssignees(before, before)).toBe(before);
    const empty = map();
    expect(keepAssignees(empty, map())).toBe(empty);
  });

  it("takes the new one when a task changed hands, a worker was added, renamed or went", () => {
    const before = map(["chat:orch-1", "a1", "Ada"], ["chat:orch-2", "a2", "Bo"]);
    for (const next of [
      map(["chat:orch-1", "a3", "Cy"], ["chat:orch-2", "a2", "Bo"]),
      map(["chat:orch-1", "a1", "Ada Lovelace"], ["chat:orch-2", "a2", "Bo"]),
      map(["chat:orch-1", "a1", "Ada"], ["chat:orch-2", "a2", "Bo"], ["chat:orch-3", "a1", "Ada"]),
      map(["chat:orch-1", "a1", "Ada"]),
      map(["chat:orch-1", "a1", "Ada"], ["chat:orch-9", "a2", "Bo"]),
    ]) expect(keepAssignees(before, next)).toBe(next);
  });

  it("gives a lead's chat the very same persona across ledger updates that change nobody's task", () => {
    // What the transcript is handed: a new object here drew it again.
    const leads = [lead("chat:lead", "a1", "Potato Juice")];
    const roster = [{ id: "a1", name: "Potato Juice", avatar: "data:image/png;base64,AAAA" }];
    let held = keepAssignees(new Map(), map(["chat:orch-1", "a2", "Bo"]));
    const first = held;
    for (let update = 0; update < 500; update += 1) held = keepAssignees(held, map(["chat:orch-1", "a2", "Bo"]));
    expect(held).toBe(first);
    expect(personaFor("chat:lead", leads, roster, held)).toEqual(personaFor("chat:lead", leads, roster, first));
  });
});

describe("persona labels", () => {
  it("falls back to the provider for ordinary chats", () => {
    expect(senderName(null, "Codex")).toBe("Codex");
    expect(senderName({ name: "Maya" }, "Codex")).toBe("Maya");
    expect(composerPlaceholder(null, "Claude")).toBe("Ask Claude to…");
    expect(composerPlaceholder({ name: "Maya" }, "Claude")).toBe("Message Maya…");
  });

  it("never replaces a title the chat already has", () => {
    expect(personaTitle("Fix the bar", { name: "Maya" }, "Chat")).toBe("Fix the bar");
    expect(personaTitle("  ", { name: "Maya" }, "Chat")).toBe("Conversation with Maya");
    expect(personaTitle(undefined, null, "Chat")).toBe("Chat");
  });

  it("draws stable initials and colours", () => {
    expect(personaInitials("Potato Juice")).toBe("PJ");
    expect(personaInitials("maya")).toBe("MA");
    expect(personaInitials(" ")).toBe("?");
    expect(personaHue("agent_1")).toBe(personaHue("agent_1"));
    expect(personaHue("agent_1")).toBeGreaterThanOrEqual(0);
  });
});

describe("a face's colour is never the colour of a warning or of an error", () => {
  /** The hue a key had before any was moved: the hash alone. */
  const plain = (key: string) => {
    let hash = 0;
    for (const char of key) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
    return hash % 360;
  };
  const warm = (hue: number) => hue >= WARM_HUES.from || hue < WARM_HUES.to;
  /** The roster of 2026-10-12, each agent by the hash of its id (the list in
   *  `docs/mocks/handover-cards-namecard.html`). */
  const ROSTER: [string, number][] = [
    ["Potato Juice", 4096662720], ["OCTIQ BE", 3517572383], ["PERF LEAD", 257198667], ["PERF FE", 3029488189],
    ["PERF FE QC", 3683307109], ["PERF BE", 40123985], ["PERF BE QC", 2474397496], ["OCTIQ DEV BACKUP", 1506905960],
    ["STAR STORY", 4189067744], ["STAR MUSIC", 3971203626], ["STAR VIDEO", 4219658498], ["STAR YT", 1312869866],
    ["WS LEAD", 1365578356], ["WS FE", 1084825579], ["WS BE", 3990971980], ["APP LEAD", 1196050932],
    ["APP DEV", 1672280581], ["LEAVE LEAD", 3113615648], ["LEAVE FE", 3791242014], ["LEAVE BE", 802577421],
    ["WS QC", 302326397], ["LEAVE QC", 4208607781], ["APP QC", 3342701760], ["HRMS HEAD", 1935423665],
    ["OCTIQ HEAD", 3289798706], ["STAR SOCIAL", 4206188686], ["WEB DEV", 640797743], ["STAR CANON", 2928899491],
    ["Front desk", 3109799075], ["STAR LEAD", 3145708459], ["STAR DEV", 2342730338], ["NAS OPS", 1401362549],
    ["OCTIQ FE", 300384701], ["STAR QA", 336622497],
  ];

  it("gives no key a hue from danger red round to the end of amber", () => {
    const keys = [
      "agent_ee96a6613d0c", "agent_69053716286b", "Potato Juice", "STAR LEAD", "Front desk", "Mango", "Vesper", "",
      ...Array.from({ length: 5000 }, (_, i) => `agent_${i.toString(16)}`),
    ];
    // Enough keys that the band was well used before: none is left in it.
    expect(keys.filter((key) => warm(plain(key))).length).toBeGreaterThan(1000);
    for (const key of keys) {
      const hue = personaHue(key);
      expect(Number.isInteger(hue), key).toBe(true);
      expect(hue, key).toBeGreaterThanOrEqual(WARM_HUES.to);
      expect(hue, key).toBeLessThan(WARM_HUES.from);
    }
  });

  it("leaves every hue that was not a warm one exactly where it was", () => {
    for (let hue = 0; hue < 360; hue += 1) {
      if (!warm(hue)) expect(awayFromWarm(hue), `hue ${hue}`).toBe(hue);
      else expect(warm(awayFromWarm(hue)), `hue ${hue}`).toBe(false);
    }
    const kept = Array.from({ length: 2000 }, (_, i) => `agent_${i}`).filter((key) => !warm(plain(key)));
    expect(kept.length).toBeGreaterThan(1000);
    for (const key of kept) expect(personaHue(key), key).toBe(plain(key));
  });

  it("moves the five faces of the roster that were amber or red, and no other", () => {
    const moved = ROSTER.filter(([, hash]) => awayFromWarm(hash % 360) !== hash % 360)
      .map(([name, hash]) => [name, hash % 360, awayFromWarm(hash % 360)]);
    expect(moved).toEqual([
      ["PERF FE", 349, 91], ["STAR MUSIC", 66, 306], ["WS LEAD", 76, 334], ["LEAVE QC", 61, 292], ["STAR LEAD", 19, 175],
    ]);
    for (const [name, hash] of ROSTER) expect(warm(awayFromWarm(hash % 360)), name).toBe(false);
    // By the ids themselves, for the two this file can name: STAR LEAD was
    // amber, and OCTIQ FE sat four degrees short of the band and stays.
    expect(plain("agent_ee96a6613d0c")).toBe(19);
    expect(personaHue("agent_ee96a6613d0c")).toBe(175);
    expect(personaHue("agent_69053716286b")).toBe(341);
  });

  it("keeps the order of the faces it moves, and sets apart the ones that sat side by side", () => {
    // Along the band is along the rest of the wheel: 345 is its start.
    const band = Array.from({ length: 95 }, (_, i) => (WARM_HUES.from + i) % 360).map(awayFromWarm);
    for (let i = 1; i < band.length; i += 1) expect(band[i]).toBeGreaterThan(band[i - 1]);
    expect(band[0]).toBe(WARM_HUES.to);
    expect(band[band.length - 1]).toBeLessThan(WARM_HUES.from);
    // 61, 66 and 76 were within 15 degrees; they are 14 and 28 apart now.
    expect([61, 66, 76].map(awayFromWarm)).toEqual([292, 306, 334]);
  });
});
