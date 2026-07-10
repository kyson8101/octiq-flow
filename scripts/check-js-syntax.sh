#!/bin/sh
# Parse every frontend module as an ES module. The web UI has no test runner and
# no bundler, so a syntax error would otherwise only surface in the running app.
set -e
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0
for f in src/*.js; do
  cp "$f" "$tmp/$(basename "$f" .js).mjs"
  node --check "$tmp/$(basename "$f" .js).mjs" || { echo "SYNTAX FAIL: $f"; fail=1; }
done
[ $fail -eq 0 ] && echo "OK: all src/*.js parse as ES modules"
exit $fail
