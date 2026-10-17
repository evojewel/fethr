// Where the system's Claude Code binary is. Shared by the agent panel
// (agent.js, which hands it to the Agent SDK) and the session list
// (sessions.js, which runs `claude agents --json`); kept apart from agent.js
// so finding the binary does not load the SDK.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cachedClaudePath; // computed once per process, not once per request
export function findClaudeExecutable() {
  if (cachedClaudePath !== undefined) return cachedClaudePath;
  const home = os.homedir();
  const win = process.platform === "win32";
  // PATH first on Windows (a GUI app inherits the real one there), last on
  // macOS (where a GUI app gets launchd's bare PATH and the fixed homes are
  // the reliable answer).
  const onPath = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((d) => path.join(d, win ? "claude.exe" : "claude"));
  const candidates = win
    ? [
        ...onPath,
        path.join(home, ".local", "bin", "claude.exe"),
        path.join(home, ".claude", "local", "claude.exe"),
        // An npm-global install is a .cmd shim around this file; the SDK runs a
        // .js path with node, which a .cmd cannot be handed to it as.
        path.join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
      ]
    : [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        path.join(home, ".claude/local/claude"),
        path.join(home, ".local/bin/claude"),
        ...onPath,
      ];
  cachedClaudePath = candidates.find((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });
  return cachedClaudePath;
}
