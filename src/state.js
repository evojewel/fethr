// fethr's own small state files in ~/.fethr (FETHR_STATE_DIR overrides it,
// for the tests): recent.json (sessions.js) and prefs.json (prefs.js).
//
// Writes go to a temp file that is renamed into place, so a reader never sees
// half a file. Each caller reads, merges and writes back to back; that is
// last-writer-wins with a window of milliseconds, not an atomic merge, which
// is enough for convenience state that the next write repairs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Read at call time, not import time, so tests can point it elsewhere.
export function stateDir() {
  return process.env.FETHR_STATE_DIR || path.join(os.homedir(), ".fethr");
}

export function stateFile(name) {
  return path.join(stateDir(), name);
}

// The parsed file, or `fallback` when it is missing or not valid JSON.
export function readState(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(name), "utf8"));
  } catch {
    return fallback;
  }
}

// Throws on failure; callers decide whether that matters.
export function writeState(name, value) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const file = stateFile(name);
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
