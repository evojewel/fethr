// The PATH a GUI-launched app gets, and the one the user actually has.
//
// An app opened from Finder or the Dock inherits launchd's PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), not the one the user's shell builds. The
// sidecar passes that on to the agent, so its shell commands could not find
// npm, an nvm node or Homebrew tools, and MCP servers started with `node` or
// `npx` failed to launch.
//
// The fix is the one VS Code uses: ask the login shell once, in the
// background, with a hard timeout. An earlier attempt here (see ARCHITECTURE,
// "The sidecar") ran the shell with no timeout and could hang on a slow or
// interactive profile with no error; the timeout and the fallback dirs are
// what make it safe now. Output is read between markers, because a profile
// may print its own text first.

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const SHELL_TIMEOUT_MS = 4000;
const MARK = "__FETHR_PATH__";

// Where command-line tools usually live when the shell can't be asked.
export function fallbackDirs(home = os.homedir(), execPath = process.execPath) {
  return [
    "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
    path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin"),
    path.join(home, ".volta", "bin"), path.join(home, ".bun", "bin"),
    path.dirname(execPath), // the node running fethr, and its npm beside it
  ];
}

// Joins PATH lists in order, keeping the first copy of each entry.
export function mergePath(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const dir of list || []) {
      if (dir && !seen.has(dir)) { seen.add(dir); out.push(dir); }
    }
  }
  return out.join(":");
}

export function parseShellOutput(stdout) {
  const m = new RegExp(`${MARK}(.*?)${MARK}`, "s").exec(String(stdout || ""));
  const p = m && m[1].trim();
  return p && p.includes("/") ? p : null;
}

// Resolves to the login shell's PATH, or null on a timeout, an error or
// output without the markers. Never rejects.
export function readLoginPath({ shell = process.env.SHELL || "/bin/zsh", timeoutMs = SHELL_TIMEOUT_MS, execFileFn = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      execFileFn(
        shell,
        ["-ilc", `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`],
        { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, env: { ...process.env, FETHR_RESOLVING_SHELL_ENV: "1" } },
        (_err, stdout) => resolve(parseShellOutput(stdout)) // a timeout or error leaves no markers: null
      );
    } catch {
      resolve(null);
    }
  });
}

// Gives env.PATH the login shell's entries first, then the fallback dirs,
// then whatever was already there. Windows GUI apps already inherit the
// user's PATH, so nothing changes there. Resolves to { source, entries }.
export async function fixPath(env = process.env, { platform = process.platform, read = readLoginPath, home, execPath } = {}) {
  if (platform === "win32") return { source: "unchanged", entries: 0 };
  const current = (env.PATH || "").split(":");
  const login = await read();
  env.PATH = mergePath(login ? login.split(":") : [], fallbackDirs(home, execPath), current);
  return { source: login ? "login-shell" : "fallback", entries: env.PATH.split(":").length };
}
