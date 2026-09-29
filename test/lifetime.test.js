// Who ends the server. In CLI mode it exits itself when the tab stops
// pinging; in sidecar mode it must not, because the native window's timers
// are throttled in the background and the app kills the child on close.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { apiFetch } from "./auth.js";

const BIN = new URL("../bin/fethr.js", import.meta.url).pathname;

function launch(extraArgs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fethr-life-"));
  const child = spawn(process.execPath, [BIN, root, "--sidecar", ...extraArgs], {
    env: { ...process.env, FETHR_IDLE_MS: "300" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const url = new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; const m = /FETHR_URL=(\S+)/.exec(out); if (m) resolve(m[1]); });
  });
  return { child, url };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("sidecar mode outlives a starved heartbeat", async () => {
  const { child, url } = launch([]);
  const u = await url;
  await apiFetch(u, "api/alive", { method: "POST" });
  await sleep(1500);
  assert.equal(child.exitCode, null, "server exited on its own in sidecar mode");
  child.kill();
});

test("CLI-style server still reaps itself once pings stop", async () => {
  // --sidecar only changes the banner and the reaper; pass the internal flag
  // off by launching without it but capturing the URL from the banner.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fethr-life-"));
  const child = spawn(process.execPath, [BIN, root], {
    env: { ...process.env, FETHR_IDLE_MS: "300", FETHR_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const u = await new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; const m = /(http:\/\/127\.0\.0\.1:\d+\/\S*)/.exec(out); if (m) resolve(m[1]); });
  });
  await apiFetch(u, "api/alive", { method: "POST" });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const code = await Promise.race([exited, sleep(4000).then(() => "timeout")]);
  assert.equal(code, 0, "CLI server should exit after the idle window");
});

test("a sidecar whose parent dies exits on its own", async () => {
  // An intermediate process launches the sidecar and then quits, the way a
  // force-quit app would; the sidecar must notice it has been re-parented.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fethr-life-"));
  const launcher = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const c = spawn(process.execPath, [${JSON.stringify(BIN)}, ${JSON.stringify(root)}, "--sidecar"], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, FETHR_IDLE_MS: "200" } });
    c.stdout.on("data", (d) => { if (/FETHR_URL=/.test(String(d))) { console.log("PID=" + c.pid); setTimeout(() => process.exit(0), 100); } });
  `], { stdio: ["ignore", "pipe", "inherit"] });
  const pid = await new Promise((resolve) => {
    let out = "";
    launcher.stdout.on("data", (d) => { out += d; const m = /PID=(\d+)/.exec(out); if (m) resolve(Number(m[1])); });
  });
  const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  const t0 = Date.now();
  while (alive(pid) && Date.now() - t0 < 4000) await sleep(100);
  assert.equal(alive(pid), false, "sidecar kept running after its parent died");
});
