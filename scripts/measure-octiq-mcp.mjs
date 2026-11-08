// Measure our real stdio MCP at idle after discovery, without any host calls.
// Usage: node scripts/measure-octiq-mcp.mjs [evidence.json]
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const script = fileURLToPath(new URL("./mcp/octiq-ask.cjs", import.meta.url));
const samples = [];
for (let run = 0; run < 5; run++) for (const flags of [[], ["--optimize-for-size"], ["--jitless"]]) {
  const child = spawn(process.execPath, [...flags, script], {
    env: { ...process.env, OCTIQ_CHAT_KEY: "chat:footprint-fixture", OCTIQ_ORCHESTRATION_ATTEMPT: "", OCTIQ_FRONT_DESK: "", OCTIQ_CHAT_CAPABILITY: "", OCTIQ_HOOK_PORT: "", OCTIQ_SESSION_KEY: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let errors = ""; child.stderr.on("data", d => { errors += d; });
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const started = performance.now();
  try {
    for (let id = 0; id < 25; id++) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }) + "\n");
      const { value, done } = await iterator.next();
      if (done) throw new Error(`MCP ended: ${errors}`);
      const response = JSON.parse(value);
      if (!response.result.tools.length) throw new Error("No tools");
    }
    const discovery25Ms = performance.now() - started;
    await new Promise(r => setTimeout(r, 250));
    const rssKiB = Number(execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8" }).trim());
    samples.push({ run, flags, rssKiB, discovery25Ms });
  } finally {
    child.stdin.end();
    if (child.exitCode === null) await once(child, "exit");
    lines.close();
  }
}
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = ["default", "--optimize-for-size", "--jitless"].map(mode => {
  const selected = samples.filter(s => (s.flags[0] ?? "default") === mode);
  return { mode, rssKiB: median(selected.map(s => s.rssKiB)), discovery25Ms: median(selected.map(s => s.discovery25Ms)) };
});
const result = { node: process.version, platform: process.platform, samples, summary };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
