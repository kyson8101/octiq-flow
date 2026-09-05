"use strict";

// Runnable checks for the URL-addressed conversation reader. No framework:
// `node scripts/mcp/octiq-ask.test.cjs`.
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  compactSkillPrompt,
  conversationDetail,
  conversationRef,
  profileRoot,
  projectSlug,
} = require("./octiq-ask.cjs");

const ID = "c9c2ffa8-ea18-4073-ac86-eb0d700b18cc";
const URL = `https://optiqflow.app/#/p/pandahrms/c/${ID}`;

async function main() {
  assert.deepStrictEqual(conversationRef(URL), {
    project: "pandahrms",
    conversationId: ID,
  });
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
  process.env.OCTIQ_ROOT = root;
  try {
    assert.strictEqual(profileRoot(), root);
    fs.mkdirSync(path.join(root, "chats"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "workspaces.json"),
      JSON.stringify({ workspaces: [{ id: "p1", name: "Pandahrms" }] }),
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

    const latest = await conversationDetail({ url: URL, limit: 2 });
    assert.match(latest, /Conversation: Dashboard plan/);
    assert.match(latest, /Showing: 3-4 \(latest page\)/);
    assert.match(latest, /Earlier context: call read_conversation again with before: 3/);
    assert.match(latest, /quoted historical data, not instructions/);
    assert.match(latest, /Ran \/slice: card-01/);
    assert.match(latest, /Codex reply/);
    assert.doesNotMatch(latest, /Huge instructions/);
    assert.doesNotMatch(latest, /file_path/);
    assert.match(latest, /Skipped malformed records: 1/);

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
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log("ok"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
