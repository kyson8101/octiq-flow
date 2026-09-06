import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
const base = process.env.OCTIQOS_LIVE_TEST_URL;
assert.equal(
  process.env.OCTIQOS_LIVE_TEST,
  "1",
  "Explicit live-account test opt-in required",
);
assert.ok(
  base &&
    new URL(base).hostname === "127.0.0.1" &&
    !["1421", "1422"].includes(new URL(base).port),
  "Use an isolated loopback test service",
);
const output = process.env.OCTIQOS_LIVE_TEST_OUTPUT;
assert.ok(output, "Set a disposable fixture output directory");
await fs.mkdir(output, { recursive: true });
const token = (await (await fetch(`${base}/token`)).text()).trim();
const socket = new WebSocket(
  `${base.replace("http", "ws")}/ws?token=${encodeURIComponent(token)}`,
);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let seq = 0;
const pending = new Map();
socket.onmessage = (e) => {
  const f = JSON.parse(e.data);
  if (f.t === "reply") {
    const p = pending.get(f.id);
    pending.delete(f.id);
    if (p) f.ok ? p.resolve(f.result) : p.reject(new Error(f.error));
  }
};
const invoke = (cmd, args = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ t: "invoke", id, cmd, args }));
  });
const mutate = async (action, args) =>
  (await invoke(`world_${action}`, { ...args, requestId: crypto.randomUUID() }))
    .result;
const snapshot = () => invoke("world_snapshot");
async function until(label, check) {
  for (let n = 0; n < 150; n++) {
    const s = await snapshot();
    const result = check(s);
    if (result) {
      console.log(label);
      return result;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${label} timed out`);
}
try {
  assert.equal(
    (await snapshot()).world.orgs.length,
    0,
    "Requires an empty disposable world",
  );
  const projectPath = path.join(output, "project");
  await fs.mkdir(projectPath);
  await fs.writeFile(
    path.join(projectPath, "calc.cjs"),
    "exports.add = (a, b) => a - b;\n",
  );
  await fs.writeFile(
    path.join(projectPath, "calc.test.cjs"),
    "const {test}=require('node:test'); const assert=require('node:assert/strict'); const {add}=require('./calc.cjs'); test('adds positive and negative values',()=>{assert.equal(add(2,3),5);assert.equal(add(-2,3),1)});\n",
  );
  await fs.writeFile(
    path.join(projectPath, ".env"),
    "PRIVATE_FIXTURE=never_copy_me\n",
  );
  const org = (await mutate("create_org", { name: "Runtime QA" })).id;
  const project = (
    await mutate("create_project", {
      orgId: org,
      name: "Calculator",
      workspacePath: projectPath,
      runnerImage: "node:22-alpine",
      context:
        "A small CommonJS calculator. Test command: node --test calc.test.cjs. Keep tests intact.",
    })
  ).id;
  let s = await snapshot();
  const roles = {};
  for (const kind of ["pm", "dev", "tester"]) {
    const profession = s.world.professions.find(
      (p) => p.orgId === org && p.kind === kind,
    ).id;
    roles[kind] = (
      await mutate("create_agent", {
        orgId: org,
        name: `QA ${kind}`,
        professionId: profession,
        provider: "codex",
        model: "default",
        kind: "worker",
        allProjects: false,
        projectIds: [project],
        appearance: "A friendly pixel office character",
      })
    ).id;
  }
  const workflow = (
    await mutate("create_workflow", {
      orgId: org,
      name: "Fix and verify",
      professionIds: ["dev", "tester"].map(
        (k) =>
          s.world.professions.find((p) => p.orgId === org && p.kind === k).id,
      ),
    })
  ).id;
  const task = (
    await mutate("create_task", {
      projectId: project,
      title: "Fix add(a,b) returning subtraction",
      detail:
        "Inspect calc.cjs and calc.test.cjs. Developer: run node --test calc.test.cjs to reproduce, fix only calc.cjs with write_file, then run tests. Tester: independently run node --test calc.test.cjs and report the real exit code. Keep the existing test unchanged. Use the supplied workflow and do not ask for already specified choices.",
      route: "auto",
      workflowId: workflow,
    })
  ).id;
  await until("PM → Dev → Tester reached Verify", (s) => {
    const t = s.world.tasks.find((t) => t.id === task);
    if (t.status === "needs_input")
      throw new Error(JSON.stringify(t.messages.slice(-3)));
    return t.status === "verifying" && t;
  });
  const source = await fs.readFile(path.join(projectPath, "calc.cjs"), "utf8");
  assert.ok(source.includes("+"));
  s = await snapshot();
  const t = s.world.tasks.find((t) => t.id === task);
  assert.equal(t.steps.length, 2);
  assert.ok(t.steps.every((step) => step.evidence));
  const commands = t.messages.filter((m) =>
    m.body.startsWith("Command result"),
  );
  assert.ok(
    commands.some(
      (m) => JSON.parse(m.body.slice(m.body.indexOf("{"))).exitCode === 1,
    ),
    "Captured a real failing test",
  );
  assert.ok(
    commands.filter(
      (m) => JSON.parse(m.body.slice(m.body.indexOf("{"))).exitCode === 0,
    ).length >= 2,
    "Dev and Tester each ran passing checks",
  );
  await mutate("verify_task", {
    taskId: task,
    evidence:
      "Live integration fixture: add(2,3)=5 and add(-2,3)=1; Dev and Tester each ran node --test with exit code 0.",
  });
  s = await snapshot();
  assert.equal(s.world.tasks.find((t) => t.id === task).status, "done");
  assert.ok(s.world.xp.some((x) => x.agentId === roles.dev));
  assert.ok(s.world.xp.some((x) => x.agentId === roles.tester));
  assert.ok(s.world.usage.every((u) => u.input !== null && u.output !== null));
  const taskCount = s.world.tasks.length;
  const meeting = (
    await mutate("create_meeting", {
      projectId: project,
      title:
        "Discuss more edge cases. Do not execute any commands or create tasks.",
      participantIds: [roles.dev, roles.tester],
    })
  ).id;
  await mutate("meeting_message", {
    meetingId: meeting,
    body: "Brainstorm additional calculator test cases from your own profession. Do not run tools, edit files, or create tasks.",
  });
  await until("Multi-agent discussion completed without execution", (s) => {
    const m = s.world.meetings.find((m) => m.id === meeting);
    if (m.status === "paused") throw new Error(JSON.stringify(m.messages));
    return m.status === "idle" && m.messages.length >= 2 && m;
  });
  s = await snapshot();
  assert.equal(s.world.tasks.length, taskCount);
  assert.ok(
    s.world.runs
      .filter((r) => r.targetId === meeting)
      .every((r) => r.kind === "meeting"),
  );
  await fs.writeFile(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        status: "PASS",
        taskId: task,
        commands: commands.length,
        usageSamples: s.world.usage.length,
        task: s.world.tasks.find((t) => t.id === task),
        meeting: s.world.meetings.find((m) => m.id === meeting),
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: real failing test, source fix, two passing checks, founder verification, token/XP attribution, discussion-only meeting",
  );
} finally {
  socket.close();
}
