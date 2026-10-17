#!/usr/bin/env node

// fethr — a featherweight code editor with first-class agent integration.

import { createRequire } from "node:module";
import fs from "node:fs";

const { version } = createRequire(import.meta.url)("../package.json");

const USAGE = `
  fethr ${version} — a featherweight code editor

  USAGE
    fethr [dir]                          open dir (default: current directory) in the editor
    fethr --home                         open the home page: recent folders and Claude sessions
    fethr <dir> --session <id> [--fork]  open dir and resume (or fork) that Claude session
    fethr --version

  https://fethr.dev · https://github.com/evojewel/fethr
`;

const SESSION_ID_RE = /^[0-9a-f-]{36}$/;

// Read before parsing, so even a parse failure knows who is listening.
const SIDECAR = process.argv.includes("--sidecar");

// Every exit before the server starts goes through here. A person at a
// terminal reads stderr; the native shell reads only stdout, where it used to
// see nothing at all and the window just never appeared. So in sidecar mode
// the reason is also one FETHR_ERROR=<message> line there, newlines folded so
// it stays one line. fs.writeSync, not console.log: stdout to a pipe is
// asynchronous on macOS, and process.exit right after could drop the line.
function fail(message, usage = false) {
  if (SIDECAR) fs.writeSync(1, `FETHR_ERROR=${String(message).replace(/[\r\n]+/g, " ")}\n`);
  console.error(`fethr: ${message}${usage ? "\n" + USAGE : ""}`);
  process.exit(2);
}

// Explicit parsing: --session takes a value, so "the first argument that is
// not a flag is the dir" no longer holds. Unknown flags are an error rather
// than silently ignored, since a typo'd --sesion would otherwise open the
// folder without the session and look like it worked.
function parseArgs(argv) {
  const o = { home: false, session: null, fork: false, sidecar: false, app: false, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home") o.home = true;
    else if (a === "--fork") o.fork = true;
    else if (a === "--sidecar") o.sidecar = true;
    else if (a === "--app") o.app = true;
    else if (a === "--session") {
      const v = argv[++i];
      if (!v || !SESSION_ID_RE.test(v)) return { error: "--session needs a session id" };
      o.session = v;
    } else if (a.startsWith("--")) return { error: `unknown option ${a}` };
    else if (o.dir === null) o.dir = a;
    else return { error: `unexpected argument ${a}` };
  }
  if (o.fork && !o.session) return { error: "--fork needs --session" };
  if (o.home && (o.dir !== null || o.session)) return { error: "--home takes no folder or session" };
  return o;
}

const arg = process.argv[2];

if (arg === "--version" || arg === "-v") {
  console.log(`fethr ${version}`);
} else if (arg === "--help" || arg === "-h") {
  console.log(USAGE);
} else {
  const o = parseArgs(process.argv.slice(2));
  if (o.error) fail(o.error, true);
  const { serve } = await import("../src/server.js");
  const root = o.home ? null : o.dir || process.cwd();
  if (o.session) {
    // The SDK resumes with cwd = root, so a session opened in any other folder
    // gives the agent the wrong workspace. The home page always sends the
    // recorded folder; this catches a hand-typed `fethr <dir> --session <id>`.
    const { getSession } = await import("../src/sessions.js");
    const s = getSession(o.session);
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    if (!s) fail(`no Claude session ${o.session} on this machine`);
    if (!s.cwd || real(s.cwd) !== real(root)) {
      fail(`session ${o.session} was recorded in ${s.cwd || "an unknown folder"}; open that folder instead`);
    }
  }
  const opts = {
    app: o.app,
    sidecar: o.sidecar,
    home: o.home,
    ...(o.session ? { session: { id: o.session, fork: o.fork } } : {}),
  };
  if (o.sidecar) {
    // Spawned by the native app shell (src-tauri) as a child process. No
    // banner, no browser-opening — just start the server and print a single
    // machine-parseable line so the Rust side can read the bound port.
    // Opening something from this window is the shell's job too: each request
    // becomes one FETHR_OPEN=<json> line it reads from the same stdout.
    // JSON.stringify escapes newlines, so a path can never split the line.
    // The page's answer: a folder, session or home opens as soon as the shell
    // reads the line, so "ok". A pick opens a native dialog first, which may
    // yet be cancelled, so it is only "pending" and the page stays quiet.
    opts.onOpen = (target) => {
      console.log(`FETHR_OPEN=${JSON.stringify(target)}`);
      return target.pick ? { pending: true } : { ok: true };
    };
    serve(root, (url) => console.log(`FETHR_URL=${url}`), opts);
  } else {
    serve(root, undefined, opts);
  }
}
