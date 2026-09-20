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
    const r = await fetch(s.url + "api/file?p=" + encodeURIComponent(p));
    assert.equal(r.status, 400, p);
  }
  const ok = await fetch(s.url + "api/file?p=lib/util.js");
  assert.equal(ok.status, 200);
});

test("tree walker skips build output, dependencies and dotfiles", async (t) => {
  const s = await start(fixture());
  t.after(() => s.close());
  const tree = await (await fetch(s.url + "api/tree")).json();
  const paths = tree.map((n) => n.path);
  assert.deepEqual(paths, ["lib", "lib/util.js", "app.js"]);
});

test("the page carries a Content-Security-Policy that pins connect-src", async (t) => {
  const s = await start(fixture());
  t.after(() => s.close());
  const r = await fetch(s.url);
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
  const m = await (await fetch(npm.url + "api/meta")).json();
  assert.equal(m.version, pkg.version);
  assert.equal(m.channel, "npm");
  assert.equal(m.gitBranch, "trunk-xyz");
  const app = await start(fixture(), { sidecar: true });
  t.after(() => app.close());
  assert.equal((await (await fetch(app.url + "api/meta")).json()).channel, "app");
});
