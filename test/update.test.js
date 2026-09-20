// The update check's decisions, without a browser or a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, decide, fetchManifest, validateManifest, CHECKED_KEY, CACHE_KEY } from "../web/update.js";

const manifest = {
  npm: "0.9.2-alpha",
  app: "0.9.3-alpha",
  download: "https://github.com/evojewel/fethr/releases/download/v0.9.3-alpha/fethr_0.9.3_aarch64.dmg",
  releases: "https://github.com/evojewel/fethr/releases",
};

test("version ordering: numeric, and a pre-release precedes its release", () => {
  assert.equal(compareVersions("0.9.3-alpha", "0.9.10-alpha"), -1);
  assert.equal(compareVersions("0.9.3-alpha", "0.9.3"), -1);
  assert.equal(compareVersions("1.0.0", "0.9.9-alpha"), 1);
  assert.equal(compareVersions("garbage", "0.9.3"), 0, "unparseable never prompts");
});

test("each channel is compared against its own number", () => {
  assert.deepEqual(decide(manifest, "0.9.2-alpha", "app"), { kind: "download", version: "0.9.3-alpha", url: manifest.download });
  assert.equal(decide(manifest, "0.9.3-alpha", "app").kind, "current");
  assert.equal(decide(manifest, "0.9.2-alpha", "npm").kind, "current", "npm tag has not moved");
  assert.equal(decide(manifest, "0.9.4-alpha", "npm").kind, "current", "running ahead of the tag");
  assert.equal(decide({ ...manifest, npm: "0.9.5-alpha" }, "0.9.2-alpha", "npm").kind, "npm");
});

test("a manifest pointing anywhere but the project's GitHub is dropped", () => {
  assert.equal(validateManifest({ ...manifest, download: "https://evil.example/x.dmg" }), null);
  assert.equal(validateManifest({ ...manifest, app: "latest" }), null);
  assert.equal(validateManifest([]), null);
  assert.deepEqual(validateManifest(manifest), manifest);
});

test("fetches once per day and serves the cached answer after that", async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  let calls = 0;
  const fetchFn = async () => { calls++; return { ok: true, json: async () => manifest }; };
  assert.deepEqual(await fetchManifest(storage, fetchFn, "2026-09-20"), manifest);
  assert.deepEqual(await fetchManifest(storage, fetchFn, "2026-09-20"), manifest);
  assert.equal(calls, 1);
  assert.equal(store.get(CHECKED_KEY), "2026-09-20");
  await fetchManifest(storage, fetchFn, "2026-09-21");
  assert.equal(calls, 2);
  const failing = async () => { throw new Error("offline"); };
  const store2 = new Map();
  const storage2 = { getItem: (k) => store2.get(k) ?? null, setItem: (k, v) => store2.set(k, v) };
  assert.equal(await fetchManifest(storage2, failing, "2026-09-20"), null);
  assert.equal(store2.get(CACHE_KEY), "", "a failed day is remembered, not retried on every load");
});
