// Theme bookkeeping without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, DEFAULT_THEME, KEY, loadTheme, saveTheme, resolveTheme, isDark } from "../web/theme.js";

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };

test("every non-auto theme declares a swatch and a dark flag", () => {
  for (const t of THEMES.filter((t) => t.id !== "auto")) {
    assert.match(t.swatch.ground, /^#[0-9a-f]{6}$/i, t.id);
    assert.match(t.swatch.accent, /^#[0-9a-f]{6}$/i, t.id);
    assert.equal(typeof t.dark, "boolean", t.id);
  }
});

test("a saved id round-trips; garbage and missing fall back to auto", () => {
  const s = mem();
  assert.equal(loadTheme(s), DEFAULT_THEME);
  saveTheme(s, "slate");
  assert.equal(s.m.get(KEY), "slate");
  assert.equal(loadTheme(s), "slate");
  s.setItem(KEY, "neon");
  assert.equal(loadTheme(s), "auto");
  assert.equal(loadTheme({ getItem() { throw new Error("blocked"); } }), "auto");
});

test("auto resolves by the system setting; explicit ids stand", () => {
  assert.equal(resolveTheme("auto", true), "moss");
  assert.equal(resolveTheme("auto", false), "paper");
  assert.equal(resolveTheme("dawn", true), "dawn");
  assert.equal(isDark("auto", true), true);
  assert.equal(isDark("paper", true), false);
  assert.equal(isDark("slate", false), true);
});
