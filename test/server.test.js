// Server-side checks that need no browser: workspace confinement, the tree
// walker's skip list, the security headers, and what /api/meta reports.
// Run with `npm test` (node --test, no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serve, argsFor, defaultOnOpen } from "../src/server.js";
import { setOpenSessionsRunner, setExecRunner, attachInTerminal } from "../src/sessions.js";
import { apiFetch, split } from "./auth.js";
import { claudeFixture, IDS, AGENTS, MISSING_ID } from "./claude-fixture.js";

// Every editor-mode server records its root in the recent-folders list; keep
// that, and the session list, away from the real ~/.fethr and ~/.claude.
const claude = claudeFixture();
process.env.CLAUDE_CONFIG_DIR = claude.base;
process.env.FETHR_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fethr-state-"));
// /api/recent waits for a transcript to appear; not 5 s per test here.
process.env.FETHR_RECENT_WAIT_MS = "300";
// Never spawn the real `claude agents` here; tests that care set their own.
let openList = [];
// Re-registering also drops the 5 s cache, so each change is seen at once.
const setOpen = (list) => { openList = list; setOpenSessionsRunner(async () => openList); };
setOpen([]);

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
  // "junction" is the directory link Windows allows without elevation; ignored elsewhere.
  fs.symlinkSync(outside, path.join(root, "escape"), "junction");
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

const post = (url, p, body) =>
  apiFetch(url, p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("/api/meta reports the mode, and a resumed session with its title", async (t) => {
  const home = await start(null, { home: true });
  t.after(() => home.close());
  const hm = await (await apiFetch(home.url, "api/meta")).json();
  assert.equal(hm.mode, "home");
  assert.equal(hm.root, undefined);
  assert.equal(hm.channel, "npm");
  assert.equal(typeof hm.version, "string");

  const plain = await start(fixture());
  t.after(() => plain.close());
  const pm = await (await apiFetch(plain.url, "api/meta")).json();
  assert.equal(pm.mode, "editor");
  assert.equal(pm.resume, undefined);

  const resumed = await start(claude.work, { session: { id: IDS.titled, fork: true } });
  t.after(() => resumed.close());
  const rm = await (await apiFetch(resumed.url, "api/meta")).json();
  assert.equal(rm.mode, "editor");
  assert.deepEqual(rm.resume, { id: IDS.titled, fork: true, title: "My parser session", source: "CLI" });

  assert.throws(() => serve(claude.work, () => {}, { session: { id: "../x" } }), /bad session id/);
});

test("home mode has no folder: the file, tree, chat and agent APIs answer 400", async (t) => {
  // sidecar: a ping arms the CLI reaper, which would end this test process.
  const s = await start(null, { home: true, sidecar: true });
  t.after(() => s.close());
  for (const [p, init] of [
    ["api/file?p=app.js", {}],
    ["api/tree", {}],
    ["api/chat", {}],
    ["api/chat", { method: "PUT", body: "{}" }],
    ["api/agent", { method: "POST", body: "{}" }],
  ]) {
    const r = await apiFetch(s.url, p, init);
    assert.equal(r.status, 400, p);
    assert.deepEqual(await r.json(), { error: "no folder open" });
  }
  assert.equal((await apiFetch(s.url, "api/alive", { method: "POST" })).status, 200, "the heartbeat still works");
});

test("/api/home lists recent folders and sessions; an editor server records its root", async (t) => {
  const root = fixture();
  const ed = await start(root);
  t.after(() => ed.close());
  const s = await start(null, { home: true });
  t.after(() => s.close());
  const h = await (await apiFetch(s.url, "api/home")).json();
  assert.equal(h.recentFolders[0].path, root);
  assert.equal(h.recentFolders[0].exists, true);
  assert.equal(h.sessions[0].id, IDS.titled);
  assert.ok(h.sessions.every((x) => x.id !== IDS.empty && x.id !== IDS.nested));
  assert.ok(h.sessions.every((x) => x.open === null), "nothing open in the fake list");

});

test("/api/session-history validates the id before touching the filesystem", async (t) => {
  const s = await start(null, { home: true });
  t.after(() => s.close());
  for (const id of ["../x", "../../etc/passwd", "..%2F..%2Fetc%2Fpasswd", ""]) {
    assert.equal((await apiFetch(s.url, "api/session-history?id=" + id)).status, 400, id);
  }
  assert.equal((await apiFetch(s.url, "api/session-history?id=99999999-9999-4999-8999-999999999999")).status, 404);
  const h = await (await apiFetch(s.url, "api/session-history?id=" + IDS.titled)).json();
  assert.equal(h.entries[0].text, "fix the parser please");
  assert.equal(h.source, "CLI");
  const vs = await (await apiFetch(s.url, "api/session-history?id=" + IDS.goneCwd)).json();
  assert.equal(vs.source, "VS Code / Cursor", "the same label the session list uses");
});

test("/api/open resolves server-side and hands onOpen the result", async (t) => {
  const seen = [];
  const s = await start(null, { home: true, onOpen: (target) => { seen.push(target); return { ok: true }; } });
  t.after(() => s.close());

  // A session opens in the folder recorded in its transcript, whatever root
  // the page also sends.
  let r = await post(s.url, "api/open", { session: IDS.titled, fork: true, root: "/etc" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(seen.pop(), { root: claude.work, session: IDS.titled, fork: true });

  r = await post(s.url, "api/open", { session: IDS.titled });
  assert.deepEqual(seen.pop(), { root: claude.work, session: IDS.titled, fork: false });

  assert.equal((await post(s.url, "api/open", { session: "../x" })).status, 400);
  assert.equal((await post(s.url, "api/open", { session: "99999999-9999-4999-8999-999999999999" })).status, 404);
  r = await post(s.url, "api/open", { session: IDS.goneCwd });
  assert.equal(r.status, 409, "the session's folder is gone");

  const dir = fixture();
  r = await post(s.url, "api/open", { root: dir });
  assert.equal(r.status, 200);
  assert.deepEqual(seen.pop(), { root: dir });
  assert.equal((await post(s.url, "api/open", { root: path.join(dir, "app.js") })).status, 400, "a file, not a folder");
  assert.equal((await post(s.url, "api/open", { root: path.join(dir, "nope") })).status, 400, "missing");

  // A home-sized root (here the filesystem root) needs a second, explicit yes:
  // the agent could read everything under it.
  const top = path.parse(dir).root;
  r = await post(s.url, "api/open", { root: top });
  assert.equal(r.status, 428);
  const broad = await r.json();
  assert.equal(broad.broad, true);
  assert.equal(broad.folder, top);
  assert.equal(seen.length, 0, "nothing opened before the second yes");
  r = await post(s.url, "api/open", { root: top, confirmBroad: true });
  assert.equal(r.status, 200);
  assert.deepEqual(seen.pop(), { root: top });
  assert.equal((await post(s.url, "api/open", { root: "relative/dir" })).status, 400, "relative");

  await post(s.url, "api/open", { pick: true });
  assert.deepEqual(seen.pop(), { pick: true });
  await post(s.url, "api/open", { home: true });
  assert.deepEqual(seen.pop(), { home: true });

  assert.equal((await post(s.url, "api/open", {})).status, 400);
  assert.equal((await apiFetch(s.url, "api/open", { method: "POST", body: "{not json" })).status, 400);
  assert.equal(seen.length, 0, "nothing invalid reached onOpen");
});

test("onOpen's answer passes through: cancel, and an error with its status", async (t) => {
  let answer;
  const s = await start(null, { home: true, onOpen: () => answer });
  t.after(() => s.close());
  answer = { cancelled: true };
  let r = await post(s.url, "api/open", { pick: true });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { cancelled: true });
  answer = { status: 501, error: "no folder picker on this platform" };
  r = await post(s.url, "api/open", { pick: true });
  assert.equal(r.status, 501);
  assert.deepEqual(await r.json(), { error: "no folder picker on this platform" });
});

test("the new endpoints sit behind the same token and origin checks", async (t) => {
  const s = await start(null, { home: true, onOpen: () => assert.fail("must not open") });
  t.after(() => s.close());
  const { base, token } = split(s.url);
  for (const p of ["api/home", "api/session-history?id=" + IDS.titled]) {
    assert.equal((await fetch(base + p)).status, 401, p);
    assert.equal((await fetch(base + p, { headers: { "x-fethr-token": token, origin: "http://evil.example" } })).status, 403, p);
  }
  const body = JSON.stringify({ home: true });
  assert.equal((await fetch(base + "api/open", { method: "POST", body })).status, 401);
  assert.equal((await fetch(base + "api/open", { method: "POST", body, headers: { "x-fethr-token": token, origin: "http://evil.example" } })).status, 403);
});

const BIN = fileURLToPath(new URL("../bin/fethr.js", import.meta.url));

test("sidecar: each open request is one FETHR_OPEN=<json> line on stdout", async (t) => {
  const child = spawn(process.execPath, [BIN, "--home", "--sidecar"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => child.kill());
  // One listener for the child's whole life, so no line is missed between waits.
  const lines = [];
  let waiting = null;
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
    if (waiting && lines.length) waiting();
  });
  const nextLine = async () => {
    while (!lines.length) await new Promise((r) => { waiting = r; });
    return lines.shift();
  };
  const openLine = async () => {
    const line = await nextLine();
    assert.match(line, /^FETHR_OPEN=/);
    return JSON.parse(line.slice("FETHR_OPEN=".length));
  };

  const url = (await nextLine()).replace(/^FETHR_URL=/, "");
  assert.equal((await (await apiFetch(url, "api/meta")).json()).mode, "home");

  const odd = path.join(fixture(), "with\nnewline");
  fs.mkdirSync(odd);
  assert.deepEqual(await (await post(url, "api/open", { root: odd })).json(), { ok: true });
  assert.deepEqual(await openLine(), { root: odd }, "a newline in a path stays inside its line");
  await post(url, "api/open", { session: IDS.titled, fork: true });
  assert.deepEqual(await openLine(), { root: claude.work, session: IDS.titled, fork: true });
  const pick = await post(url, "api/open", { pick: true });
  assert.deepEqual(await pick.json(), { pending: true }, "the native dialog has not answered yet");
  assert.deepEqual(await openLine(), { pick: true });
  await post(url, "api/open", { home: true });
  assert.deepEqual(await openLine(), { home: true });
  assert.equal((await post(url, "api/open", { root: "relative" })).status, 400);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(lines, [], "a refused request prints nothing");
});

test("the CLI rejects malformed flags instead of guessing", () => {
  for (const args of [["--fork"], ["--session"], ["--session", "../x"], ["--home", "/tmp"], ["--sesion", IDS.titled], ["a", "b"]]) {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, FETHR_NO_OPEN: "1" }, timeout: 5000 });
    assert.equal(r.status, 2, args.join(" "));
  }
});

test("resuming a session Claude Code runs in the background is refused at open time; forking is not", async (t) => {
  const seen = [];
  const s = await start(null, { home: true, onOpen: (target) => { seen.push(target); return { ok: true }; } });
  t.after(() => { s.close(); setOpen([]); });

  setOpen([{ sessionId: IDS.titled, kind: "background", status: "idle" }]);
  const h = await (await apiFetch(s.url, "api/home")).json();
  assert.deepEqual(h.sessions.find((x) => x.id === IDS.titled).open, { kind: "background", status: "idle" });

  let r = await post(s.url, "api/open", { session: IDS.titled });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "running in the background", hint: "claude attach " + IDS.titled.slice(0, 8) });
  assert.equal(seen.length, 0);

  r = await post(s.url, "api/open", { session: IDS.titled, fork: true });
  assert.equal(r.status, 200, "a fork never touches the running session");

  // Checked fresh at open time, not from the list the page was shown.
  setOpen([]);
  assert.equal((await post(s.url, "api/open", { session: IDS.titled })).status, 200);
  setOpen([{ sessionId: IDS.titled, kind: "background", status: "busy" }]);
  assert.equal((await post(s.url, "api/open", { session: IDS.titled })).status, 409);

  setOpen([{ sessionId: IDS.titled, kind: "interactive", status: "busy" }]);
  assert.equal((await post(s.url, "api/open", { session: IDS.titled })).status, 200, "interactive: allowed, the page recommends Fork");
  setOpen(null); // `claude agents` unavailable: unknown, so the resume goes ahead
  assert.equal((await post(s.url, "api/open", { session: IDS.titled })).status, 200);
});

test("CLI open: the arguments a target launches with", () => {
  assert.deepEqual(argsFor({ root: "/w" }), ["/w"]);
  assert.deepEqual(argsFor({ root: "/w", session: IDS.titled, fork: false }), ["/w", "--session", IDS.titled]);
  assert.deepEqual(argsFor({ root: "/w", session: IDS.titled, fork: true }, true), ["/w", "--session", IDS.titled, "--fork", "--app"]);
  assert.deepEqual(argsFor({ home: true }, true), ["--home", "--app"]);
});

test("CLI open: a detached, hidden fethr process per target; a pick launches what was picked", async () => {
  const launched = [];
  const spawnFn = (cmd, args, options) => {
    launched.push({ cmd, args, options });
    return { on() {}, unref() { launched.at(-1).unrefd = true; } };
  };
  let picked = { root: "/picked" };
  const onOpen = defaultOnOpen(true, { spawnFn, pick: async () => picked });

  assert.deepEqual(await onOpen({ root: "/w", session: IDS.titled, fork: true }), { ok: true });
  const l = launched.pop();
  assert.equal(l.cmd, process.execPath);
  assert.match(l.args[0], /bin[\\/]fethr\.js$/);
  assert.deepEqual(l.args.slice(1), ["/w", "--session", IDS.titled, "--fork", "--app"]);
  assert.deepEqual(l.options, { detached: true, stdio: "ignore", windowsHide: true });
  assert.equal(l.unrefd, true);

  assert.deepEqual(await onOpen({ home: true }), { ok: true });
  assert.deepEqual(launched.pop().args.slice(1), ["--home", "--app"]);

  assert.deepEqual(await onOpen({ pick: true }), { ok: true });
  assert.deepEqual(launched.pop().args.slice(1), ["/picked", "--app"]);
  picked = { cancelled: true };
  assert.deepEqual(await onOpen({ pick: true }), { cancelled: true });
  picked = { status: 501, error: "no folder picker on this platform" };
  assert.deepEqual(await onOpen({ pick: true }), picked);
  assert.equal(launched.length, 0, "nothing launched for a cancel or an error");

  const noApp = defaultOnOpen(false, { spawnFn });
  await noApp({ root: "/w" });
  assert.deepEqual(launched.pop().args.slice(1), ["/w"], "--app only when this server had it");
});

test("sidecar: a start failure is one FETHR_ERROR line on stdout, and exit 2", () => {
  const elsewhere = fixture();
  const cases = [
    { args: ["--fork", "--sidecar"], says: /--fork needs --session/ },
    { args: [elsewhere, "--session", "../x", "--sidecar"], says: /--session needs a session id/ },
    { args: [elsewhere, "--sidecar", "--bogus"], says: /unknown option --bogus/ },
    { args: [claude.work, "--session", "99999999-9999-4999-8999-999999999999", "--sidecar"], says: /no Claude session/ },
    { args: [elsewhere, "--session", IDS.titled, "--sidecar"], says: /was recorded in .*open that folder instead/ },
  ];
  for (const { args, says } of cases) {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(r.status, 2, args.join(" "));
    const lines = r.stdout.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, args.join(" "));
    assert.match(lines[0], /^FETHR_ERROR=[^\n]+$/);
    assert.match(lines[0], says);
  }
  // A terminal user gets stderr only; stdout stays clean.
  const cli = spawnSync(process.execPath, [BIN, elsewhere, "--session", IDS.titled], { encoding: "utf8", timeout: 5000 });
  assert.equal(cli.status, 2);
  assert.equal(cli.stdout, "");
  assert.match(cli.stderr, /open that folder instead/);
});

test("session actions on a background session: attach opens Terminal, stop-and-resume stops then opens", async (t) => {
  const seen = [];
  const execs = [];
  let execAnswer = () => ({ err: null, stdout: "", stderr: "" });
  setExecRunner(async (cmd, args, options) => { execs.push({ cmd, args, options }); return execAnswer(cmd, args); }, { claudePath: () => "/opt/cc/claude" });
  const s = await start(null, { home: true, onOpen: (target) => { seen.push(target); return { ok: true }; } });
  t.after(() => { s.close(); setOpen([]); setExecRunner(null); });
  const act = (body) => post(s.url, "api/session-action", body);

  assert.equal((await act({ id: "../x", action: "attach" })).status, 400);
  assert.equal((await act({ id: IDS.titled, action: "rm -rf" })).status, 400);
  setOpen([{ sessionId: IDS.titled, kind: "interactive", status: "idle" }]);
  assert.equal((await act({ id: IDS.titled, action: "attach" })).status, 409, "only a background session");
  assert.equal(execs.length, 0);

  setOpen([{ sessionId: IDS.titled, kind: "background", status: "busy" }]);
  let r = await act({ id: IDS.titled, action: "attach" });
  if (process.platform === "darwin") {
    assert.deepEqual(await r.json(), { ok: true });
    const e = execs.pop();
    assert.equal(e.cmd, "osascript");
    assert.deepEqual(e.args, [
      "-e", `tell application "Terminal" to do script "'/opt/cc/claude' attach ${IDS.titled.slice(0, 8)}"`,
      "-e", 'tell application "Terminal" to activate',
    ]);
  } else {
    assert.equal(r.status, 501);
  }
  assert.equal(seen.length, 0, "attach opens nothing here");

  // stop-and-resume: `claude stop <id8>`, then the session is gone from the
  // list and opens exactly as /api/open {session} would.
  execAnswer = () => { openList = []; return { err: null, stdout: "", stderr: "" }; };
  r = await act({ id: IDS.titled, action: "stop-and-resume" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const stop = execs.pop();
  assert.equal(stop.cmd, "/opt/cc/claude");
  assert.deepEqual(stop.args, ["stop", IDS.titled.slice(0, 8)]);
  assert.equal(stop.options.timeout, 10_000);
  assert.deepEqual(seen.pop(), { root: claude.work, session: IDS.titled, fork: false });

  // A failed stop reports the CLI's own words and opens nothing.
  setOpen([{ sessionId: IDS.titled, kind: "background", status: "idle" }]);
  execAnswer = () => ({ err: new Error("exit 1"), stdout: "", stderr: "warming up\nError: no background session b1\n" });
  r = await act({ id: IDS.titled, action: "stop-and-resume" });
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: "warming up · Error: no background session b1" });
  assert.equal(seen.length, 0);
});

test("attach: other platforms get 501; an unquotable claude path is refused", async (t) => {
  t.after(() => setExecRunner(null));
  setExecRunner(async () => assert.fail("must not run"), { claudePath: () => "/opt/cc/claude" });
  assert.equal((await attachInTerminal(IDS.titled, { platform: "linux" })).status, 501);
  for (const bad of ['/opt/a"b/claude', "/opt/a'b/claude", "/opt/a\\b/claude", "/opt/a\nb/claude"]) {
    setExecRunner(async () => assert.fail("must not run"), { claudePath: () => bad });
    assert.equal((await attachInTerminal(IDS.titled, { platform: "darwin" })).status, 500, bad);
  }
});

test("/api/subagents and a subagent's history over HTTP", async (t) => {
  const s = await start(null, { home: true });
  t.after(() => { s.close(); setOpen([]); });
  assert.equal((await apiFetch(s.url, "api/subagents?id=../x")).status, 400);
  assert.equal((await apiFetch(s.url, "api/subagents?id=99999999-9999-4999-8999-999999999999")).status, 404);
  let list = await (await apiFetch(s.url, "api/subagents?id=" + IDS.titled)).json();
  assert.equal(list[0].agentId, AGENTS.wf);
  assert.equal(list.find((a) => a.agentId === AGENTS.quiet).state, "ended", "the (fake, empty) open list is known");
  setOpen([{ sessionId: IDS.titled, kind: "interactive", status: "idle" }]);
  list = await (await apiFetch(s.url, "api/subagents?id=" + IDS.titled)).json();
  assert.equal(list.find((a) => a.agentId === AGENTS.quiet).state, "idle", "the parent is open");

  const hist = (agent) => apiFetch(s.url, `api/session-history?id=${IDS.titled}&agent=${agent}`);
  for (const bad of ["..%2Fx", "A0", "", "x".repeat(65)]) assert.equal((await hist(bad)).status, 400, bad);
  assert.equal((await hist(AGENTS.gone)).status, 404, "another session's agent");
  const h = await (await hist(AGENTS.done)).json();
  assert.equal(h.title, "Web: home view");
  assert.equal(h.entries[0].text, "build the home view");

  const home = await (await apiFetch(s.url, "api/home")).json();
  const titled = home.sessions.find((x) => x.id === IDS.titled);
  assert.equal(titled.state, "open");
  assert.deepEqual(titled.subagents, { total: 6, active: 1 });
});

test("recent folders remember the session: a resume at start, a new chat via /api/recent", async (t) => {
  const stateFile = path.join(process.env.FETHR_STATE_DIR, "recent.json");
  fs.rmSync(stateFile, { force: true });
  const home = await start(null, { home: true });
  t.after(() => home.close());
  const recent = async () => (await (await apiFetch(home.url, "api/home")).json()).recentFolders;

  // Resumed (not forked): the folder is recorded with its session.
  const resumed = await start(claude.work, { session: { id: IDS.titled, fork: false } });
  t.after(() => resumed.close());
  let r = await recent();
  assert.equal(r.length, 1);
  assert.equal(r[0].path, claude.work);
  assert.deepEqual(r[0].session, { id: IDS.titled, title: "My parser session", state: "recent", open: null });

  // A plain open of the same folder adds a sessionless row; once its first
  // chat reports a session id, that row is replaced by the named one.
  await new Promise((r) => setTimeout(r, 5)); // ordered by lastOpened (ms)
  const plain = await start(claude.work);
  t.after(() => plain.close());
  r = await recent();
  assert.deepEqual(r.map((e) => e.session && e.session.id), [null, IDS.titled]);
  let res = await post(plain.url, "api/recent", { session: IDS.successor });
  assert.equal(res.status, 200);
  r = await recent();
  assert.deepEqual(r.map((e) => e.session && e.session.id), [IDS.successor, IDS.titled], "the sessionless row is gone");

  assert.equal((await post(plain.url, "api/recent", { session: "../x" })).status, 400);
  assert.equal((await post(plain.url, "api/recent", { session: MISSING_ID })).status, 404, "after a short wait for the transcript");
  const elsewhere = await start(fixture());
  t.after(() => elsewhere.close());
  assert.equal((await post(elsewhere.url, "api/recent", { session: IDS.titled })).status, 409, "a session from another folder");
  assert.equal((await post(home.url, "api/recent", { session: IDS.titled })).status, 400, "home has no folder");

  // A session that disappears keeps its row, with session: null.
  const gone = "abababab-0000-4000-8000-0000000000ab";
  const f = path.join(claude.projects, "-Users-someone-other", gone + ".jsonl");
  fs.writeFileSync(f, JSON.stringify({ type: "user", cwd: claude.work, message: { content: "short-lived" } }) + "\n");
  assert.equal((await post(plain.url, "api/recent", { session: gone })).status, 200);
  fs.rmSync(f);
  r = await recent();
  assert.equal(r[0].path, claude.work);
  assert.equal(r[0].session, null);
});

test("/api/open resumes a moved session where it lives now; a fork stays on the old one", async (t) => {
  const seen = [];
  const s = await start(null, { home: true, onOpen: (target) => { seen.push(target); return { ok: true }; } });
  t.after(() => { s.close(); setOpen([]); });

  assert.equal((await post(s.url, "api/open", { session: IDS.movedA })).status, 200);
  assert.deepEqual(seen.pop(), { root: claude.work, session: IDS.successor, fork: false }, "two hops");
  assert.equal((await post(s.url, "api/open", { session: IDS.movedA, fork: true })).status, 200);
  assert.deepEqual(seen.pop(), { root: claude.work, session: IDS.movedA, fork: true });
  assert.equal((await post(s.url, "api/open", { session: IDS.dangling })).status, 200);
  assert.deepEqual(seen.pop(), { root: claude.work, session: IDS.dangling, fork: false }, "successor not here: as asked");

  // The background check applies to the successor.
  setOpen([{ sessionId: IDS.successor, kind: "background", status: "idle" }]);
  const r = await post(s.url, "api/open", { session: IDS.movedA });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).hint, "claude attach " + IDS.successor.slice(0, 8));
  assert.equal(seen.length, 0);
});

test("/api/prefs: survives the server, merges, deletes with null, refuses anything else", async (t) => {
  fs.rmSync(path.join(process.env.FETHR_STATE_DIR, "prefs.json"), { force: true });
  const put = (url, body, raw) => apiFetch(url, "api/prefs", { method: "PUT", body: raw ?? JSON.stringify(body) });
  const home = await start(null, { home: true });
  t.after(() => home.close());
  assert.deepEqual(await (await apiFetch(home.url, "api/prefs")).json(), {});

  let r = await put(home.url, { "fethr.theme": "moss", "fethr.agentWidth": "340" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { "fethr.theme": "moss", "fethr.agentWidth": "340" });
  r = await put(home.url, { "fethr.agentWidth": null, "fethr.autoSave": "true" });
  assert.deepEqual(await r.json(), { "fethr.theme": "moss", "fethr.autoSave": "true" }, "merge; null deletes");

  // Another server (a later launch, another port and token) sees the same.
  const editor = await start(fixture());
  t.after(() => editor.close());
  assert.deepEqual(await (await apiFetch(editor.url, "api/prefs")).json(), { "fethr.theme": "moss", "fethr.autoSave": "true" });

  for (const [body, why] of [
    [{ theme: "x" }, "key without the fethr. prefix"],
    [{ "fethr.": "x" }, "empty name"],
    [{ "fethr.a/b": "x" }, "slash in key"],
    [{ ["fethr." + "a".repeat(65)]: "x" }, "key too long"],
    [{ "fethr.n": 3 }, "number value"],
    [{ "fethr.o": { nested: "x" } }, "nested value"],
    [{ "fethr.big": "x".repeat(2049) }, "value over 2 KB"],
    [["fethr.a"], "array"],
    ["fethr.a", "string"],
  ]) {
    assert.equal((await put(home.url, body)).status, 400, why);
  }
  assert.equal((await put(home.url, null, "{not json")).status, 400);
  assert.equal((await put(home.url, null, JSON.stringify({ "fethr.a": "x".repeat(2000) }) + " ".repeat(16 * 1024))).status, 413);
  assert.deepEqual(await (await apiFetch(home.url, "api/prefs")).json(), { "fethr.theme": "moss", "fethr.autoSave": "true" }, "a refused PUT changes nothing");

  // A hand-edited file never reaches the page in a shape it did not write.
  fs.writeFileSync(path.join(process.env.FETHR_STATE_DIR, "prefs.json"), JSON.stringify({ "fethr.ok": "1", bad: "2", "fethr.n": 3 }));
  assert.deepEqual(await (await apiFetch(home.url, "api/prefs")).json(), { "fethr.ok": "1" });

  const { base } = split(home.url);
  assert.equal((await fetch(base + "api/prefs")).status, 401);
  assert.equal((await fetch(base + "api/prefs", { method: "PUT", body: "{}" })).status, 401);
});

test("Recent: hide and unhide an entry without touching anything on disk; reopening shows it again", async (t) => {
  fs.rmSync(path.join(process.env.FETHR_STATE_DIR, "recent.json"), { force: true });
  const home = await start(null, { home: true });
  t.after(() => home.close());
  const a = fixture();
  const ed = await start(a);
  t.after(() => ed.close());
  // Order is by lastOpened (ms); two starts in the same millisecond would tie.
  await new Promise((r) => setTimeout(r, 5));
  const resumed = await start(claude.work, { session: { id: IDS.titled, fork: false } });
  t.after(() => resumed.close());
  const lists = async () => {
    const h = await (await apiFetch(home.url, "api/home")).json();
    return { visible: h.recentFolders.map((e) => [e.path, e.session && e.session.id]), hidden: h.recentHidden.map((e) => [e.path, e.session && e.session.id]), h };
  };
  let l = await lists();
  assert.deepEqual(l.visible, [[claude.work, IDS.titled], [a, null]]);
  assert.deepEqual(l.hidden, []);

  assert.equal((await post(home.url, "api/recent/hide", { path: claude.work, session: IDS.titled })).status, 200);
  l = await lists();
  assert.deepEqual(l.visible, [[a, null]]);
  assert.deepEqual(l.hidden, [[claude.work, IDS.titled]]);
  assert.deepEqual(Object.keys(l.h.recentHidden[0]).sort(), Object.keys(l.h.recentFolders[0]).sort(), "same item shape");
  assert.ok(fs.existsSync(claude.files.titled) && fs.existsSync(claude.work), "nothing deleted");

  // The key is folder + session: the folder's plain entry is a different one.
  assert.equal((await post(home.url, "api/recent/hide", { path: claude.work })).status, 404);
  assert.equal((await post(home.url, "api/recent/hide", { path: a, session: "../x" })).status, 400);
  assert.equal((await post(home.url, "api/recent/hide", { session: IDS.titled })).status, 400);

  assert.equal((await post(ed.url, "api/recent/unhide", { path: claude.work, session: IDS.titled })).status, 200, "editor mode too");
  l = await lists();
  assert.deepEqual(l.visible, [[claude.work, IDS.titled], [a, null]]);

  // Hidden, then opened again: visible again.
  await post(home.url, "api/recent/hide", { path: a });
  assert.deepEqual((await lists()).hidden, [[a, null]]);
  await new Promise((r) => setTimeout(r, 5));
  const again = await start(a);
  t.after(() => again.close());
  l = await lists();
  assert.deepEqual(l.hidden, []);
  assert.equal(l.visible[0][0], a, "and back on top");
});
