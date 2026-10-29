#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/octiq-prune-test.XXXXXX")"
scratch="$(cd "$scratch" && pwd -P)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/bin"
# Isolate tests from real builds on the person's machine.
cat > "$scratch/bin/pgrep" <<'STUB'
#!/usr/bin/env bash
[[ "${FAKE_RUNNING:-}" == "$2" ]]
STUB
chmod +x "$scratch/bin/pgrep"
export PATH="$scratch/bin:$PATH"
export FAKE_RUNNING=''
fail() { echo "FAIL: $*" >&2; exit 1; }
exists() { [[ -e "$1" || -L "$1" ]] || fail "missing $1"; }
gone() { [[ ! -e "$1" && ! -L "$1" ]] || fail "retained $1"; }
old() { touch -t 202001010000 "$@"; }
fixture() {
  local target="$1" profile crate
  for profile in debug release release-local custom; do
    local p="$target/$profile"
    mkdir -p "$p/deps" "$p/.fingerprint/octiq_flow_lib-aaa" "$p/build/octiq_flow_lib-aaa" \
      "$p/.fingerprint/octiq-flow-aaa" "$p/incremental/octiq_flow_lib-old123" \
      "$p/incremental/octiq_server-new123" "$p/incremental/octiq_job-freshdir" \
      "$p/incremental/serde-old123"
    for crate in octiq_flow_lib octiq_server octiq_notify octiq_job octiq; do
      echo stale > "$p/deps/$crate-aaa.d"
      echo stale > "$p/deps/lib$crate-aaa.rlib"
    done
    echo stale > "$p/deps/octiq_flow_lib-aaa.0.rcgu.o"
    ln "$p/deps/octiq_flow_lib-aaa.0.rcgu.o" "$p/incremental/octiq_flow_lib-old123/object.o"
    echo keep > "$p/deps/octiq_flow_lib-bbb.d"
    echo keep > "$p/deps/liboctiq_flow_lib-bbb.rlib"
    echo keep > "$p/deps/octiq_flow_lib-bbbb.d" # hash prefix must not match bbb
    echo keep > "$p/deps/serde-aaa.rlib"
    echo keep > "$p/deps/octiq_extra-aaa.d"
    echo keep > "$p/octiq-server"
    echo keep > "$p/octiq-server.d"
    echo keep > "$p/incremental/octiq_server-new123/old.o"
    echo keep > "$p/incremental/octiq_job-freshdir/old.o"
    echo keep > "$p/incremental/serde-old123/object.o"
    echo stale > "$p/.fingerprint/octiq_flow_lib-aaa/stamp"
    echo stale > "$p/.fingerprint/octiq-flow-aaa/stamp"
    echo stale > "$p/build/octiq_flow_lib-aaa/stamp"
    # A recent sidecar protects the complete hash.
    find "$p" -exec touch -t 202001010000 {} +
    touch "$p/deps/liboctiq_flow_lib-bbb.rlib" "$p/incremental/octiq_server-new123/recent.o" \
      "$p/incremental/octiq_job-freshdir"
  done
  echo keep > "$target/CACHEDIR.TAG"
  echo keep > "$target/.rustc_info.json"
}
target="$scratch/target with spaces"
fixture "$target"
# bbbb is entirely stale and should disappear, unlike bbb.
"$REPO/scripts/prune-target.sh" --dry-run "$target" > "$scratch/dry.log"
exists "$target/debug/deps/octiq_flow_lib-aaa.d"
exists "$target/debug/incremental/octiq_flow_lib-old123/object.o"
# Compare the complete tree, including content, across dry-run and skip.
cp -R "$target" "$scratch/unchanged"
"$REPO/scripts/prune-target.sh" --dry-run "$target" > /dev/null
diff -r "$scratch/unchanged" "$target"
for process in cargo rustc; do
  FAKE_RUNNING="$process" "$REPO/scripts/prune-target.sh" "$target" > "$scratch/skip.log"
  rg -q 'Skipped whole run' "$scratch/skip.log" || fail "$process did not skip"
  diff -r "$scratch/unchanged" "$target"
done
"$REPO/scripts/prune-target.sh" --days 2 "$target" > "$scratch/prune.log"
for profile in debug release release-local custom; do
  p="$target/$profile"
  for crate in octiq_flow_lib octiq_server octiq_notify octiq_job octiq; do
    gone "$p/deps/$crate-aaa.d"
    gone "$p/deps/lib$crate-aaa.rlib"
  done
  gone "$p/deps/octiq_flow_lib-aaa.0.rcgu.o"
  gone "$p/deps/octiq_flow_lib-bbbb.d"
  gone "$p/.fingerprint/octiq_flow_lib-aaa"
  gone "$p/.fingerprint/octiq-flow-aaa"
  gone "$p/build/octiq_flow_lib-aaa"
  gone "$p/incremental/octiq_flow_lib-old123"
  for kept in deps/octiq_flow_lib-bbb.d deps/liboctiq_flow_lib-bbb.rlib deps/serde-aaa.rlib \
    deps/octiq_extra-aaa.d octiq-server octiq-server.d incremental/octiq_server-new123/recent.o \
    incremental/octiq_job-freshdir/old.o incremental/serde-old123/object.o; do
    exists "$p/$kept"
  done
done
exists "$target/CACHEDIR.TAG"
exists "$target/.rustc_info.json"
# Guard stale deps when related fingerprint metadata is recent; skip symlinks.
p="$target/debug"
echo stale > "$p/deps/octiq-ccc.d"
old "$p/deps/octiq-ccc.d"
mkdir -p "$p/.fingerprint/octiq-ccc"
echo fresh > "$p/.fingerprint/octiq-ccc/stamp"
mkdir -p "$scratch/external"
echo keep > "$scratch/external/stamp"
ln -s "$scratch/external" "$p/deps/octiq-ddd.d"
ln -s "$scratch/external" "$p/incremental/octiq-redirect"
"$REPO/scripts/prune-target.sh" "$target" > /dev/null
exists "$p/deps/octiq-ccc.d"
exists "$p/deps/octiq-ddd.d"
exists "$scratch/external/stamp"
# Multiple targets and duplicate roots are accepted, bad ages are rejected.
"$REPO/scripts/prune-target.sh" --dry-run "$target" "$target" "$scratch/missing" > /dev/null
if "$REPO/scripts/prune-target.sh" --days nope "$target" >/dev/null 2>&1; then fail 'invalid days accepted'; fi
# A fresh artifact on another own target sharing a hash protects the whole hash.
echo stale > "$p/deps/octiq-eee.d"
old "$p/deps/octiq-eee.d"
echo fresh > "$p/deps/liboctiq_flow_lib-eee.rlib"
"$REPO/scripts/prune-target.sh" "$target" > /dev/null
exists "$p/deps/octiq-eee.d"
# A retained hard link means removing a stale deps object frees no file blocks.
mkdir -p "$p/incremental/octiq-linktest"
echo linked > "$p/deps/octiq-fff.d"
old "$p/deps/octiq-fff.d"
ln "$p/deps/octiq-fff.d" "$p/incremental/octiq-linktest/object.o"
"$REPO/scripts/prune-target.sh" "$target" > "$scratch/link.log"
gone "$p/deps/octiq-fff.d"
exists "$p/incremental/octiq-linktest/object.o"
rg -q 'profile=.*debug hashes=1 incremental=0 candidate_file_bytes=0 ' "$scratch/link.log" || fail 'hard links overcounted'
# Runtime worktree discovery includes sibling/leftover targets under the base.
mkdir -p "$scratch/.worktrees/octiq-flow/feature/one/src-tauri/target/debug/deps"   "$scratch/.worktrees/octiq-flow/feature/two/src-tauri/target/debug/deps"
for tree in one two; do
  echo stale > "$scratch/.worktrees/octiq-flow/feature/$tree/src-tauri/target/debug/deps/octiq-aaa.d"
  old "$scratch/.worktrees/octiq-flow/feature/$tree/src-tauri/target/debug/deps/octiq-aaa.d"
done
cat > "$scratch/bin/git" <<'STUB'
#!/usr/bin/env bash
printf 'worktree %s\n\n' "$FAKE_WORKTREE"
STUB
chmod +x "$scratch/bin/git"
FAKE_WORKTREE="$scratch/.worktrees/octiq-flow/feature/one" "$REPO/scripts/prune-target.sh" --worktrees > /dev/null
for tree in one two; do
  gone "$scratch/.worktrees/octiq-flow/feature/$tree/src-tauri/target/debug/deps/octiq-aaa.d"
done
# Reproduced ancestor escapes must log SKIPPED and preserve external stale
# artifacts under BOTH dry-run and real scratch pruning.
external="$scratch/outside/src-tauri/target"
mkdir -p "$external/debug/deps"
echo sentinel > "$external/debug/deps/octiq-abc.d"
old "$external/debug/deps/octiq-abc.d"
ln -s "$external" "$scratch/target-link"
mkdir -p "$scratch/ancestor-repo"
ln -s "$scratch/outside/src-tauri" "$scratch/ancestor-repo/src-tauri"
ln -s "$scratch/outside" "$scratch/.worktrees/octiq-flow/feature/redirect"
assert_skipped() {
  local label="$1"; shift
  "$REPO/scripts/prune-target.sh" "$@" > "$scratch/escape.log"
  rg -q 'SKIPPED' "$scratch/escape.log" || fail "$label did not report SKIPPED"
  exists "$external/debug/deps/octiq-abc.d"
  [[ "$(cat "$external/debug/deps/octiq-abc.d")" == sentinel ]] || fail "$label changed sentinel"
}
for mode in dry real; do
  flags=()
  [[ "$mode" == real ]] || flags+=(--dry-run)
  assert_skipped "trailing slash $mode" ${flags[@]+"${flags[@]}"} "$scratch/target-link/"
  assert_skipped "src-tauri ancestor $mode" ${flags[@]+"${flags[@]}"} "$scratch/ancestor-repo/src-tauri/target"
  FAKE_WORKTREE="$scratch/.worktrees/octiq-flow/feature/one" \
    assert_skipped "sibling symlink $mode" ${flags[@]+"${flags[@]}"} --worktrees
  FAKE_WORKTREE="$scratch/.worktrees/octiq-flow/feature/redirect" \
    assert_skipped "listed symlink $mode" ${flags[@]+"${flags[@]}"} --worktrees
  # Profile and each cache container must also refuse redirects, including
  # metadata containers that previously were silently ignored.
  for area in debug debug/deps debug/incremental debug/.fingerprint debug/build; do
    guarded="$scratch/guarded-target"
    rm -rf "$guarded"
    mkdir -p "$guarded/debug/deps"
    echo local > "$guarded/debug/deps/octiq-abc.d"
    old "$guarded/debug/deps/octiq-abc.d"
    if [[ "$area" == debug ]]; then
      rm -rf "$guarded/debug"
      ln -s "$external/debug" "$guarded/debug"
    else
      rm -rf "$guarded/$area"
      ln -s "$external/debug/deps" "$guarded/$area"
    fi
    assert_skipped "$area symlink $mode" ${flags[@]+"${flags[@]}"} "$guarded"
    exists "$guarded/debug/deps/octiq-abc.d"
  done
done
echo 'PASS: trailing-slash target, src-tauri ancestor, sibling/listed worktree and profile/cache symlinks SKIPPED in dry-run and real scratch prune; external sentinels preserved.'
# Validate generated launchd config in an isolated HOME with launchctl stubbed.
cat > "$scratch/bin/launchctl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LAUNCH_LOG"
STUB
chmod +x "$scratch/bin/launchctl"
FAKE_LAUNCH_LOG="$scratch/launch.log" HOME="$scratch/home" "$REPO/scripts/install-prune-agent.sh" > /dev/null
plist="$scratch/home/Library/LaunchAgents/com.kyson.octiqflow.prune-target.plist"
plutil -lint "$plist"
rg -q '<key>RunAtLoad</key><false/>' "$plist" || fail 'RunAtLoad'
rg -q '<key>Hour</key><integer>4</integer>' "$plist" || fail 'schedule hour'
rg -q '<key>Minute</key><integer>30</integer>' "$plist" || fail 'schedule minute'
rg -q -- '--worktrees' "$plist" || fail 'runtime worktree discovery'
FAKE_LAUNCH_LOG="$scratch/launch.log" HOME="$scratch/home" "$REPO/scripts/install-prune-agent.sh" --uninstall > /dev/null
gone "$plist"
cat "$scratch/prune.log"
echo 'PASS: 4 profiles; stale own hashes/incremental pruned; fresh/third-party/top-level/symlinks preserved; dry-run, cargo/rustc guards, hard-link accounting, worktree discovery and mocked installer/uninstall verified.'
