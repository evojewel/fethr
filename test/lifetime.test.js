// Who ends the server. In CLI mode it exits itself when the tab stops
// pinging; in sidecar mode it must not, because the native window's timers
// are throttled in the background and the app kills the child on close.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

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
  await fetch(u + "api/alive", { method: "POST" });
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
    child.stdout.on("data", (d) => { out += d; const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out); if (m) resolve(m[1]); });
  });
  await fetch(u + "api/alive", { method: "POST" });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const code = await Promise.race([exited, sleep(4000).then(() => "timeout")]);
  assert.equal(code, 0, "CLI server should exit after the idle window");
});
