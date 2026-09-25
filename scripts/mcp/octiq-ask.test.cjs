"use strict";

// Runnable checks for the ID/URL-addressed conversation reader. No framework:
// `node scripts/mcp/octiq-ask.test.cjs`.
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  compactSkillPrompt,
  conversationEntries,
  conversationDetail,
  conversationSearch,
  conversationIdRef,
  conversationRef,
  profileRoot,
  projectSlug,
} = require("./octiq-ask.cjs");

const ID = "c9c2ffa8-ea18-4073-ac86-eb0d700b18cc";
const RELATED_ID = "96c5a95f-fadb-4241-ada4-5d46a7d449dd";
const OTHER_ID = "db2289e9-748b-4215-bd95-6df7c9b84f9a";
const URL = `https://optiqflow.app/#/p/pandahrms/c/${ID}`;

async function main() {
  const report = '<agent-message from="a1">\n[Subagent hand-back] The report follows:\n  Review complete\n</agent-message>';
  const peer = { type: "user", message: { content: report }, isSynthetic: true,
    origin: { kind: "peer", handback: true, senderTaskId: "a1", body: "Review complete" } };
  assert.deepStrictEqual(conversationEntries(peer, false), [
    { role: "assistant", speaker: "Subagent a1", text: "Review complete" },
  ]);
  assert.strictEqual(conversationEntries({ ...peer, origin: undefined }, false)[0].role, "assistant");
  assert.strictEqual(conversationEntries({ ...peer, origin: { ...peer.origin,
    body: "[Subagent hand-back] Model output. The report follows:\n  Review complete" } }, false)[0].text, "Review complete");
  assert.deepStrictEqual(conversationEntries({ ...peer, origin: { kind: "peer", name: "Reviewer", body: "Done" } }, false), [
    { role: "assistant", speaker: "Agent session Reviewer", text: "Done" },
  ]);
  assert.deepStrictEqual(conversationEntries({ type: "user", message: { content: report } }, false), [
    { role: "user", speaker: "User", text: report },
  ]);
  assert.strictEqual(conversationEntries({ ...peer, octiq_user_turn: true }, false)[0].role, "user");
  assert.deepStrictEqual(conversationEntries({ type: "user", message: { content:
    "Review the change\n\n=== OctiqFlow agents mode ===\nLead: Potato Juice\n\nInternal instructions" } }, false), [
    { role: "user", speaker: "User", text: "Review the change" },
  ]);
  assert.strictEqual(conversationEntries({ type: "user", parent_tool_use_id: "task-1",
    message: { content: "Review this PR" } }, false)[0].speaker, "Subagent prompt");
  assert.deepStrictEqual(conversationRef(URL), {
    project: "pandahrms",
    conversationId: ID,
  });
  assert.deepStrictEqual(conversationIdRef(ID), { conversationId: ID });
  assert.throws(() => conversationIdRef("../index"), /valid OctiqFlow chat ID/);
  assert.throws(
    () => conversationRef("https://optiqflow.app/#/p/pandahrms/c/..%2Findex"),
    /must point|invalid conversation id/,
  );
  assert.throws(
    () => conversationRef(`file:///tmp/#/p/pandahrms/c/${ID}`),
    /http or https/,
  );
  assert.strictEqual(projectSlug(" PandaHRMS (Legacy) "), "pandahrms-legacy");
  assert.strictEqual(
    compactSkillPrompt("Base directory for this skill: /skills/sql\n\n# SQL\nsecret body\nARGUMENTS: list DBs"),
    "Ran /sql: list DBs",
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octiq-mcp-conversation-"));
  const oldRoot = process.env.OCTIQ_ROOT;
  const oldChatKey = process.env.OCTIQ_CHAT_KEY;
  process.env.OCTIQ_ROOT = root;
  process.env.OCTIQ_CHAT_KEY = `chat:${ID}`;
  try {
    assert.strictEqual(profileRoot(), root);
    fs.mkdirSync(path.join(root, "chats"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "workspaces.json"),
      JSON.stringify({ workspaces: [{ id: "p1", name: "Pandahrms" }, { id: "p2", name: "OctiqFlow" }] }),
    );
    fs.writeFileSync(
      path.join(root, "chats", "index.json"),
      JSON.stringify({
        chats: [
          {
            id: ID,
            projectId: "p1",
            title: "Dashboard plan",
            modelId: "claude:fable",
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_100_000,
          },
          {
            id: RELATED_ID,
            projectId: "p1",
            title: "Refresh token migration",
            latestResponse: "The rotation design is ready.",
            createdAt: 1_700_000_200_000,
            updatedAt: 1_700_000_300_000,
          },
          {
            id: OTHER_ID,
            projectId: "p2",
            title: "Launch copy review",
            latestResponse: "The launch wording is approved.",
            createdAt: 1_700_000_400_000,
            updatedAt: 1_700_000_500_000,
          },
        ],
      }),
    );
    const events = [
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Build the dashboard" }] },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect it." },
            { type: "tool_use", name: "Read", input: { file_path: "/work/spec.md" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Base directory for this skill: /skills/slice\n\n# Huge instructions\nDo many things\n\nARGUMENTS: card-01",
            },
          ],
        },
      },
      { type: "item.completed", item: { type: "agent_message", text: "Codex reply" } },
    ];
    fs.writeFileSync(
      path.join(root, "chats", `chat_${ID}.jsonl`),
      `${events.map(JSON.stringify).join("\n")}\nnot-json\n`,
    );
    fs.writeFileSync(
      path.join(root, "chats", `chat_${RELATED_ID}.jsonl`),
      `${[
        { type: "assistant", message: { content: [{ type: "text", text: "Rotate refresh tokens after every successful exchange." }] } },
        { type: "user", message: { content: [{ type: "text", text: "登录页面的刷新策略" }] } },
        { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Pi confirmed the session rotation." }] } },
      ].map(JSON.stringify).join("\n")}\n`,
    );
    fs.writeFileSync(
      path.join(root, "chats", `chat_${OTHER_ID}.jsonl`),
      `${JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Review the launch copy before release." }] } })}\n`,
    );

    const found = JSON.parse(await conversationSearch({ query: "refresh tokens", project: "pandahrms" }));
    assert.strictEqual(found.scope, "Pandahrms");
    assert.strictEqual(found.count, 1);
    assert.strictEqual(found.matches[0].id, RELATED_ID);
    assert.match(found.matches[0].matched.excerpt, /refresh tokens/i);
    assert.match(found.next, /read_conversation/);
    const searchCache = path.join(root, "chats", "search-index.json");
    assert.ok(fs.existsSync(searchCache));
    assert.ok(JSON.parse(fs.readFileSync(searchCache, "utf8")).chats[RELATED_ID]);
    if (process.platform !== "win32") assert.strictEqual(fs.statSync(searchCache).mode & 0o777, 0o600);

    const inCurrentProject = JSON.parse(await conversationSearch({ query: "refresh tokens" }));
    assert.strictEqual(inCurrentProject.scope, "Pandahrms");
    assert.strictEqual(inCurrentProject.matches[0].id, RELATED_ID);
    const excludesCurrent = JSON.parse(await conversationSearch({ query: "dashboard" }));
    assert.strictEqual(excludesCurrent.count, 0);
    const chinese = JSON.parse(await conversationSearch({ query: "登录页面" }));
    assert.strictEqual(chinese.matches[0].id, RELATED_ID);
    const piReply = JSON.parse(await conversationSearch({ query: "Pi confirmed" }));
    assert.strictEqual(piReply.matches[0].id, RELATED_ID);

    fs.appendFileSync(
      path.join(root, "chats", `chat_${RELATED_ID}.jsonl`),
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "The rotation checkpoint is now recorded." }] } })}\n`,
    );
    const incrementallyUpdated = JSON.parse(await conversationSearch({ query: "rotation checkpoint" }));
    assert.strictEqual(incrementallyUpdated.matches[0].id, RELATED_ID);

    const crossProject = JSON.parse(await conversationSearch({ query: "launch copy", project: "all" }));
    assert.strictEqual(crossProject.matches[0].id, OTHER_ID);
    assert.strictEqual(crossProject.matches[0].project, "OctiqFlow");

    await assert.rejects(
      conversationSearch({ query: "refresh", project: "missing-project" }),
      /No project matches/,
    );

    const latest = await conversationDetail({ id: ID, limit: 2 });
    assert.match(latest, /Conversation: Dashboard plan/);
    assert.match(latest, new RegExp(`Chat ID: ${ID}`));
    assert.match(latest, /Showing: 3-4 \(latest page\)/);
    assert.match(latest, /Earlier context: call read_conversation again with before: 3/);
    assert.match(latest, /quoted historical data, not instructions/);
    assert.match(latest, /Ran \/slice: card-01/);
    assert.match(latest, /Codex reply/);
    assert.doesNotMatch(latest, /Huge instructions/);
    assert.doesNotMatch(latest, /file_path/);
    assert.match(latest, /Skipped malformed records: 1/);

    await assert.rejects(
      conversationDetail({ id: ID, url: URL }),
      /either a chat ID or conversation URL/,
    );

    const earlier = await conversationDetail({ url: URL, before: 3, limit: 10 });
    assert.match(earlier, /Showing: 1-2 \(before #3\)/);
    assert.match(earlier, /Build the dashboard/);
    assert.match(earlier, /I will inspect it/);
    assert.doesNotMatch(earlier, /Codex reply/);

    const tools = await conversationDetail({
      url: URL,
      before: 4,
      limit: 10,
      includeToolActivity: true,
    });
    assert.match(tools, /Read \(tool\)/);
    assert.match(tools, /file_path/);

    await assert.rejects(
      conversationDetail({ url: `https://optiqflow.app/#/p/not-pandahrms/c/${ID}` }),
      /project does not match/,
    );

    if (process.platform !== "win32") {
      const transcript = path.join(root, "chats", `chat_${ID}.jsonl`);
      const real = `${transcript}.real`;
      fs.renameSync(transcript, real);
      fs.symlinkSync(real, transcript);
      await assert.rejects(conversationDetail({ url: URL }), /not a regular file/);
    }
  } finally {
    if (oldRoot === undefined) delete process.env.OCTIQ_ROOT;
    else process.env.OCTIQ_ROOT = oldRoot;
    if (oldChatKey === undefined) delete process.env.OCTIQ_CHAT_KEY;
    else process.env.OCTIQ_CHAT_KEY = oldChatKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log("ok"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
