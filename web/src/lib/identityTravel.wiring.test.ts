// A confirmed route's face and name land in the chat that confirmation
// opened, and in no other.
//
// `identityTravel.test.ts` holds the library to that: a landing is found by
// the chat it is the composer of, and `routeAfter` says when a travel is
// called off. It cannot see the app handing the library the wrong thing: the
// first build asked for the composer that named the agent, anywhere in the
// document, and every test of the library passed while a person who picked
// the same agent's older chat watched the face fly into it.
//
// This file is the hand-off. There is no DOM here and the app is one
// component of six thousand lines, so it reads `App.tsx` and `Composer.tsx`
// as text and names each step, and runs the same check on the review's
// mutation and on four more to show it fails for them.
//
// WHAT THIS IS, AND IS NOT. It is an alarm on the spelling of a hand-off, not
// a test of what the app does. It runs nothing of `App`.
//
// It catches a step of the hand-off being written back the way it was: the
// landing asked for by the agent's name, the check that the person is still
// there dropped, the effect that calls a travel off deleted, the hold's
// calling-off deleted, the composer or the chip not told its chat.
//
// It does not catch, and nothing here should be read as showing:
// - whether any of that code RUNS, or when. A `return` put at the top of
//   `dropTravel` leaves every pattern below in place and this file passes;
//   so does the same text in a comment or in dead code.
// - whether the rule is right. When a travel stands (which chat, whether the
//   chat is what the page shows, back in the chat it was confirmed in) is
//   `routeAfter`'s, and is tested as behaviour in `identityTravel.test.ts`.
//   Nothing is matched here for the "is the chat on screen" fact on purpose.
// - whether `App` hands that rule the right facts, or hears every change of
//   them. That was pressed in Chrome on a scratch page that copies `App`'s
//   sequence; no test renders `App`.
// And it fails for changes that break nothing: the same JSX on two lines, a
// renamed local, a second mention of `composerLanding` in a comment. A
// failure here means "read the hand-off again", not "the travel is broken".
import { describe, expect, it } from "vitest";
import app from "../App.tsx?raw";
import composer from "../components/Composer.tsx?raw";

/** One step of the hand-off: what it is, and the text that makes it. */
const SITES: { name: string; in: "app" | "composer"; has: RegExp }[] = [
  // The composer says which chat it is the composer of, on the chip.
  { name: "the app tells the composer its chat", in: "app", has: /<Composer\b[^>]*?\bsession=\{conversationId \?\? undefined\}/s },
  { name: "the composer tells the chip", in: "composer", has: /<AgentIdentityChip identity=\{identity\} chat=\{session\}[^>]*\/>/ },
  { name: "the chip writes it", in: "composer", has: /className="composer-identity"[^>]*\bdata-chat=\{chat \|\| undefined\}/ },
  // A travel is the confirmation's, from the chat it was pressed in.
  { name: "a travel starts in the chat on screen", in: "app", has: /routeTravel\.current = \{ id, from: visibleRef\.current, to: null, arrived: false \};/ },
  // The landing is the chat the host says it opened, the id the page goes to.
  {
    name: "the landing is the opened chat",
    in: "app",
    has: /const opened = chatIdOf\(target\);\s*route\.to = opened;\s*landIdentity\(id, \(\) => composerLanding\(opened\)\);/,
  },
  // Asked for only while the page is still where it was confirmed.
  {
    name: "not asked for after the person left",
    in: "app",
    has: /if \(route\?\.id === id && routeStands\(route, pageRef\.current\)\) \{\s*const opened/,
  },
  // Called off when the rule says so (which chat, and what else: see the
  // head of this file for what is not matched here).
  {
    name: "another chat calls it off",
    in: "app",
    has: /const next = routeAfter\(route, pageRef\.current\);\s*if \(next\) routeTravel\.current = next;\s*else dropTravel\(route\.id\);/,
  },
  // And by the card's hold running out.
  { name: "the hold running out calls it off", in: "app", has: /setGoingRoute\(null\);\s*dropTravel\(goingRoute\);\s*\}, GOING_MS\);/ },
  { name: "calling off forgets the travel", in: "app", has: /routeTravel\.current = null;\s*forgetIdentity\(route\.id\);/ },
];

/** What is wrong with the hand-off in these sources, by name. */
function wrong(sources: { app: string; composer: string }): string[] {
  const missing = SITES.filter((site) => !site.has.test(sources[site.in])).map((site) => site.name);
  // One way to ask for a landing, and it is never by a name.
  const asks = [...sources.app.matchAll(/composerLanding\(([^)]*)\)/g)].map((match) => match[1]);
  if (asks.length !== 1) missing.push(`composerLanding is asked ${asks.length} times`);
  if (asks.some((ask) => /name/i.test(ask))) missing.push("a landing asked for by name");
  if (/querySelector(All)?\([^)]*composer-identity/.test(sources.app)) missing.push("the app looks for a composer itself");
  return missing;
}

describe("where a confirmed route's face and name land", () => {
  it("is the chat that confirmation opened, at every step of the hand-off", () => {
    expect(wrong({ app, composer })).toEqual([]);
  });

  it.each([
    // The review's finding: the composer that names the agent, anywhere.
    {
      name: "a landing asked for by name",
      edit: (source: string) => source.replace("composerLanding(opened)", "composerLanding(record.to.name)"),
      says: ["the landing is the opened chat", "a landing asked for by name"],
    },
    {
      name: "no check that the person is still there",
      edit: (source: string) => source.replace("if (route?.id === id && routeStands(route, pageRef.current)) {", "if (route?.id === id) {"),
      says: ["not asked for after the person left"],
    },
    {
      name: "another chat no longer calls it off",
      edit: (source: string) => source.replace("else dropTravel(route.id);", ""),
      says: ["another chat calls it off"],
    },
    {
      name: "the hold running out leaves the travel standing",
      edit: (source: string) => source.replace("dropTravel(goingRoute);", ""),
      says: ["the hold running out calls it off"],
    },
    {
      name: "the composer is not told its chat",
      edit: (source: string) => source.replace("session={conversationId ?? undefined}", ""),
      says: ["the app tells the composer its chat"],
    },
  ])("fails when $name", ({ edit, says }) => {
    const edited = edit(app);
    expect(edited).not.toBe(app);
    expect(wrong({ app: edited, composer })).toEqual(says);
  });

  it("fails when the chip does not say which chat it is in", () => {
    const edited = composer.replace("<AgentIdentityChip identity={identity} chat={session}", "<AgentIdentityChip identity={identity}");
    expect(edited).not.toBe(composer);
    expect(wrong({ app, composer: edited })).toEqual(["the composer tells the chip"]);
  });
});
