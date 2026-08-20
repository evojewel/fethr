// fethr local server — serves the editor UI and a minimal file API.
// Binds to 127.0.0.1 only. All file access is confined to the root the
// user launched with; paths that escape it are rejected.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__", "env", "venv"]);
const MAX_TREE_ENTRIES = 5000;

function safeJoin(root, rel) {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) return null;
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
      return send(res, 200, JSON.stringify({ root, name: path.basename(root) }));
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
        // Chromeless app-mode window via Chrome/Edge when available.
        execFile("open", ["-na", "Google Chrome", "--args", `--app=${urlStr}`], (err) => {
          if (err) execFile("open", [urlStr], () => {});
        });
      } else {
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        execFile(opener, [urlStr], () => {});
      }
    }
  });

  return server;
}
