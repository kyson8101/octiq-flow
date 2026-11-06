// Project the existing host fixtures through the ACTUAL Rust summary function.
// Run from any directory; Rust/Cargo and a cached serde_json crate are required.
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const host = join(root, 'web/src/lib/__fixtures__/host');
const scratch = await mkdtemp(join(tmpdir(), 'octiq-summary-fixtures-'));
try {
  const fixtures = {};
  for (const file of (await readdir(host)).sort()) {
    if (!file.endsWith('.json') || file === 'browser_summaries.json') continue;
    const parsed = JSON.parse(await readFile(join(host, file), 'utf8'));
    const value = parsed.snapshot ?? parsed;
    if (Array.isArray(value.runs) && Array.isArray(value.tasks)) fixtures[file] = value;
  }
  await mkdir(join(scratch, 'src'));
  await writeFile(join(scratch, 'Cargo.toml'), '[package]\nname="octiq-summary-fixtures"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nserde_json="1"\n');
  await writeFile(join(scratch, 'input.json'), JSON.stringify(fixtures));
  const source = join(root, 'src-tauri/src/orchestration/summary.rs');
  await writeFile(join(scratch, 'src/main.rs'), `#[allow(dead_code)]\n#[path=${JSON.stringify(source)}]\nmod summary;\nfn main() { let mut input: serde_json::Value = serde_json::from_slice(&std::fs::read(std::env::args().nth(1).unwrap()).unwrap()).unwrap(); for (_, value) in input.as_object_mut().unwrap() { summary::project(value); } println!("{}", serde_json::to_string_pretty(&input).unwrap()); }\n`);
  const output = execFileSync('cargo', ['run', '--offline', '--quiet', '--manifest-path', join(scratch, 'Cargo.toml'), '--', join(scratch, 'input.json')], { maxBuffer: 8 * 1024 * 1024 });
  await writeFile(join(host, 'browser_summaries.json'), output);
  console.log(`${Object.keys(fixtures).length} host snapshots projected through ${source}`);
} finally { await rm(scratch, { recursive: true, force: true }); }
