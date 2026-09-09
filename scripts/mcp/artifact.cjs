"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CREATE_ARTIFACT = {
  name: "create_artifact",
  annotations: { title: "Create HTML artifact", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  description: "Create a standalone offline HTML document for reading or per-item decisions and comments. Returns the absolute file path: link it in your reply (and optionally pin_file). The person copies feedback JSON back into chat; pending/null is never approval. Use stable artifact/item/option IDs and increment revision when content changes. Content is plain text, not HTML. Existing files are never overwritten.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      artifactId: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$" },
      revision: { type: "integer", minimum: 1 },
      title: { type: "string" },
      description: { type: "string" },
      mode: { type: "string", enum: ["read", "review"], default: "review" },
      language: { type: "string", enum: ["en", "zh-CN"], default: "en" },
      outputDir: { type: "string", description: "Optional existing directory. Defaults to OCTIQ_CANVAS_DIR, or the project working directory. A unique .html file is created there." },
      items: {
        type: "array", minItems: 1, maxItems: 200,
        items: {
          type: "object", additionalProperties: false,
          properties: {
            id: { type: "string" }, title: { type: "string" }, body: { type: "string" },
            options: { type: "array", maxItems: 12, description: "In review mode, omitted means Accept / Request changes / Defer; [] means comments only. Read mode is always comments only.", items: {
              type: "object", additionalProperties: false,
              properties: { id: { type: "string" }, label: { type: "string" } }, required: ["id", "label"],
            } },
          }, required: ["id", "title", "body"],
        },
      },
    }, required: ["artifactId", "revision", "title", "items"],
  },
};

function validateArtifact(input) {
  const object = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!object(input)) throw new Error("Artifact must be an object.");
  const str = (v, label, max, empty = false) => {
    if (typeof v !== "string" || (!empty && !v.trim()) || v.length > max) throw new Error(`${label} must be ${empty ? "" : "non-empty "}text, at most ${max} characters.`);
    return v;
  };
  const id = (v, label) => {
    if (typeof v !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(v)) throw new Error(`${label} must be a safe ID (1–80 letters, numbers, underscores or hyphens).`);
    return v;
  };
  const artifactId = id(input.artifactId, "artifactId");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error("revision must be a positive safe integer.");
  const mode = input.mode ?? "review";
  const language = input.language ?? "en";
  if (!["read", "review"].includes(mode)) throw new Error("mode must be read or review.");
  if (!["en", "zh-CN"].includes(language)) throw new Error("language must be en or zh-CN.");
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 200) throw new Error("Provide 1–200 items.");
  const ids = new Set();
  const items = input.items.map((item) => {
    if (!object(item)) throw new Error("Each item must be an object.");
    const itemId = id(item.id, "item.id");
    if (ids.has(itemId)) throw new Error(`Duplicate item ID: ${itemId}`);
    ids.add(itemId);
    const defaults = language === "zh-CN" ? ["接受", "需要修改", "暂缓"] : ["Accept", "Request changes", "Defer"];
    const raw = item.options ?? ["accept", "modify", "defer"].map((id, i) => ({ id, label: defaults[i] }));
    if (!Array.isArray(raw) || raw.length > 12) throw new Error("options must be an array of at most 12 entries.");
    const optionIds = new Set();
    const options = raw.map((option) => {
      if (!object(option)) throw new Error("Each option must be an object.");
      const optionId = id(option.id, "option.id");
      if (optionIds.has(optionId)) throw new Error(`Duplicate option ID: ${optionId}`);
      optionIds.add(optionId);
      return { id: optionId, label: str(option.label, "option.label", 200) };
    });
    return { id: itemId, title: str(item.title, "item.title", 500), body: str(item.body, "item.body", 50000, true), options: mode === "read" ? [] : options };
  });
  const result = { schemaVersion: 1, artifactId, revision: input.revision, title: str(input.title, "title", 500), description: str(input.description ?? "", "description", 10000, true), mode, language, items };
  if (Buffer.byteLength(JSON.stringify(result)) > 2_000_000) throw new Error("Artifact content must be under 2 MB.");
  return result;
}

function normalizeFeedback(data, value) {
  const t = (en, cn) => data.language === "zh-CN" ? cn : en;
  if (!value || value.schemaVersion !== 1 || value.artifactId !== data.artifactId || value.revision !== data.revision || !Array.isArray(value.items) || value.items.length !== data.items.length || typeof value.overallComment !== "string" || value.overallComment.length > 50000) throw new Error(t("Feedback does not match this artifact and revision.", "反馈与当前 artifact 或版本不匹配。"));
  const ids = new Set();
  const items = data.items.map(item => {
    const row = value.items.find(v => v && v.id === item.id);
    if (!row || ids.has(row.id) || typeof row.comment !== "string" || row.comment.length > 50000 || (row.decision !== null && !item.options.some(o => o.id === row.decision))) throw new Error(t("Invalid feedback items or decisions.", "反馈项目或决策无效。"));
    ids.add(row.id);
    return { id: row.id, decision: row.decision, comment: row.comment };
  });
  return { schemaVersion: 1, artifactId: data.artifactId, revision: data.revision, items, overallComment: value.overallComment };
}

// This function is embedded verbatim into the standalone document. Keep it
// dependency-free and use textContent for all agent/user-supplied content.
function artifactApp() {
  const data = JSON.parse(document.getElementById("artifact-data").textContent);
  const zh = data.language === "zh-CN";
  const t = (en, cn) => zh ? cn : en;
  const $ = (id) => document.getElementById(id);
  const storageKey = `octiq-artifact:${data.artifactId}:${data.revision}`;
  const blank = () => ({ schemaVersion: 1, artifactId: data.artifactId, revision: data.revision, items: data.items.map(item => ({ id: item.id, decision: null, comment: "" })), overallComment: "" });
  let feedback = blank();
  let storageAvailable = true;
  const controls = [];
  const normalize = (value) => normalizeFeedback(data, value);
  const embedded = JSON.parse($("artifact-feedback").textContent);
  if (embedded) { try { feedback = normalize(embedded); } catch {} }
  // A saved HTML snapshot is authoritative; do not replace it with an older
  // browser draft. Original documents may restore their own matching draft.
  try {
    if (!embedded) {
      const saved = localStorage.getItem(storageKey);
      if (saved) feedback = normalize(JSON.parse(saved));
    }
  } catch { storageAvailable = false; }
  function payload() {
    return { ...feedback, items: feedback.items.map(row => ({ ...row, status: row.decision !== null ? "decided" : row.comment.trim() ? "commented" : "pending" })) };
  }
  function update(save = true) {
    const touched = feedback.items.filter(r => r.decision !== null || r.comment.trim()).length;
    $("progress").textContent = t(`${touched} / ${data.items.length} items with feedback`, `${touched} / ${data.items.length} 项已有反馈`);
    $("export").value = JSON.stringify(payload(), null, 2);
    if (save) { try { localStorage.setItem(storageKey, JSON.stringify(feedback)); } catch { storageAvailable = false; } }
    $("draft").textContent = storageAvailable ? t("Draft saved in this browser. Save an HTML copy to keep it with the file.", "草稿已保存在当前浏览器。保存 HTML 副本可将反馈保留在文件中。") : t("Browser draft storage unavailable. Save an HTML copy before closing, or copy the JSON.", "浏览器无法保存草稿。关闭前请保存 HTML 副本，或复制 JSON。");
    for (const { row, badge, buttons } of controls) {
      badge.textContent = row.decision !== null ? t("Decided", "已决策") : row.comment.trim() ? t("Commented", "已评论") : t("Pending", "待处理");
      badge.className = "badge" + (row.decision !== null || row.comment.trim() ? " done" : "");
      for (const [id, button] of buttons) button.setAttribute("aria-pressed", String(row.decision === id));
    }
  }
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function render() {
    controls.length = 0;
    $("items").replaceChildren();
    data.items.forEach((item, index) => {
      const row = feedback.items[index];
      const card = el("article", "card");
      const head = el("div", "item-head");
      const badge = el("span", "badge");
      head.append(el("span", "number", String(index + 1).padStart(2, "0")), badge);
      const heading = el("h2", "", item.title);
      heading.id = `item-${index}`;
      card.setAttribute("aria-labelledby", heading.id);
      card.append(head, heading, el("div", "body", item.body));
      const buttons = [];
      if (item.options.length) {
        const choices = el("div", "choices");
        choices.setAttribute("role", "group");
        choices.setAttribute("aria-label", t("Decision for ", "决策：") + item.title);
        for (const option of item.options) {
          const button = el("button", "choice", option.label);
          button.type = "button";
          button.onclick = () => { row.decision = row.decision === option.id ? null : option.id; update(); };
          choices.append(button);
          buttons.push([option.id, button]);
        }
        card.append(choices);
      }
      const label = el("label", "comment-label", t("Your comments", "你的评论"));
      label.htmlFor = `comment-${index}`;
      const area = el("textarea");
      area.id = label.htmlFor;
      area.rows = 3;
      area.maxLength = 50000;
      area.placeholder = t("Add a remark, question, or requested change…", "留下意见、问题或需要修改的地方…");
      area.value = row.comment;
      area.oninput = () => { row.comment = area.value; update(); };
      card.append(label, area);
      $("items").append(card);
      controls.push({ row, badge, buttons });
    });
    $("overall").value = feedback.overallComment;
    update();
  }
  document.title = data.title;
  document.documentElement.lang = data.language;
  $("title").textContent = data.title;
  $("description").textContent = data.description;
  $("eyebrow").textContent = t("OCTIQFLOW / ", "OCTIQFLOW / ") + (data.mode === "read" ? t("READ & REFLECT", "阅读与评论") : t("REVIEW & DECIDE", "审阅与决策"));
  $("revision").textContent = `${data.artifactId} · v${data.revision}`;
  $("hint").textContent = t("Review each item at your pace. Nothing is approved by default. Copy your feedback back to the agent when ready.", "逐项阅读并留下反馈。所有项目默认待处理；完成后将反馈 JSON 粘贴回 agent。");
  $("overall-label").textContent = t("Overall comments", "整体意见");
  $("overall").placeholder = t("Anything that applies to the whole document…", "适用于整个文档的意见…");
  $("overall").oninput = () => { feedback.overallComment = $("overall").value; update(); };
  $("copy").textContent = t("Copy all feedback JSON", "复制全部反馈 JSON");
  $("save").textContent = t("Save HTML with feedback", "保存含反馈的 HTML");
  $("json-label").textContent = t("View / copy JSON manually", "查看 / 手动复制 JSON");
  $("export").setAttribute("aria-label", t("All feedback JSON", "全部反馈 JSON"));
  $("import-label").textContent = t("Restore feedback JSON", "恢复反馈 JSON");
  $("import-json").setAttribute("aria-label", t("Paste feedback JSON to restore", "粘贴要恢复的反馈 JSON"));
  $("restore").textContent = t("Restore matching feedback", "恢复匹配的反馈");
  $("restore").onclick = () => {
    try {
      const value = $("import-json").value;
      if (value.length > 12_000_000) throw new Error(t("Feedback is too large.", "反馈过大。"));
      const restored = normalize(JSON.parse(value));
      if (!confirm(t("Replace current feedback with this JSON?", "用此 JSON 替换当前反馈？"))) return;
      feedback = restored;
      render();
      $("notice").textContent = t("Feedback restored.", "反馈已恢复。");
    } catch (error) { $("notice").textContent = error.message; }
  };
  $("copy").onclick = async () => {
    const text = JSON.stringify(payload(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      $("notice").textContent = t("Copied. Paste the JSON back to your agent.", "已复制。将 JSON 粘贴回 agent 即可。");
    } catch {
      $("json-details").open = true;
      $("export").focus();
      $("export").select();
      let copied = false;
      try { copied = document.execCommand("copy"); } catch {}
      $("notice").textContent = copied ? t("Copied. Paste the JSON back to your agent.", "已复制。将 JSON 粘贴回 agent 即可。") : t("Copy is blocked here. Copy the selected JSON below manually.", "此处无法自动复制，请手动复制下方已选中的 JSON。");
    }
  };
  let downloadUrl;
  $("save").onclick = () => {
    // Clone the inert document, then reset all live controls. The embedded
    // feedback is the one source of truth when opening the downloaded copy.
    const clone = document.documentElement.cloneNode(true);
    clone.querySelector("#artifact-feedback").textContent = JSON.stringify(payload()).replace(/</g, "\\u003c");
    clone.querySelector("#items").replaceChildren();
    clone.querySelectorAll("textarea").forEach(node => { node.textContent = ""; });
    clone.querySelector("#notice").textContent = "";
    const blob = new Blob(["<!doctype html>\n", clone.outerHTML], { type: "text/html;charset=utf-8" });
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(blob);
    const a = el("a");
    a.href = downloadUrl;
    a.download = `${data.artifactId}-r${data.revision}-feedback.html`;
    a.textContent = t("If the download does not start, download the prepared HTML here.", "若下载未开始，点击此处下载已准备好的 HTML。");
    $("notice").replaceChildren(document.createTextNode(t("HTML prepared. ", "HTML 已准备好。")), a);
    a.click();
  };
  render();
}

function renderArtifact(input) {
  const data = validateArtifact(input);
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="${data.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>OctiqFlow artifact</title>
<style>
:root{color-scheme:dark;--bg:#141917;--panel:#1c2420;--ink:#edf2ed;--muted:#a5b5aa;--line:#37493e;--accent:#b8ddac}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:900px;margin:auto;padding:56px 24px 32px}.eyebrow{font-size:12px;font-weight:700;letter-spacing:.15em;color:var(--accent)}h1{font-size:clamp(28px,5vw,44px);line-height:1.2;letter-spacing:-.03em;margin:18px 0}h2{font-size:23px;line-height:1.4;margin:16px 0}.description,.body{white-space:pre-wrap;overflow-wrap:anywhere}.description{font-size:18px;color:#cfdbd0}.meta,#hint,#draft{color:var(--muted);font-size:13px}.meta{margin-top:22px}#hint{border-left:2px solid var(--accent);padding-left:16px;margin:26px 0 32px}.card{border:1px solid var(--line);background:var(--panel);border-radius:16px;padding:26px;margin:20px 0}.item-head{display:flex;align-items:center;justify-content:space-between;gap:16px}.number{color:var(--muted);font:13px ui-monospace,monospace}.badge{font-size:12px;border:1px solid var(--line);border-radius:30px;padding:2px 10px;color:var(--muted)}.done{color:var(--accent);border-color:#658659}.body{margin-bottom:24px;color:#d8e1d8}.choices{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:22px}button{font:inherit;font-size:14px;cursor:pointer;color:var(--ink);background:#25322b;border:1px solid #506358;border-radius:9px;padding:10px 15px}button:hover{background:#33483b}button[aria-pressed=true],#copy{background:var(--accent);border-color:var(--accent);color:#182318}button:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:3px}label{display:block;font-size:13px;color:var(--muted);margin:10px 0}textarea{display:block;width:100%;resize:vertical;background:#141c17;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:12px;font:inherit;font-size:15px;line-height:1.6}textarea::placeholder{color:#90a095}footer{position:sticky;bottom:0;background:#18211bf5;border-top:1px solid var(--line);padding:16px 24px;backdrop-filter:blur(12px)}.footer-inner{max-width:852px;margin:auto}.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}#progress{margin-right:auto;font-size:13px;color:var(--accent)}#notice{font-size:13px;color:var(--accent);margin:8px 0 0;overflow-wrap:anywhere}#notice:empty{display:none}details{margin:20px 0}a{color:var(--accent)}summary{cursor:pointer;color:var(--muted);padding:8px 0}#export,#import-json{font:12px/1.6 ui-monospace,monospace;min-height:180px}#restore{margin-top:12px}#draft{margin:12px 0 0}@media(max-width:540px){main{padding:28px 16px 20px}.card{padding:20px}footer{padding:12px 16px}#progress{flex-basis:100%}.actions button{flex:1}h2{font-size:20px}}@media print{footer,.choices,details,#hint,#draft{display:none}body{background:white;color:black}.card{break-inside:avoid;background:white;border:1px solid #aaa}.body,.description,label{color:black}textarea{background:white;color:black}}
</style></head><body>
<main><header><div id="eyebrow" class="eyebrow"></div><h1 id="title"></h1><div id="description" class="description"></div><div id="revision" class="meta"></div><p id="hint"></p></header>
<section id="items" aria-label="Items"></section>
<section class="card"><label id="overall-label" for="overall"></label><textarea id="overall" rows="3" maxlength="50000"></textarea><p id="draft"></p></section>
<details id="json-details"><summary id="json-label"></summary><textarea id="export" readonly spellcheck="false"></textarea></details>
<details><summary id="import-label"></summary><textarea id="import-json" spellcheck="false"></textarea><button id="restore" type="button"></button></details>
<noscript>This artifact needs JavaScript to display its content and collect feedback.</noscript></main>
<footer><div class="footer-inner"><div class="actions"><span id="progress"></span><button id="save" type="button"></button><button id="copy" type="button"></button></div><p id="notice" role="status" aria-live="polite"></p></div></footer>
<script id="artifact-data" type="application/json">${json}</script>
<script id="artifact-feedback" type="application/json">null</script>
<script>${normalizeFeedback.toString()}
(${artifactApp.toString()})();</script>
</body></html>\n`;
}

function createArtifact(input) {
  const html = renderArtifact(input);
  if (input.outputDir !== undefined && (typeof input.outputDir !== "string" || !input.outputDir.trim())) throw new Error("outputDir must be a non-empty existing directory.");
  const dir = path.resolve(input.outputDir || process.env.OCTIQ_CANVAS_DIR || process.env.OCTIQ_CWD || process.cwd());
  if (!fs.statSync(dir).isDirectory()) throw new Error("outputDir must be an existing directory.");
  const name = `${input.artifactId}-r${input.revision}-${require("node:crypto").randomUUID()}.html`;
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, html, { flag: "wx", mode: 0o600 });
  return { filePath, artifactId: input.artifactId, revision: input.revision, itemCount: input.items.length };
}

module.exports = { CREATE_ARTIFACT, validateArtifact, normalizeFeedback, renderArtifact, createArtifact };

// Standalone CLI: node artifact.cjs input.json [existing-output-directory]
if (require.main === module) {
  try {
    const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    if (process.argv[3]) input.outputDir = process.argv[3];
    process.stdout.write(JSON.stringify(createArtifact(input)) + "\n");
  } catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
}
