// fethr local server — serves the editor UI and a minimal file API.
// Binds to 127.0.0.1 only. All file access is confined to the root the
// user launched with; paths that escape it are rejected.
//
// Two modes. Editor: a folder is open (root). Home: no folder (root is null),
// the page lists recent folders and Claude Code sessions, and every file API
// answers 400. Opening something from home never changes this server's root:
// it asks for a new window with its own server (see /api/open).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import {
  listSessions, getSession, sessionHistory, isSessionId, recentFolders, upsertRecent, openSessions,
  attachInTerminal, stopBackgroundSession, listSubagents, AGENT_ID_RE, latestContinuation, setRecentHidden,
} from "./sessions.js";
import { readPrefs, mergePrefs, MAX_PREFS_BODY } from "./prefs.js";
import { fixPath } from "./shell-env.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");
const BIN = path.join(HERE, "..", "bin", "fethr.js");
const MAX_OPEN_BODY = 64 * 1024;
// Endpoints that only make sense with a folder open.
const NEEDS_ROOT = new Set(["/api/file", "/api/tree", "/api/chat", "/api/agent", "/api/agent/permission", "/api/recent"]);
// /api/recent is called as soon as the agent reports its session id; Claude
// Code may not have created the transcript yet, so wait this long for it.
// FETHR_RECENT_WAIT_MS exists for the tests.
const RECENT_WAIT_MS = () => Number(process.env.FETHR_RECENT_WAIT_MS) || 5_000;
const RECENT_POLL_MS = 250;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", "__pycache__", "env", "venv"]);
// "target": opening fethr on its own repo put ~15k Rust build files from
// src-tauri/target in the sidebar and froze the tree render.
const MAX_TREE_ENTRIES = 5000;

// A token per launch. Before this, any page open in the same browser could
// call 127.0.0.1:<port>/api/* — read the workspace, write files, run the
// agent — because the only "secret" was a port number. The token rides in
// the URL fragment, which browsers never send to a server (so it is not in
// any log) but the page can read; every /api request must carry it in the
// x-fethr-token header. The page and the bundle stay open: they hold nothing.
const TOKEN = crypto.randomBytes(24).toString("base64url");
const TOKEN_HEADER = "x-fethr-token";

function tokenMatches(given) {
  if (typeof given !== "string" || given.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
}
const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;

// The page is same-origin with everything it needs. connect-src also allows
// fethr.dev for the once-a-day version check (web/update.js) and nothing else,
// so a prompt-injected script has nowhere to send anything even if the
// textContent discipline in the proposal renderer ever slips.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://fethr.dev; base-uri 'none'; form-action 'none'; object-src 'none'";

// fethr never explicitly told the agent the branch, but it answered a
// branch question anyway — turns out the Claude Code harness itself
// captures a git-status snapshot at session start, independent of anything
// fethr sends. That's real, but it's a snapshot: it goes stale if the
// branch changes mid-conversation (session resume, checkout in another
// window). Giving the agent a freshly-checked branch on every request is
// strictly better — same "separate verified fact from inference" principle
// the rest of this project already follows for its own outputs.
function getGitBranch(root) {
  try {
    // stdio[2]: discard stderr — git's "fatal: not a git repository" on
    // every non-git workspace (test fixtures, scratch folders) is the
    // normal, expected case here, not something to surface as noise.
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null; // not a git repo, git not installed, detached HEAD w/ no name, etc.
  }
}

function safeJoin(root, rel) {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) return null;

  // path.resolve is purely lexical — a symlink *inside* root whose target
  // points outside root passes the check above while actually reading/
  // writing outside the workspace. Resolve symlinks and re-check the real
  // location (mirrors safe_join's use of .canonicalize() on the Rust side
  // in src-tauri/src/lib.rs — the two implementations had drifted).
  let real;
  try {
    real = fs.realpathSync(p);
  } catch {
    // Doesn't exist yet (e.g. saving a new file) — validate the nearest
    // existing ancestor instead.
    try {
      real = path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return null;
    }
  }
  const realRoot = fs.realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  return p;
}

function listTree(root) {
  const out = [];
  const walk = (dir, rel) => {
    if (out.length >= MAX_TREE_ENTRIES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) =>
      a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1
    );
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        out.push({ path: r, dir: true });
        walk(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        out.push({ path: r, dir: false });
      }
    }
  };
  walk(root, "");
  return out;
}

function send(res, code, body, type = "application/json", extra = {}) {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...extra });
  res.end(body);
}

const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj));

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

// An internal result is either an answer for the page or { status, error }.
function reply(res, out) {
  if (out.status) return sendJson(res, out.status, { error: out.error });
  sendJson(res, 200, out);
}

const SESSION_ACTIONS = new Set(["attach", "stop-and-resume"]);

// The agent can Read/Grep/Glob anything under its root. The native shell
// refuses to fall back to $HOME for exactly that reason (src-tauri/src/lib.rs),
// but a session recorded in the home folder would hand the agent the whole of
// it — SSH key folders, every other project — through a single click. So the
// home folder, its parent and the filesystem root need an explicit second yes
// from the page. A folder the user picks in the native dialog or passes on the
// command line is already that explicit choice and doesn't come through here.
function isBroadFolder(dir) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const d = real(dir);
  const home = real(os.homedir());
  return d === home || d === path.dirname(home) || d === path.parse(d).root;
}

// Turn an /api/open request into a target, deciding everything that matters
// here rather than trusting the page: a session opens in the folder its
// transcript was recorded in (the SDK resumes with cwd = root, and Claude Code
// files sessions by folder), so the page sends only the id. Resolves to
// { target } or { status, error, ... }.
async function resolveOpen(body) {
  const out = await resolveTarget(body);
  if (out.target && out.target.root && body.confirmBroad !== true && isBroadFolder(out.target.root)) {
    return {
      status: 428,
      error: `this opens ${out.target.root}, so the agent could read everything in it`,
      broad: true,
      folder: out.target.root,
    };
  }
  return out;
}

async function resolveTarget(body) {
  if (!body || typeof body !== "object") return { status: 400, error: "bad request" };
  if (body.session !== undefined) {
    if (!isSessionId(body.session)) return { status: 400, error: "bad session id" };
    const asked = getSession(body.session);
    if (!asked) return { status: 404, error: "unknown session" };
    // Resuming a session Claude Code has since continued under a new id
    // resumes the new one (it holds the conversation from then on). The
    // checks below then apply to that successor. A fork of the old one is
    // left as asked: it branches from exactly that transcript.
    const s = body.fork === true ? asked : getSession(latestContinuation(asked.id)) || asked;
    if (!s.cwd || !s.cwdExists) return { status: 409, error: "the session's folder no longer exists", cwd: s.cwd };
    const fork = body.fork === true;
    if (!fork) {
      // Resuming a session Claude Code is running in the background fails
      // inside the agent, after a window has opened. Ask now, with a fresh
      // list: the home page's copy can be seconds old. Unknown (no claude,
      // an older one) lets the resume through, as before this check.
      const open = await openSessions({ fresh: true });
      const o = open && open.get(s.id);
      if (o && o.kind === "background") {
        return { status: 409, error: "running in the background", hint: `claude attach ${s.id.slice(0, 8)}` };
      }
    }
    return { target: { root: s.cwd, session: s.id, fork } };
  }
  if (body.root !== undefined) {
    if (typeof body.root !== "string" || !path.isAbsolute(body.root)) return { status: 400, error: "root must be an absolute path" };
    const root = path.resolve(body.root);
    let st;
    try { st = fs.statSync(root); } catch { /* handled below */ }
    if (!st || !st.isDirectory()) return { status: 400, error: "not an existing folder" };
    return { target: { root } };
  }
  if (body.pick === true) return { target: { pick: true } };
  if (body.home === true) return { target: { home: true } };
  return { status: 400, error: "nothing to open" };
}

// The fethr arguments that open a target, as a person would type them.
export function argsFor(target, app = false) {
  const args = target.home
    ? ["--home"]
    : [target.root, ...(target.session ? ["--session", target.session] : []), ...(target.fork ? ["--fork"] : [])];
  return app ? [...args, "--app"] : args;
}

// CLI mode's way to open a target: a new, detached fethr process, which binds
// its own port, mints its own token and opens its own tab, exactly as if the
// user had typed the command. Detached and unref'd so closing this tab (and
// the reaper ending this server) does not take the new one with it.
// windowsHide: without it Windows flashes a console window for the child.
function launchSelf(args, spawnFn) {
  const child = spawnFn(process.execPath, [BIN, ...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {}); // reported to nobody; the page already got its answer
  child.unref();
}

// macOS has a folder picker reachable without a GUI toolkit; nothing
// comparable ships with every Linux or Windows install, so there the page
// falls back to a path box (501). Exit code 1 with -128 is the user pressing
// Cancel, which is an answer, not an error.
function pickFolder() {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") return resolve({ status: 501, error: "no folder picker on this platform" });
    execFile("osascript", ["-e", "POSIX path of (choose folder)"], (err, stdout, stderr) => {
      if (err) {
        return resolve(/-128/.test(String(stderr)) ? { cancelled: true } : { status: 500, error: "folder picker failed" });
      }
      const picked = stdout.trim();
      // "POSIX path of" ends a folder with "/"; keep "/" itself intact.
      resolve({ root: picked.length > 1 ? picked.replace(/\/+$/, "") : picked });
    });
  });
}

// spawnFn and pick are parameters so the tests can see what would be
// launched without launching it.
export function defaultOnOpen(app, { spawnFn = spawn, pick = pickFolder } = {}) {
  return async (target) => {
    if (target.pick) {
      const r = await pick();
      if (!r.root) return r;
      launchSelf(argsFor({ root: r.root }, app), spawnFn);
      return { ok: true };
    }
    launchSelf(argsFor(target, app), spawnFn);
    return { ok: true };
  };
}

// A body over the limit resolves to TOO_LARGE once the rest has been read
// and dropped, so the handler can still answer (413) instead of the socket
// being cut. Anything that is not JSON resolves to undefined.
const TOO_LARGE = Symbol("too large");
function readJsonBody(req, max) {
  return new Promise((resolve) => {
    let body = "";
    let over = false;
    req.setEncoding("utf8");
    req.on("data", (c) => {
      if (over) return;
      body += c;
      if (body.length > max) { over = true; body = ""; }
    });
    req.on("end", () => {
      if (over) return resolve(TOO_LARGE);
      try { resolve(JSON.parse(body)); } catch { resolve(undefined); }
    });
  });
}

let pathReady = null; // once per process: the sidecar's PATH fix (see serve)

export function serve(root, onReady, opts = {}) {
  const home = !!opts.home;
  root = home ? null : path.resolve(root);
  if (opts.session && !isSessionId(opts.session.id)) throw new Error("bad session id");
  const onOpen = opts.onOpen || defaultOnOpen(!!opts.app);
  let lastPing = null;
  // A resume is remembered with its session, so the home list can name the
  // chat. A fork's new id is not known until the agent starts; the page
  // reports it through /api/recent.
  if (root) upsertRecent(root, opts.session && !opts.session.fork ? { session: opts.session.id } : {});

  // CLI mode: exit when the editor tab has been gone for a while (only once
  // it has pinged at least once, so headless/API use is unaffected).
  //
  // Not in sidecar mode. The native window keeps the page alive but macOS
  // throttles its timers and naps the app while it is in the background, so
  // the heartbeat starves and this reaper killed the server under a window
  // that was still open — every later click said "could not open". The Rust
  // side kills the child on window close (src-tauri/src/lib.rs), which is
  // the right signal there. FETHR_IDLE_MS exists for the test.
  // Sidecar mode: the app kills this child on window close, but not on a
  // force-quit or a crash — then launchd adopts the child and it would serve
  // forever. So the sidecar watches its parent: the moment the parent pid
  // changes (re-parenting to 1), it exits.
  // A GUI-launched app has launchd's bare PATH; give the agent the user's
  // (src/shell-env.js). Started now, in the background: only the first agent
  // request waits for it, and for at most its timeout. The CLI was started
  // from a shell and already has the right PATH.
  if (opts.sidecar && !pathReady) pathReady = fixPath(process.env).catch(() => null);

  if (opts.sidecar) {
    const parent = process.ppid;
    // Unix re-parents an orphan, so ppid changes. Windows never does: ppid
    // keeps naming the dead process. Asking whether the parent still exists
    // covers both (signal 0 sends nothing; ESRCH means it is gone).
    const parentGone = () => {
      if (process.ppid !== parent) return true;
      try { process.kill(parent, 0); return false; } catch (e) { return e.code === "ESRCH"; }
    };
    const orphanWatch = setInterval(() => {
      if (parentGone()) process.exit(0);
    }, Number(process.env.FETHR_IDLE_MS) || 2_000);
    orphanWatch.unref();
  }
  if (!opts.sidecar) {
    const idleMs = Number(process.env.FETHR_IDLE_MS) || 30_000;
    const reaper = setInterval(() => {
      if (lastPing && Date.now() - lastPing > idleMs) process.exit(0);
    }, Math.min(5_000, idleMs));
    reaper.unref();
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");

    if (u.pathname.startsWith("/api/")) {
      // A browser sends Origin on cross-origin fetches; a page on another
      // origin is refused before the token is even looked at.
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${server.address().port}`) {
        return send(res, 403, JSON.stringify({ error: "wrong origin" }));
      }
      if (!tokenMatches(req.headers[TOKEN_HEADER])) {
        return send(res, 401, JSON.stringify({ error: "missing or wrong token" }));
      }
      if (!root && NEEDS_ROOT.has(u.pathname)) return sendJson(res, 400, { error: "no folder open" });
    }

    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      return send(res, 200, fs.readFileSync(path.join(DIST, "index.html")), "text/html; charset=utf-8", { "content-security-policy": CSP });
    }
    if (req.method === "GET" && u.pathname === "/editor.js") {
      return send(res, 200, fs.readFileSync(path.join(DIST, "editor.js")), "text/javascript; charset=utf-8");
    }
    if (req.method === "GET" && u.pathname === "/api/meta") {
      // channel: which release train this instance came from, so the update
      // check compares against the right number — the DMG and the npm tag
      // do not move together.
      const channel = opts.sidecar ? "app" : "npm";
      if (!root) return sendJson(res, 200, { mode: "home", version: VERSION, channel });
      const meta = {
        // realRoot: tools may report /private/var/… for a root opened as /var/…
        mode: "editor", root, realRoot: (() => { try { return fs.realpathSync(root); } catch { return root; } })(),
        name: path.basename(root), gitBranch: getGitBranch(root),
        version: VERSION, channel,
      };
      if (opts.session) {
        const s = getSession(opts.session.id);
        meta.resume = { id: opts.session.id, fork: !!opts.session.fork, title: s ? s.title : null, source: s ? s.source : null };
      }
      return sendJson(res, 200, meta);
    }
    if (req.method === "GET" && u.pathname === "/api/home") {
      // openSessions never rejects; null (unknown) leaves every open: null.
      openSessions().then((open) => {
        sendJson(res, 200, {
          recentFolders: recentFolders({ open }),
          recentHidden: recentFolders({ open, hidden: true }),
          sessions: listSessions({ open }),
        });
      });
      return;
    }
    if (u.pathname === "/api/prefs") {
      // Preferences that outlive the launch (see prefs.js). Both modes.
      if (req.method === "GET") return sendJson(res, 200, readPrefs());
      if (req.method === "PUT") {
        readJsonBody(req, MAX_PREFS_BODY).then((body) => {
          if (body === TOO_LARGE) return sendJson(res, 413, { error: "prefs body too large" });
          const r = mergePrefs(body);
          if (r.status) return sendJson(res, r.status, { error: r.error });
          sendJson(res, 200, r.prefs);
        });
        return;
      }
    }
    if (req.method === "POST" && (u.pathname === "/api/recent/hide" || u.pathname === "/api/recent/unhide")) {
      // Take an entry off the Recent list, or put it back. Only fethr's own
      // list changes; no folder or session is touched. Both modes.
      readJsonBody(req, MAX_OPEN_BODY).then((body) => {
        if (!body || typeof body !== "object" || typeof body.path !== "string" || !body.path) {
          return sendJson(res, 400, { error: "bad request" });
        }
        const session = body.session ?? null;
        if (session !== null && !isSessionId(session)) return sendJson(res, 400, { error: "bad session id" });
        reply(res, setRecentHidden(body.path, session, u.pathname.endsWith("/hide")));
      });
      return;
    }
    if (req.method === "POST" && u.pathname === "/api/recent") {
      // The page reports the agent's session id once it is known (a fork, or
      // a plain folder's first chat), so this folder's recent entry can carry
      // the chat's name. Only a session recorded in this very folder.
      readJsonBody(req, MAX_OPEN_BODY).then(async (body) => {
        const id = body && body.session;
        if (!isSessionId(id)) return sendJson(res, 400, { error: "bad session id" });
        let s = getSession(id);
        for (const until = Date.now() + RECENT_WAIT_MS(); !s && Date.now() < until;) {
          await new Promise((r) => setTimeout(r, RECENT_POLL_MS));
          s = getSession(id);
        }
        if (!s) return sendJson(res, 404, { error: "unknown session" });
        if (!s.cwd || realOr(s.cwd) !== realOr(root)) return sendJson(res, 409, { error: "that session belongs to another folder" });
        upsertRecent(root, { session: id, dropPlain: true });
        sendJson(res, 200, { ok: true });
      }).catch((e) => sendJson(res, 500, { error: String(e.message || e) }));
      return;
    }
    if (req.method === "GET" && u.pathname === "/api/subagents") {
      const id = u.searchParams.get("id");
      if (!isSessionId(id)) return sendJson(res, 400, { error: "bad session id" });
      openSessions().then((open) => {
        try {
          const list = listSubagents(id, { open });
          return list ? sendJson(res, 200, list) : sendJson(res, 404, { error: "unknown session" });
        } catch {
          return sendJson(res, 500, { error: "could not read subagents" });
        }
      });
      return;
    }
    if (req.method === "GET" && u.pathname === "/api/session-history") {
      const id = u.searchParams.get("id");
      if (!isSessionId(id)) return sendJson(res, 400, { error: "bad session id" });
      // Optional: one of its subagents' transcripts instead.
      const agentId = u.searchParams.get("agent");
      if (agentId !== null && !AGENT_ID_RE.test(agentId)) return sendJson(res, 400, { error: "bad agent id" });
      try {
        const h = sessionHistory(id, { agentId });
        return h ? sendJson(res, 200, h) : sendJson(res, 404, { error: "unknown session" });
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.status ? e.message : "could not read session" });
      }
    }
    // Resolve, then hand the target to onOpen; shared by /api/open and the
    // stop-and-resume action, so both open a session the same way.
    const openResolved = async (body) => {
      const r = await resolveOpen(body);
      if (!r.target) {
        const { status, ...rest } = r;
        return sendJson(res, status, rest);
      }
      let out;
      try {
        out = (await onOpen(r.target)) || { ok: true };
      } catch (e) {
        out = { status: 500, error: String(e.message || e) };
      }
      reply(res, out);
    };
    if (req.method === "POST" && u.pathname === "/api/open") {
      readJsonBody(req, MAX_OPEN_BODY)
        .then(openResolved)
        .catch((e) => sendJson(res, 500, { error: String(e.message || e) }));
      return;
    }
    if (req.method === "POST" && u.pathname === "/api/session-action") {
      // The other two answers to "running in the background" (Fork is the
      // third, via /api/open). Only for a session that a fresh
      // `claude agents` says is running in the background right now.
      readJsonBody(req, MAX_OPEN_BODY).then(async (body) => {
        const id = body && body.id;
        if (!isSessionId(id) || !SESSION_ACTIONS.has(body.action)) return sendJson(res, 400, { error: "bad request" });
        const open = await openSessions({ fresh: true });
        const o = open && open.get(id);
        if (!o || o.kind !== "background") return sendJson(res, 409, { error: "not running in the background" });
        if (body.action === "attach") return reply(res, await attachInTerminal(id));
        // Ask about a home-sized folder before stopping anything: a 428 after
        // the stop would leave the session stopped and not reopened.
        const s = getSession(id);
        if (s && s.cwd && body.confirmBroad !== true && isBroadFolder(s.cwd)) {
          return sendJson(res, 428, {
            error: `this opens ${s.cwd}, so the agent could read everything in it`,
            broad: true,
            folder: s.cwd,
          });
        }
        const stopped = await stopBackgroundSession(id);
        if (stopped.status) return reply(res, stopped);
        await openResolved({ session: id, confirmBroad: body.confirmBroad === true });
      }).catch((e) => sendJson(res, 500, { error: String(e.message || e) }));
      return;
    }
    if (u.pathname === "/api/chat") {
      // Conversation history lives with the project, not the browser — a
      // plain file at .fethr/chat.json, so it survives across launches
      // regardless of the server's (random) port/origin, and it's just a
      // file the user can see, back up, or delete like anything else.
      const chatFile = path.join(root, ".fethr", "chat.json");
      if (req.method === "GET") {
        try {
          return send(res, 200, fs.readFileSync(chatFile, "utf8"));
        } catch {
          return send(res, 200, "null");
        }
      }
      if (req.method === "PUT") {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (c) => {
          body += c;
          if (body.length > 5 * MAX_FILE_BYTES) req.destroy();
        });
        req.on("end", () => {
          try {
            fs.mkdirSync(path.dirname(chatFile), { recursive: true });
            fs.writeFileSync(chatFile, body, "utf8");
            send(res, 200, "{}");
          } catch (e) {
            send(res, 500, JSON.stringify({ error: String(e.message || e) }));
          }
        });
        return;
      }
    }
    if (req.method === "GET" && u.pathname === "/api/tree") {
      return send(res, 200, JSON.stringify(listTree(root)));
    }
    if (req.method === "POST" && u.pathname === "/api/agent/permission") {
      // The panel's answer to a permission question from a full-mode run.
      readJsonBody(req, MAX_OPEN_BODY).then(async (body) => {
        if (!body || typeof body.id !== "string" || typeof body.allow !== "boolean") return sendJson(res, 400, { error: "bad request" });
        const m = await import("./agent.js");
        return m.settleAsk(body.id, body.allow) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "no such question (already answered, or the run ended)" });
      }).catch((e) => sendJson(res, 500, { error: String(e.message || e) }));
      return;
    }
    if (req.method === "POST" && u.pathname === "/api/agent") {
      Promise.resolve(pathReady).then(() => import("./agent.js")).then(
        (m) => m.handleAgent(root, req, res),
        (e) => send(res, 500, JSON.stringify({ error: "agent unavailable: " + (e.message || e) }))
      );
      return;
    }
    if (req.method === "POST" && u.pathname === "/api/alive") {
      lastPing = Date.now();
      return send(res, 200, "{}");
    }
    if (u.pathname === "/api/file") {
      const p = safeJoin(root, u.searchParams.get("p") || "");
      if (!p) return send(res, 400, JSON.stringify({ error: "path escapes root" }));

      if (req.method === "GET") {
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          return send(res, 404, JSON.stringify({ error: "not found" }));
        }
        if (st.size > MAX_FILE_BYTES) return send(res, 413, JSON.stringify({ error: "file too large" }));
        return send(res, 200, JSON.stringify({ content: fs.readFileSync(p, "utf8") }));
      }
      if (req.method === "PUT") {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (c) => {
          body += c;
          if (body.length > MAX_FILE_BYTES) req.destroy();
        });
        req.on("end", () => {
          try {
            fs.writeFileSync(p, body, "utf8");
            send(res, 200, JSON.stringify({ ok: true }));
          } catch (e) {
            send(res, 500, JSON.stringify({ error: String(e.message || e) }));
          }
        });
        return;
      }
    }
    send(res, 404, JSON.stringify({ error: "not found" }));
  });

  server.listen(0, "127.0.0.1", () => {
    const urlStr = `http://127.0.0.1:${server.address().port}/#t=${TOKEN}`;
    if (onReady) onReady(urlStr);
    else {
      console.log(root ? `\n  fethr — editing ${root}\n  ${urlStr}\n` : `\n  fethr — home\n  ${urlStr}\n`);
      if (process.env.FETHR_NO_OPEN) return; // print the URL, open nothing (tests, remote shells)
      if (opts.app && process.platform === "darwin") {
        // Chromeless app-mode window via Chrome/Edge when available. Explicit
        // --window-size avoids Chrome reusing a stale/tiny remembered size for
        // the --app profile, which otherwise reads as "the window won't resize"
        // (it does — dragging edges works — it just started too small to notice).
        // For a real native window, `npx tauri build` (v0.3) is the better answer;
        // this stays as the dependency-free fallback for plain `npx fethr`.
        execFile(
          "open", ["-na", "Google Chrome", "--args", `--app=${urlStr}`, "--window-size=1100,720"],
          (err) => {
            if (err) execFile("open", [urlStr], () => {});
          }
        );
      } else {
        // `start` is a cmd builtin, not a program, and its first quoted
        // argument is a window title — hence the empty one.
        if (process.platform === "win32") execFile("cmd", ["/c", "start", "", urlStr], () => {});
        else execFile(process.platform === "darwin" ? "open" : "xdg-open", [urlStr], () => {});
      }
    }
  });

  return server;
}
