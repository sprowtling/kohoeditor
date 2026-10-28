#!/bin/sh
# Cross-checks our writer against Mojang's own LevelDB.
# Needs: python3 -m pip install amulet-leveldb
# Usage: tests/oracle/check.sh [world dir]   (defaults to the test fixture)
set -e
here=$(cd "$(dirname "$0")" && pwd)
world=${1:-$here/../fixtures/world}
tmp=$(mktemp -d)
node "$here/apply-edits.mjs" "$world" "$tmp/world" "$tmp/expected.json"
python3 "$here/verify.py" "$tmp/world/db" "$tmp/expected.json"
rm -rf "$tmp"
