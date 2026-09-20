// Themes. One axis: what it looks like. The id is written to
// <html data-theme>; every colour lives in web/index.html's CSS, keyed off
// that attribute, so a new look is a CSS block plus one entry here. This file
// touches no DOM so the tests can run it in node.
//
// The palettes are the surfaces a coder already sits in front of: the dark
// the editor shipped with, the paper the website is printed on, a cooler
// dark, and a warmer light. Not a rainbow — four, and each earns its name.

export const THEMES = [
  { id: "auto", label: "Auto", note: "Follows the system: moss after dark, paper by day" },
  { id: "moss", label: "Moss", note: "The dark the editor shipped with, mint on near-black", dark: true,
    swatch: { ground: "#101312", accent: "#6fd3b2" } },
  { id: "paper", label: "Paper", note: "The website's surface, green-grey paper", dark: false,
    swatch: { ground: "#f5f8f6", accent: "#0e7a58" } },
  { id: "slate", label: "Slate", note: "Cooler dark, blue accent, lower contrast", dark: true,
    swatch: { ground: "#14181d", accent: "#86adde" } },
  { id: "dawn", label: "Dawn", note: "Warm light, brown ink, for daylight rooms", dark: false,
    swatch: { ground: "#f7f3ea", accent: "#8a6a1f" } },
];

export const DEFAULT_THEME = "auto";
export const KEY = "fethr.theme";

const IDS = new Set(THEMES.map((t) => t.id));
export function isThemeId(v) {
  return typeof v === "string" && IDS.has(v);
}

// Anything unreadable falls back: a bad id must never stop the editor opening.
export function loadTheme(storage) {
  try {
    const v = storage.getItem(KEY);
    return isThemeId(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function saveTheme(storage, id) {
  try {
    storage.setItem(KEY, id);
  } catch { /* a lost preference is not worth an error */ }
}

// The concrete look for an id: "auto" becomes moss or paper by the system
// setting. Used to pick the CodeMirror styling, which has no CSS-only switch.
export function resolveTheme(id, prefersDark) {
  if (id === "auto") return prefersDark ? "moss" : "paper";
  return isThemeId(id) ? id : (prefersDark ? "moss" : "paper");
}

export function isDark(id, prefersDark) {
  const t = THEMES.find((x) => x.id === resolveTheme(id, prefersDark));
  return Boolean(t && t.dark);
}
