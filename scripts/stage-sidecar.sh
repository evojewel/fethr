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

npm install --omit=dev --omit=optional --no-audit --no-fund --prefix "$DEST"
echo "staged sidecar: $(du -sh "$DEST" | cut -f1)"

# --omit=optional skips claude-agent-sdk's platform package (the bundled
# claude binary, ~310MB) — fethr's whole premise is that the user already
# has Claude Code installed, and src/agent.js points the SDK at that
# system install via pathToClaudeCodeExecutable. Fail loudly if it's
# somehow back, since that would silently balloon the app by 8x.
if [ -d "$DEST/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64" ] || \
   [ -d "$DEST/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64" ]; then
  echo "stage-sidecar.sh: the bundled claude binary is present despite --omit=optional" >&2
  echo "  (npm version too old for --omit, or the SDK changed how it declares this dep)" >&2
  exit 1
fi
