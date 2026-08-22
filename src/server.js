// fethr local server — serves the editor UI and a minimal file API.
// Binds to 127.0.0.1 only. All file access is confined to the root the
// user launched with; paths that escape it are rejected.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__", "env", "venv"]);
const MAX_TREE_ENTRIES = 5000;

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

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

export function serve(root, onReady, opts = {}) {
  root = path.resolve(root);
  let lastPing = null;

  // Exit when the editor window has been gone for a while (only once it
  // has pinged at least once, so headless/API use is unaffected).
  const reaper = setInterval(() => {
    if (lastPing && Date.now() - lastPing > 30_000) process.exit(0);
  }, 5_000);
  reaper.unref();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");

    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      return send(res, 200, fs.readFileSync(path.join(DIST, "index.html")), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && u.pathname === "/editor.js") {
      return send(res, 200, fs.readFileSync(path.join(DIST, "editor.js")), "text/javascript; charset=utf-8");
    }
    if (req.method === "GET" && u.pathname === "/api/meta") {
      return send(res, 200, JSON.stringify({ root, name: path.basename(root), gitBranch: getGitBranch(root) }));
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
    if (req.method === "POST" && u.pathname === "/api/agent") {
      import("./agent.js").then(
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
    const urlStr = `http://127.0.0.1:${server.address().port}/`;
    if (onReady) onReady(urlStr);
    else {
      console.log(`\n  fethr — editing ${root}\n  ${urlStr}\n`);
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
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        execFile(opener, [urlStr], () => {});
      }
    }
  });

  return server;
}
