// The page's preferences (theme, panel widths, auto-save, …), kept by the
// server in ~/.fethr/prefs.json. They used to live in localStorage, which is
// per origin; the server binds a random port each launch, so every launch was
// a new origin and every preference reset. The page reads them through
// GET /api/prefs and writes through PUT /api/prefs.
//
// The format is deliberately narrow, since any page holding the token can
// write it: a flat object of "fethr.*" keys to short strings.

import { readState, writeState } from "./state.js";

const FILE = "prefs.json";
export const PREF_KEY_RE = /^fethr\.[A-Za-z0-9._-]{1,64}$/;
export const MAX_PREF_VALUE = 2 * 1024;
export const MAX_PREFS_BODY = 16 * 1024;
// Bounds the file: PUTs merge, so without a cap it could only grow.
const MAX_PREF_KEYS = 200;

const isPlainObject = (o) => !!o && typeof o === "object" && !Array.isArray(o);
const validValue = (v) => typeof v === "string" && v.length <= MAX_PREF_VALUE;

// Stored prefs, keeping only entries that are still valid (a hand-edited or
// older file never reaches the page in a shape it did not write).
export function readPrefs() {
  const stored = readState(FILE, {});
  if (!isPlainObject(stored)) return {};
  const out = {};
  for (const [k, v] of Object.entries(stored)) if (PREF_KEY_RE.test(k) && validValue(v)) out[k] = v;
  return out;
}

// Merge a PUT body into the stored prefs: a string sets, null deletes. The
// whole body is refused if any entry is malformed. Returns { prefs } or
// { status, error }.
export function mergePrefs(patch) {
  if (!isPlainObject(patch)) return { status: 400, error: "prefs must be a flat object" };
  for (const [k, v] of Object.entries(patch)) {
    if (!PREF_KEY_RE.test(k)) return { status: 400, error: `bad pref key ${JSON.stringify(k.slice(0, 80))}` };
    if (v !== null && !validValue(v)) return { status: 400, error: `bad value for ${k}: a string of at most ${MAX_PREF_VALUE} characters, or null` };
  }
  const prefs = readPrefs();
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete prefs[k];
    else prefs[k] = v;
  }
  if (Object.keys(prefs).length > MAX_PREF_KEYS) return { status: 400, error: "too many prefs" };
  try {
    writeState(FILE, prefs);
  } catch (e) {
    return { status: 500, error: "could not save prefs: " + (e.code || e.message) };
  }
  return { prefs };
}
