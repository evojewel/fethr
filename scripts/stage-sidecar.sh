#!/usr/bin/env bash
# Stages a minimal, self-contained copy of the server+agent (bin/, src/,
# and ONLY their runtime deps — none of the frontend/dev packages like
# esbuild, puppeteer, or the Tauri CLI itself) into src-tauri/sidecar/,
# which tauri.conf.json's bundle.resources ships inside the .app.
#
# Run before `tauri build` (wired into beforeBuildCommand). Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

DEST=src-tauri/sidecar
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R bin "$DEST/"
cp -R src "$DEST/"
cp -R dist "$DEST/"   # server.js resolves index.html/editor.js relative to itself: ../dist

node -e '
const pkg = require("./package.json");
const runtime = ["@anthropic-ai/claude-agent-sdk", "zod"];
const deps = {};
for (const name of runtime) deps[name] = pkg.dependencies[name];
require("fs").writeFileSync(
  "'"$DEST"'/package.json",
  JSON.stringify({ name: "fethr-sidecar", private: true, type: "module", dependencies: deps }, null, 2)
);
'

npm install --omit=dev --no-audit --no-fund --prefix "$DEST"
echo "staged sidecar: $(du -sh "$DEST" | cut -f1)"
