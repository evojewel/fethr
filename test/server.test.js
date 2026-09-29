// Server-side checks that need no browser: workspace confinement, the tree
// walker's skip list, the security headers, and what /api/meta reports.
// Run with `npm test` (node --test, no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { serve } from "../src/server.js";
import { apiFetch, split } from "./auth.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fethr-test-"));
  fs.writeFileSync(path.join(dir, "app.js"), "x = 1\n");
  fs.mkdirSync(path.join(dir, "lib"));
  fs.writeFileSync(path.join(dir, "lib", "util.js"), "export const x = 1;\n");
  for (const d of ["node_modules", "target", "dist", ".git"]) {
    fs.mkdirSync(path.join(dir, d, "deep"), { recursive: true });
    fs.writeFileSync(path.join(dir, d, "deep", "junk.txt"), "junk");
  }
  return dir;
}

async function start(root, opts) {
  const server = await new Promise((resolve) => {
    const s = serve(root, (url) => resolve(Object.assign(s, { url })), opts);
  });
  return server;
}

test("workspace confinement rejects lexical and symlink escapes", async (t) => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fethr-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(outside, path.join(root, "escape"));
  const s = await start(root);
  t.after(() => s.close());
  for (const p of ["../../etc/passwd", "escape/secret.txt", "/etc/passwd"]) {
    const r = await apiFetch(s.url, "api/file?p=" + encodeURIComponent(p));
    assert.equal(r.status, 400, p);
  }
  const ok = await apiFetch(s.url, "api/file?p=lib/util.js");
  assert.equal(ok.status, 200);
});

test("tree walker skips build output, dependencies and dotfiles", async (t) => {
  const s = await start(fixture());
  t.after(() => s.close());
  const tree = await (await apiFetch(s.url, "api/tree")).json();
  const paths = tree.map((n) => n.path);
  assert.deepEqual(paths, ["lib", "lib/util.js", "app.js"]);
});

test("the page carries a Content-Security-Policy that pins connect-src", async (t) => {
  const s = await start(fixture());
  t.after(() => s.close());
  const r = await fetch(split(s.url).base);
  const csp = r.headers.get("content-security-policy") || "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src 'self' https:\/\/fethr\.dev(;|$)/);
  assert.doesNotMatch(csp, /unsafe-eval/);
});

test("/api/meta reports version, channel and the real branch", async (t) => {
  const root = fixture();
  execSync("git init -q -b trunk-xyz && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: root });
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const npm = await start(root);
  t.after(() => npm.close());
  const m = await (await apiFetch(npm.url, "api/meta")).json();
  assert.equal(m.version, pkg.version);
  assert.equal(m.channel, "npm");
  assert.equal(m.gitBranch, "trunk-xyz");
  const app = await start(fixture(), { sidecar: true });
  t.after(() => app.close());
  assert.equal((await (await apiFetch(app.url, "api/meta")).json()).channel, "app");
});

test("/api refuses calls without the launch token, with a wrong one, or from another origin", async (t) => {
  const s = await start(fixture());
  t.after(() => s.close());
  const { base, token } = split(s.url);
  assert.match(token, /^[A-Za-z0-9_-]{32}$/, "the URL fragment carries a token");
  assert.equal((await fetch(base + "api/meta")).status, 401, "no header");
  assert.equal((await fetch(base + "api/meta", { headers: { "x-fethr-token": "x".repeat(32) } })).status, 401, "wrong token");
  assert.equal((await fetch(base + "api/meta", { headers: { "x-fethr-token": token, origin: "http://evil.example" } })).status, 403, "foreign origin");
  assert.equal((await fetch(base + "api/meta", { headers: { "x-fethr-token": token, origin: base.slice(0, -1) } })).status, 200, "own origin");
  assert.equal((await apiFetch(s.url, "api/meta")).status, 200);
  assert.equal((await fetch(base)).status, 200, "the page itself stays open");
  assert.equal((await fetch(base + "editor.js")).status, 200, "so does the bundle");
});
