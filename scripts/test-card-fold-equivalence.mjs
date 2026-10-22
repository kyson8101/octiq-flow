// Compare the production optimization with the exact pre-fix implementation,
// including controls that must never be mistaken for harmless ASCII.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {test} from 'node:test';
import {browserPaths} from './browser-paths.mjs';

const {webRoot, require} = browserPaths(import.meta.url);
const {transpileModule, ScriptTarget, ModuleKind} = require('typescript');
const repo = resolve(webRoot, '..');
const baseline = execFileSync('git', ['show', '12768e13941501edc789b0855b86b94632ec5b3f:web/src/lib/cardFold.ts'], {cwd: repo, encoding: 'utf8'});
const current = await readFile(join(webRoot, 'src/lib/cardFold.ts'), 'utf8');
async function load(source) {
  const js = transpileModule(source, {compilerOptions: {target: ScriptTarget.ES2022, module: ModuleKind.ES2022}}).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const old = await load(baseline);
const now = await load(current);
function snapshot(api, text) {
  const fold = api.commandFold(text);
  return {
    chars: api.chars(text), fold,
    hidden: api.hiddenIn(text), drawn: api.drawnChars(text),
    marksInText: api.marksInText(api.hiddenIn(text).count),
    parts: api.commandDrawn(text),
    notShown: [false, true].map(open => api.notShown(fold, api.commandShown(fold, open))),
  };
}

test('optimized folding matches 12768e1 for plain text, controls and mixed Unicode', () => {
  const controls = ['\0', '\x7f', '\r', '\r\n', '\t', '\n'];
  const inputs = [
    '', 'echo safe\n'.repeat(20), 'c'.repeat(old.WHOLE_MAX + 1),
    Array.from({length: 128}, (_, code) => String.fromCharCode(code)).join(''),
    '😀\ud83d\ude00\ude00\ud83d', 'echo \u202e\u200b\u{e0001}', '甲\u3000乙 A\u3000B',
    ...controls.flatMap(char => [char, `echo safe${char}rm dangerous`, `a${char}b\n`.repeat(5100)]),
  ];
  for (const [index, text] of inputs.entries()) {
    assert.deepEqual(snapshot(now, text), snapshot(old, text), `input ${index}, ${text.length} units`);
  }
});
