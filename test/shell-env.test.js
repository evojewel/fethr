// The sidecar's PATH fix: what it reads from the login shell, what it falls
// back to, and that a hung shell can't hold it up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergePath, parseShellOutput, readLoginPath, fixPath, fallbackDirs } from "../src/shell-env.js";

test("mergePath keeps order and the first copy of each entry", () => {
  assert.equal(mergePath(["/a", "/b"], ["/b", "/c"], ["", "/a", "/d"]), "/a:/b:/c:/d");
});

test("parseShellOutput reads between the markers, ignoring profile noise", () => {
  assert.equal(parseShellOutput("Welcome!\nnvm loaded\n__FETHR_PATH__/x/bin:/usr/bin__FETHR_PATH__"), "/x/bin:/usr/bin");
  assert.equal(parseShellOutput("no markers here"), null);
  assert.equal(parseShellOutput("__FETHR_PATH____FETHR_PATH__"), null);
  assert.equal(parseShellOutput(undefined), null);
});

test("readLoginPath asks the shell once, with a hard timeout", async () => {
  let seen;
  const ok = await readLoginPath({ shell: "/bin/zsh", timeoutMs: 1234, execFileFn: (cmd, args, opts, cb) => {
    seen = { cmd, args, opts };
    cb(null, "__FETHR_PATH__/opt/homebrew/bin:/usr/bin__FETHR_PATH__");
  } });
  assert.equal(ok, "/opt/homebrew/bin:/usr/bin");
  assert.equal(seen.cmd, "/bin/zsh");
  assert.equal(seen.args[0], "-ilc");
  assert.equal(seen.opts.timeout, 1234);
  assert.equal(seen.opts.killSignal, "SIGKILL");
  // a timeout surfaces as an error with no output: null, never a rejection
  assert.equal(await readLoginPath({ execFileFn: (c, a, o, cb) => cb(Object.assign(new Error("t"), { killed: true }), "") }), null);
  assert.equal(await readLoginPath({ execFileFn: () => { throw new Error("spawn failed"); } }), null);
});

test("readLoginPath against a real shell that hangs is cut off by the timeout", async () => {
  const t0 = Date.now();
  const p = await readLoginPath({ shell: "/bin/sh", timeoutMs: 300, execFileFn: (cmd, args, opts, cb) =>
    import("node:child_process").then(({ execFile }) => execFile("/bin/sh", ["-c", "sleep 5"], opts, cb)) });
  assert.equal(p, null);
  assert.ok(Date.now() - t0 < 2000, "did not wait for the sleep");
});

test("fixPath: login entries first, then fallbacks, then what was there", async () => {
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const r = await fixPath(env, { platform: "darwin", read: async () => "/u/.nvm/bin:/usr/bin", home: "/u", execPath: "/n/bin/node" });
  assert.equal(r.source, "login-shell");
  const parts = env.PATH.split(":");
  assert.deepEqual(parts.slice(0, 2), ["/u/.nvm/bin", "/usr/bin"]);
  assert.ok(parts.includes("/opt/homebrew/bin") && parts.includes("/n/bin") && parts.includes("/sbin"));
  assert.equal(parts.length, new Set(parts).size, "no duplicates");

  const env2 = { PATH: "/usr/bin:/bin" };
  const r2 = await fixPath(env2, { platform: "darwin", read: async () => null, home: "/u", execPath: "/n/bin/node" });
  assert.equal(r2.source, "fallback");
  assert.deepEqual(env2.PATH.split(":").slice(0, fallbackDirs("/u", "/n/bin/node").length), fallbackDirs("/u", "/n/bin/node"));

  const env3 = { PATH: "C:\\Windows" };
  assert.equal((await fixPath(env3, { platform: "win32", read: async () => "/never" })).source, "unchanged");
  assert.equal(env3.PATH, "C:\\Windows");
});
