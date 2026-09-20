// Is there a newer fethr than the one running?
//
// Once a day the editor fetches https://fethr.dev/version.json — a public
// file, no query string, no cookies, nothing sent. It is the one network
// call the editor makes on its own (the agent panel makes others, when you
// use it), and the footer checkbox turns it off.
//
// Two numbers, because the DMG and the npm tag do not move together: a
// native-app user is told about a new DMG, an npx user about a new npm tag.
// The server says which one this instance came from (/api/meta.channel).

export const MANIFEST_URL = "https://fethr.dev/version.json";
const DOWNLOAD_PREFIX = "https://github.com/evojewel/fethr/";
const VERSION_PATTERN = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-([A-Za-z0-9.]{1,20}))?$/;

export function parseVersion(v) {
  const m = VERSION_PATTERN.exec(String(v ?? "").trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

// -1 if a is older than b, 1 if newer, 0 if the same. A pre-release is older
// than the release it precedes. Anything unparseable compares equal: an
// unreadable version must never produce an update prompt.
export function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] < pb.core[i]) return -1;
    if (pa.core[i] > pb.core[i]) return 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export function validateManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { npm, app, download, releases } = input;
  if (!parseVersion(npm) || !parseVersion(app)) return null;
  if (typeof download !== "string" || !download.startsWith(DOWNLOAD_PREFIX)) return null;
  if (typeof releases !== "string" || !releases.startsWith(DOWNLOAD_PREFIX)) return null;
  return { npm, app, download, releases };
}

// What to tell the user, given the manifest and what is running.
export function decide(manifest, running, channel) {
  if (channel === "app") {
    return compareVersions(manifest.app, running) > 0
      ? { kind: "download", version: manifest.app, url: manifest.download }
      : { kind: "current" };
  }
  return compareVersions(manifest.npm, running) > 0
    ? { kind: "npm", version: manifest.npm, url: manifest.releases }
    : { kind: "current" };
}

export const ENABLED_KEY = "fethr.updateCheck";   // "0" turns the daily fetch off
export const CHECKED_KEY = "fethr.updateChecked"; // the day of the last fetch
export const CACHE_KEY = "fethr.updateManifest";  // that fetch's validated result

export function isEnabled(storage) {
  try { return storage.getItem(ENABLED_KEY) !== "0"; } catch { return false; }
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

// One fetch per browser per day, the result cached so a reload does not
// re-fetch. Returns the validated manifest or null; never throws.
export async function fetchManifest(storage, fetchFn = fetch, day = today()) {
  try {
    if (storage.getItem(CHECKED_KEY) === day) {
      const cached = storage.getItem(CACHE_KEY);
      return cached ? validateManifest(JSON.parse(cached)) : null;
    }
  } catch { /* no storage: fall through and fetch */ }
  let manifest = null;
  try {
    const r = await fetchFn(MANIFEST_URL, { cache: "no-store", credentials: "omit" });
    if (r.ok) manifest = validateManifest(await r.json());
  } catch { /* offline, blocked, or a bad file: say nothing */ }
  try {
    storage.setItem(CHECKED_KEY, day);
    storage.setItem(CACHE_KEY, manifest ? JSON.stringify(manifest) : "");
  } catch { /* ignore */ }
  return manifest;
}
