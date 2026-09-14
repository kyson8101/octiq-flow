"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseHTML } = require("linkedom");
const adapter = require("../extension/adapter.js");

function page(html = "") {
  const { document, HTMLElement } = parseHTML(`<html><body>${html}<div id="prompt-textarea" contenteditable="true"></div></body></html>`);
  HTMLElement.prototype.getClientRects = function () { return this.hidden ? [] : [{}]; };
  return document;
}
let messageSequence = 0;
function turn(doc, role, content, complete = false, tag = "section") {
  const container = doc.createElement(tag);
  container.setAttribute("data-turn", role);
  const message = doc.createElement("div");
  message.setAttribute("data-message-author-role", role);
  message.setAttribute("data-message-id", `message-${++messageSequence}`);
  message.textContent = content;
  container.append(message);
  if (complete) {
    const button = doc.createElement("button");
    button.setAttribute("data-testid", "copy-turn-action-button");
    container.append(button);
  }
  doc.body.append(container);
  return message;
}
test("old answers and controls cannot complete a new question", () => {
  const doc = page();
  turn(doc, "user", "old question");
  turn(doc, "assistant", "old answer", true);
  const before = adapter.snapshot(doc);
  assert.deepEqual(adapter.inspect(doc, before, "new question"), { sent: false, complete: false, text: "" });
  turn(doc, "user", "new question");
  assert.deepEqual(adapter.inspect(doc, before, "new question"), { sent: true, complete: false, text: "" });
  turn(doc, "assistant", "partial answer");
  assert.equal(adapter.inspect(doc, before, "new question").complete, false);
});
test("current section layout and older article layout recognize a completed new answer", () => {
  for (const tag of ["section", "article"]) {
    const doc = page();
    const before = adapter.snapshot(doc);
    turn(doc, "user", "my question", false, tag);
    turn(doc, "assistant", "the answer", true, tag);
    assert.deepEqual(adapter.inspect(doc, before, "my question"), { sent: true, complete: true, text: "the answer" });
  }
});
test("visible stop control prevents completion even if copy controls exist", () => {
  const doc = page('<button aria-label="Stop answering"></button>');
  const before = adapter.snapshot(doc);
  turn(doc, "user", "question");
  turn(doc, "assistant", "still streaming", true);
  assert.equal(adapter.inspect(doc, before, "question").complete, false);
  assert.equal(adapter.state(doc).busy, true);
  doc.querySelector("button").hidden = true;
  assert.equal(adapter.inspect(doc, before, "question").complete, true);
});
test("manual messages or mismatched prompts fail attribution", () => {
  const doc = page();
  const before = adapter.snapshot(doc);
  turn(doc, "user", "someone else's question");
  turn(doc, "assistant", "wrong answer", true);
  assert.throws(() => adapter.inspect(doc, before, "my question"), /conversation changed/);
  turn(doc, "user", "my question");
  assert.throws(() => adapter.inspect(doc, before, "my question"), /conversation changed/);
});
test("existing drafts are not overwritten and missing composers are not ready", () => {
  const doc = page();
  const input = doc.querySelector("#prompt-textarea");
  input.textContent = "unsent user draft";
  assert.equal(adapter.state(doc).ready, false);
  assert.throws(() => adapter.insert(doc, "bridge question"), /never overwritten/);
  assert.equal(input.textContent, "unsent user draft");
  input.remove();
  assert.equal(adapter.state(doc).ready, false);
});
test("plain-text insertion rejects editor failures without clicking Send", () => {
  const doc = page();
  doc.execCommand = () => false;
  assert.throws(() => adapter.insert(doc, "<script>not markup</script>"), /rejected text insertion/);
  doc.execCommand = (command, ui, value) => { assert.equal(command, "insertText"); doc.querySelector("#prompt-textarea").textContent = value; return true; };
  adapter.insert(doc, "<script>not markup</script>");
  assert.equal(doc.querySelector("script"), null);
  assert.equal(doc.querySelector("#prompt-textarea").textContent, "<script>not markup</script>");
});

test("follow-up answer is recognized when virtualization removes old turns and count stays equal", () => {
  const doc = page();
  const oldUser = turn(doc, "user", "old question");
  const oldAnswer = turn(doc, "assistant", "old answer", true);
  const before = adapter.snapshot(doc);
  oldUser.parentElement.remove();
  oldAnswer.parentElement.remove();
  turn(doc, "user", "next question");
  turn(doc, "assistant", "next answer", true);
  assert.deepEqual(adapter.inspect(doc, before, "next question"), { sent: true, complete: true, text: "next answer" });
});
test("remounted previous messages with the same IDs are never accepted as a repeated prompt", () => {
  const doc = page();
  turn(doc, "user", "repeat this");
  turn(doc, "assistant", "old answer", true);
  const before = adapter.snapshot(doc);
  doc.body.innerHTML = doc.body.innerHTML;
  assert.equal(adapter.inspect(doc, before, "repeat this").sent, false);
  turn(doc, "user", "repeat this");
  turn(doc, "assistant", "new answer", true);
  assert.equal(adapter.inspect(doc, before, "repeat this").text, "new answer");
});
test("history added above the captured tail does not masquerade as additional submissions", () => {
  const doc = page();
  const anchor = turn(doc, "user", "previous question");
  const before = adapter.snapshot(doc);
  const history = turn(doc, "user", "loaded historical question");
  doc.body.insertBefore(history.parentElement, anchor.parentElement);
  turn(doc, "user", "new question");
  turn(doc, "assistant", "new answer", true);
  assert.equal(adapter.inspect(doc, before, "new question").text, "new answer");
});
test("navigating to another conversation cannot satisfy an in-flight question", () => {
  const doc = page();
  doc.location = { pathname: "/c/original" };
  const before = adapter.snapshot(doc);
  doc.location.pathname = "/c/different";
  turn(doc, "user", "same question");
  turn(doc, "assistant", "wrong conversation answer", true);
  assert.throws(() => adapter.inspect(doc, before, "same question"), /conversation changed/);
});
