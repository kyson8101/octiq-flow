// Real PlanReview, TaskPlanCard, run/mission panel and CSS; bridge mocked.
// Host snapshots are read verbatim. Only the three-task visual scene changes
// a COPY: names the writer/reviewer and clones the writer with a distinct id
// and proposal path. No host fixture is reconstructed or edited.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPaths } from "./browser-paths.mjs";

const { webRoot, require, moduleUrl } = browserPaths(import.meta.url);
const { createServer } = await import(moduleUrl(require.resolve("vite")));
const { chromium } = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || "playwright"));
const artifacts = process.env.OCTIQ_EVIDENCE_DIR || await mkdtemp(join(tmpdir(), "octiq-workspace-choice-"));
await mkdir(artifacts, { recursive: true });
const fixture = async (name) => JSON.parse(await readFile(join(webRoot, "src/lib/__fixtures__/host", `workspace_choice_${name}.json`), "utf8"));
const pending = await fixture("pending");
const approved = await fixture("approved");
const onlyCheckout = await fixture("only_checkout");
const visual = structuredClone(pending);
visual.tasks[0].title = "Implement the page";
visual.tasks[1].title = "Review the changes";
visual.tasks[1].kind = "review";
const writer = visual.tasks[0];
const other = JSON.parse(JSON.stringify(writer).replaceAll(writer.id, `${writer.id}-second`));
other.title = "Wire the import flow";
visual.tasks.splice(1, 0, other);

const entry = `
import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {PlanReview} from "/src/components/PlanReview.tsx";
import {OrchestrationPanel} from "/src/components/OrchestrationPanel.tsx";
import {applyTheme} from "/src/lib/themeStore.ts";
import "@fontsource-variable/inter";
import "/src/design-system.css";
import "/src/styles.css";
import "/src/manga.css";
import "/src/guofeng.css";
import "/src/xp.css";
import "/src/cyberpunk.css";
applyTheme(new URL(location.href).searchParams.get("theme") || "dark");
window.approvalCallbacks = 0;
window.choiceCalls = [];
window.refuse = false;
let snapshot = ${JSON.stringify(visual)};
window.choiceInvoke = async (cmd, args) => {
  if (cmd === "orchestration_plan_approve") {
    window.choiceCalls.push({cmd, args});
    if (window.refuse) throw new Error("This plan changed. Review revision 5 before approving.");
  }
  if (cmd === "orchestration_snapshot") return snapshot;
  return [];
};
function Scene() {
  const [data, setData] = useState(snapshot);
  const [mode, setMode] = useState("panel");
  window.updateChoiceScene = (next, nextMode = "panel") => {snapshot = next; setData(next); setMode(nextMode);};
  return <main className="choice-qa" style={{maxWidth: 980, margin: "0 auto", padding: 16}}>
    {mode === "run" || mode === "mission"
      ? <aside style={{display: "flex", height: "95vh"}}><OrchestrationPanel key={mode} embedded readOnly project={{id:"project", name:"OctiqFlow"}}
          coordinatorKey={data.runs[0].coordinatorChatKey} initialSnapshot={data} onOpenChat={() => {}} onClose={() => {}} /></aside>
      : <PlanReview run={data.runs[0]} tasks={data.tasks} drafting={false} approved={data.runs[0].planApproval.status === "approved"}
          folds={mode === "chat"} surface={mode === "chat" ? "chat" : "panel"} onApproved={() => {window.approvalCallbacks += 1;}} onRequestChanges={() => {}} />}
  </main>;
}
createRoot(document.getElementById("root")).render(<Scene/>);
`;
const server = await createServer({
  root: webRoot, configFile: join(webRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "workspace-choice-harness", enforce: "pre",
    resolveId(id) {
      if (id === "/__workspace-choice.tsx") return id;
      if (id.endsWith("/lib/bridge") || id.endsWith("/lib/bridge.ts") || id === "./bridge") return "\0choice-bridge";
    },
    load(id) {
      if (id === "/__workspace-choice.tsx") return entry;
      if (id === "\0choice-bridge") return "export const bridge = {invoke:(...args)=>window.choiceInvoke(...args),on:()=>()=>{},onState:()=>()=>{}};";
    },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/__workspace-choice") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml("/__workspace-choice", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__workspace-choice.tsx"></script></body></html>'));
      });
    },
  }],
});
let browser;
const errors = [];
const report = {artifacts, mockedBridge: true, hostFixtures: true, widths: []};
async function update(page, data, mode = "panel") {
  await page.evaluate(({data, mode}) => window.updateChoiceScene(data, mode), {data, mode});
  await page.waitForTimeout(50);
}
async function openTasks(page) {
  for (const summary of await page.locator(".plan-task > details > summary").all()) {
    if (!(await summary.evaluate(node => node.parentElement.open))) {
      await summary.focus();
      await summary.press("Enter");
    }
  }
}
const radio = (page, index, value) => page.locator(".plan-workspace-options").nth(index).locator(`input[value="${value}"]`);
async function screenshot(page, name) {
  // Place the real sticky answer bar at the end before a full-page capture,
  // so the screenshot does not paint it across a task halfway down the page.
  await page.evaluate(() => window.scrollTo(0,document.body.scrollHeight));
  await page.screenshot({path:join(artifacts,name),fullPage:true});
}
try {
  await server.listen();
  browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  for (const width of [1280, 390]) {
    const context = await browser.newContext({viewport:{width,height:900}, reducedMotion:"reduce", ...(width === 390 ? {hasTouch:true} : {})});
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__workspace-choice`);
    await page.getByRole("heading", {name:"Plan ready for review"}).waitFor();
    await openTasks(page);
    assert.equal(await page.getByRole("radiogroup").count(), 3);
    assert(await radio(page,0,"worktree").isChecked());
    assert(await radio(page,1,"worktree").isChecked());
    assert(await radio(page,2,"checkout").isChecked());
    const sizes = await page.locator(".plan-workspace-options label").evaluateAll(labels => labels.map(label => ({height:label.getBoundingClientRect().height,width:label.getBoundingClientRect().width})));
    assert(sizes.every(size => size.height >= 44 && size.width >= 44));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await screenshot(page,`${width}-advice.png`);
    if (width === 390) {
      await radio(page,0,"checkout").locator("..").tap();
      assert(await radio(page,0,"checkout").isChecked(),"a phone tap chooses checkout");
      await radio(page,0,"checkout").focus();
      await page.keyboard.press("ArrowLeft");
    }
    // Native keyboard arrows select the other radio; a held Space changes nothing.
    await radio(page,0,"worktree").focus();
    await page.keyboard.press("ArrowRight");
    assert(await radio(page,0,"checkout").isChecked());
    await radio(page,0,"worktree").dispatchEvent("keydown", {key:" ",repeat:true,bubbles:true,cancelable:true});
    assert(await radio(page,0,"checkout").isChecked());
    await page.getByText("1 task in current checkout",{exact:false}).waitFor();
    await page.getByText("Works in this chat's folder; one writer at a time.",{exact:true}).waitFor();
    await screenshot(page,`${width}-changed.png`);
    // A refusal leaves all controls and choices in place, with the host's words.
    await page.evaluate(() => { window.refuse = true; });
    await page.getByRole("button",{name:"Approve plan",exact:true}).click();
    await page.getByRole("alert").filter({hasText:"This plan changed. Review revision 5 before approving."}).waitFor();
    await screenshot(page,`${width}-refused.png`);
    assert(await radio(page,0,"checkout").isChecked());
    const calls = await page.evaluate(() => window.choiceCalls);
    assert.equal(calls.length,1);
    assert.equal(await page.evaluate(()=>window.approvalCallbacks),0,"a refusal never calls onApproved");
    assert.deepEqual(calls[0].args.workspaceChoices,{[writer.id]:"checkout"});
    assert.equal(calls[0].args.revision,visual.runs[0].planApproval.revision);
    assert.deepEqual(calls[0].args.taskIds,visual.tasks.map(task=>task.id));
    assert.equal(calls[0].args.surface,"panel");
    // Same revision refresh retains it; a new revision resets before approval.
    await update(page,structuredClone(visual));
    assert(await radio(page,0,"checkout").isChecked());
    const revised = structuredClone(visual);
    revised.runs[0].planApproval.revision += 1;
    await update(page,revised);
    assert(await radio(page,0,"worktree").isChecked());
    assert.equal(await page.locator(".plan-workspace-fact").count(),0);
    assert.equal(await page.getByRole("alert").count(),0,"the old refusal belongs to its revision");
    assert(await page.getByRole("button",{name:"Approve plan",exact:true}).isDisabled());
    assert.equal((await page.evaluate(()=>window.choiceCalls)).length,1,"new revision settles before approval");
    // Another run with the same revision never inherits the draft.
    await page.waitForTimeout(750);
    await radio(page,0,"checkout").check();
    const otherRun = structuredClone(revised);
    otherRun.runs[0].id = "other-run";
    for (const task of otherRun.tasks) task.runId = "other-run";
    await update(page,otherRun);
    assert(await radio(page,0,"worktree").isChecked());
    // Chat card: a changed choice stays in the short facts after folding.
    await update(page,visual,"chat");
    await page.getByRole("button",{name:"Show the tasks"}).click();
    await radio(page,0,"checkout").check();
    await page.getByRole("button",{name:"Hide the tasks"}).click();
    await page.getByText("1 task in current checkout",{exact:false}).waitFor();
    assert.equal(await page.getByRole("radiogroup").count(),0);
    await screenshot(page,`${width}-folded-change.png`);
    // A repeat of the opening press cannot select a radio that moved there.
    await page.getByRole("button",{name:"Show the tasks"}).click();
    const target = radio(page,1,"checkout");
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    await page.getByRole("button",{name:"Hide the tasks"}).dispatchEvent("click",{detail:0});
    await page.getByRole("button",{name:"Show the tasks"}).dispatchEvent("click",{detail:1,clientX:box.x+box.width/2,clientY:box.y+box.height/2});
    await radio(page,1,"checkout").dispatchEvent("click",{detail:1,clientX:box.x+box.width/2,clientY:box.y+box.height/2});
    assert(await radio(page,1,"worktree").isChecked());
    // Only checkout: no controls, and the host's whole explanation is kept.
    await update(page,onlyCheckout);
    await openTasks(page);
    assert.equal(await page.getByRole("radiogroup").count(),0);
    await page.getByText(onlyCheckout.tasks[0].workspaceChoice.onlyCheckoutBecause,{exact:false}).waitFor();
    await screenshot(page,`${width}-only-checkout.png`);
    // Approved modes are read-only in PlanReview, run task details and mission.
    await update(page,approved);
    await openTasks(page);
    assert.equal(await page.getByRole("radio").count(),0);
    await page.getByText("Works in this chat's folder; one writer at a time.",{exact:true}).waitFor();
    await screenshot(page,`${width}-approved.png`);
    for (const mode of ["run","mission"]) {
      const snapshot = structuredClone(approved);
      if (mode === "mission") snapshot.runs[0].workspaceMode = "mission";
      await update(page,snapshot,mode);
      const row = page.locator(".orch-task").first();
      await row.getByRole("button",{name:/Expand task progress:/}).click();
      await row.getByRole("tab",{name:"Details",exact:true}).click();
      const cards = page.locator(".orch-task .plan-card");
      await cards.first().waitFor();
      assert.match(await cards.first().innerText(),/Current checkout/);
      assert.equal(await cards.getByRole("radio").count(),0);
      await screenshot(page,`${width}-${mode}-approved.png`);
    }
    // Each appearance is mounted fresh, as a browser opening the saved
    // theme. This checks the real CSS cascade, including Manga's global
    // native-radio rule, without cached computed styles during theme swaps.
    for (const theme of ["dark","light","fun","manga","guofeng","xp","cyberpunk"]) {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__workspace-choice?theme=${theme}`);
      await page.getByRole("heading",{name:"Plan ready for review"}).waitFor();
      await openTasks(page);
      await radio(page,0,"worktree").scrollIntoViewIfNeeded();
      const colours = await page.evaluate(() => {
        const marker = document.createElement("span");
        marker.style.color = "var(--decide)";
        document.body.append(marker);
        const wanted = getComputedStyle(marker).color;
        marker.remove();
        return {wanted,actual:getComputedStyle(document.querySelector('.plan-workspace-options input')).accentColor};
      });
      assert.equal(colours.actual,colours.wanted,`${theme}: radio selection uses --decide`);
    }
    report.widths.push({width,targets:sizes,passed:true});
    await context.close();
  }
  assert.deepEqual(errors,[]);
  await writeFile(join(artifacts,"report.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} catch (error) {
  await browser?.contexts()[0]?.pages()[0]?.screenshot({path:join(artifacts,"failure.png"),fullPage:true}).catch(()=>{});
  console.error(JSON.stringify({error:String(error),errors,artifacts}));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
