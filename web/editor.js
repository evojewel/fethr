// fethr editor UI — CodeMirror 6 core, bundled at publish time.

import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { THEMES, loadTheme, saveTheme, isDark } from "./theme.js";
import { loadPrefs } from "./prefs.js";
import { claimEsc } from "./keys.js";
import { mountHome } from "./home.js";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";

const langBy = (p) => {
  const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return javascript();
  if (["ts", "tsx"].includes(ext)) return javascript({ typescript: true });
  if (ext === "py") return python();
  if (["md", "markdown"].includes(ext)) return markdown();
  if (["html", "htm", "svg", "vue"].includes(ext)) return html();
  if (ext === "css") return css();
  if (ext === "json") return json();
  return [];
};

const $ = (s) => document.querySelector(s);
const langC = new Compartment();

// The per-launch token from the URL fragment (src/server.js). Every /api
// call carries it; without it the server answers 401.
const TOKEN = new URLSearchParams(location.hash.slice(1)).get("t") || "";
const f = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers || {}), "x-fethr-token": TOKEN } });

// Preferences (web/prefs.js): server-kept, so they survive a relaunch on a
// new port. Loaded before the theme is applied; body.booting hides the page
// until boot() runs. Same interface as localStorage.
const prefs = await loadPrefs(f);

// ---- theme (web/theme.js) ----
// Colours are CSS, keyed off <html data-theme>. CodeMirror is the one part
// that cannot follow a CSS variable for its syntax palette, so it gets
// oneDark on dark looks and its default light highlighting otherwise, with
// its surfaces pointed at the same tokens as the rest of the page.
const themeC = new Compartment();
const prefersDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : { matches: true, addEventListener() {} };
let themeId = loadTheme(prefs);
const surface = EditorView.theme({
  "&": { backgroundColor: "var(--bg)", color: "var(--ink)" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--muted)", borderRight: "1px solid var(--rule)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--panel) 70%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--panel)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)" },
});
const cmTheme = () => (isDark(themeId, prefersDark.matches) ? [oneDark, surface] : [surface]);
function applyTheme() {
  document.documentElement.dataset.theme = themeId;
  if (window.__fethrView) window.__fethrView.dispatch({ effects: themeC.reconfigure(cmTheme()) });
  for (const row of document.querySelectorAll("#viewmenu .row")) {
    row.setAttribute("aria-checked", row.dataset.id === themeId ? "true" : "false");
  }
}
document.documentElement.dataset.theme = themeId;
prefersDark.addEventListener("change", () => { if (themeId === "auto") applyTheme(); });
let current = null;
let dirty = false;

// Transport: fetch against the local server. In the native app shell (v0.3+)
// that server is a bundled Node sidecar the Rust side spawns and points the
// window at — same server.js, same origin-relative paths, so this file has
// no app-vs-CLI branching to carry.
import { decide, fetchManifest, isEnabled, ENABLED_KEY } from "./update.js";

const api = {
  meta: () => f("/api/meta").then((r) => r.json()),
  tree: () => f("/api/tree").then((r) => r.json()),
  read: async (p) => {
    const r = await f(`/api/file?p=${encodeURIComponent(p)}`);
    if (!r.ok) throw new Error("not found");
    return (await r.json()).content;
  },
  save: async (p, content) => {
    const r = await f(`/api/file?p=${encodeURIComponent(p)}`, { method: "PUT", body: content });
    if (!r.ok) throw new Error("save failed");
  },
  loadChat: () => f("/api/chat").then((r) => r.json()).catch(() => null),
  saveChat: (data) => f("/api/chat", { method: "PUT", body: JSON.stringify(data) }).catch(() => {}),
};

const setStatus = (t) => { $("#status").textContent = t; };

let autoSaveTimer = null;
function scheduleAutoSave() {
  if (!$("#autosave").checked) return;
  // While the disk banner asks Reload / Keep mine, an autosave would answer
  // for the person (and overwrite the agent's change). ⌘S still saves.
  if (!$("#disk-banner").hidden) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    if (dirty) save();
  }, 800);
}

// skipAutosave=true for agent-driven changes (accepted/auto-applied
// proposals): the "not written to disk until you ⌘S" boundary has to hold
// regardless of the auto-save setting, or it isn't a real boundary. Plain
// typing (the normal case) still autosaves as usual.
const markDirty = (d, skipAutosave) => {
  dirty = d;
  $("#file").textContent = current ? shortPath(current) + (d ? " •" : "") : "no file open";
  $("#file").title = current || "";
  if (d && !skipAutosave) scheduleAutoSave();
};

try {
  const v = prefs.getItem("fethr.autoSave");
  $("#autosave").checked = v === null ? true : v === "1"; // on by default
} catch { /* private mode — stays checked, just doesn't persist */ }
$("#autosave").onchange = () => {
  try {
    prefs.setItem("fethr.autoSave", $("#autosave").checked ? "1" : "0");
  } catch { /* ignore */ }
};

const view = new EditorView({
  parent: $("#editor"),
  state: EditorState.create({
    doc: "\n  fethr — pick a file on the left.\n",
    extensions: [basicSetup, themeC.of(cmTheme()), langC.of([])],
  }),
});
window.__fethrView = view; // test hook only — direct selection control for automated tests

// Set right before an agent-driven dispatch (applyProposal) so the change
// listener below — which fires for every dispatch, ours or the user's own
// typing — knows this particular one shouldn't schedule an autosave.
let suppressAutosaveOnce = false;

const extensions = () => [
  basicSetup,
  themeC.of(cmTheme()),
  langC.of(current ? langBy(current) : []),
  keymap.of([
    indentWithTab,
    { key: "Mod-s", preventDefault: true, run: () => (save(), true) },
  ]),
  EditorView.updateListener.of((u) => {
    if (u.docChanged) {
      markDirty(true, suppressAutosaveOnce);
      suppressAutosaveOnce = false;
    }
    if (u.docChanged || u.selectionSet) renderCtxBar();
  }),
];

async function openFile(p) {
  // Returns true iff `current` now genuinely points at `p` — callers that
  // go on to overwrite the buffer (applyProposal) must check this rather
  // than assume, or a proposal for a nonexistent/unreadable path would
  // silently overwrite whatever file happened to be open before it.
  if (dirty && !confirm(`Discard unsaved changes in ${current}?`)) return false;
  let content;
  try {
    content = await api.read(p);
  } catch {
    setStatus(`could not open ${p}`);
    return false;
  }
  current = p;
  $("#disk-banner").hidden = true;
  view.setState(EditorState.create({ doc: content, extensions: extensions() }));
  markDirty(false);
  setStatus("opened");
  document.querySelectorAll("#tree .active").forEach((n) => n.classList.remove("active"));
  const node = document.querySelector(`#tree [data-p="${CSS.escape(p)}"]`);
  if (node) node.classList.add("active");
  renderCtxBar();
  return true;
}

async function save() {
  if (!current) return;
  clearTimeout(autoSaveTimer);
  try {
    await api.save(current, view.state.doc.toString());
    markDirty(false);
    setStatus("saved");
    setTimeout(() => setStatus(""), 1500);
  } catch {
    setStatus("save failed");
  }
}

// Server/Rust both walk directories in pre-order (a dir's descendants
// immediately follow it, before its next sibling), so a single pass with a
// depth stack is enough to build the nested accordion — no second tree pass.
function renderTree(entries) {
  const el = $("#tree");
  // A refresh (the agent changed files) keeps what was folded and the scroll.
  const collapsed = new Set([...el.querySelectorAll(".dir-row.collapsed")].map((r) => r.dataset.dir));
  const scroll = el.scrollTop;
  el.innerHTML = "";
  const stack = [{ depth: 0, el }];
  for (const n of entries) {
    const depth = n.path.split("/").length;
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1].el;
    const name = n.path.split("/").pop();
    const row = document.createElement("div");
    row.style.paddingLeft = 8 + (depth - 1) * 14 + "px";
    if (n.dir) {
      row.className = "row dir-row";
      const chev = document.createElement("span");
      chev.className = "chev";
      chev.textContent = "▾";
      row.append(chev, document.createTextNode(name));
      const children = document.createElement("div");
      children.className = "children";
      row.dataset.dir = n.path;
      if (collapsed.has(n.path)) {
        row.classList.add("collapsed");
        children.classList.add("collapsed");
      }
      row.onclick = () => {
        row.classList.toggle("collapsed");
        children.classList.toggle("collapsed");
      };
      parent.append(row, children);
      stack.push({ depth, el: children });
    } else {
      row.className = "row file-row";
      row.textContent = name;
      row.dataset.p = n.path;
      row.onclick = () => openFile(n.path);
      if (n.path === current) row.classList.add("active");
      parent.appendChild(row);
    }
  }
  el.scrollTop = scroll;
}

let fileList = [];
let gitBranch = null; // real, server-checked — never let the agent guess this
// Home mode (docs/plans/home-screen.md): the server has no root, so boot()
// mounts web/home.js instead of the editor and the editor's shortcuts stand down.
let homeMode = false;
let workspaceRoot = null; // absolute; file-changed paths may come either way
let workspaceRealRoot = null; // the same folder with symlinks resolved

async function boot() {
  let meta;
  try {
    meta = await api.meta();
  } finally {
    document.body.classList.remove("booting");
  }
  if (meta.mode === "home") {
    homeMode = true;
    document.body.classList.add("home-mode");
    document.title = "fethr";
    const home = $("#home");
    home.hidden = false;
    return mountHome(home, { f, renderMd }); // renderMd escapes before it marks up
  }
  workspaceRoot = typeof meta.root === "string" ? meta.root : null;
  workspaceRealRoot = typeof meta.realRoot === "string" ? meta.realRoot : workspaceRoot;
  $("#root").textContent = meta.name;
  document.title = `${meta.name} — fethr`;
  gitBranch = meta.gitBranch || null;
  if (gitBranch) {
    $("#branch").textContent = gitBranch;
    $("#branch").title = `git branch: ${gitBranch} (checked, not guessed)`;
  }
  checkForUpdate(meta);
  const tree = await api.tree();
  fileList = tree.filter((n) => !n.dir).map((n) => n.path);
  renderTree(tree);
  // A window opened on a past session is about the conversation: it starts
  // agent-only (files hidden). Either kind of window remembers its own choice.
  setFilesHidden(loadFilesHidden(Boolean(meta.resume && meta.resume.id)));
  if (meta.resume && meta.resume.id) await resumeSession(meta.resume, meta.name);
  else await restoreChat();
}

window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});

// ---------- sidebar ----------

const syncSidebarIcon = () => {
  $("#toggle-sidebar").textContent = document.body.classList.contains("sidebar-collapsed") ? "›" : "‹";
};
const toggleSidebar = () => {
  document.body.classList.toggle("sidebar-collapsed");
  syncSidebarIcon();
  try {
    prefs.setItem(
      "fethr.sidebarCollapsed",
      document.body.classList.contains("sidebar-collapsed") ? "1" : "0"
    );
  } catch { /* private mode / storage blocked — just don't persist */ }
};
$("#toggle-sidebar").onclick = toggleSidebar;
try {
  if (prefs.getItem("fethr.sidebarCollapsed") === "1") {
    document.body.classList.add("sidebar-collapsed");
  }
} catch { /* ignore */ }
syncSidebarIcon();

window.addEventListener("keydown", (e) => {
  if (homeMode) return;
  if ((e.metaKey || e.ctrlKey) && e.key === "b") {
    e.preventDefault();
    toggleSidebar();
  }
});

// ---------- resizable panels — drag the divider between sidebar/editor/agent ----------

function makeResizer(handle, { cssVar, min, max, storageKey, beforeStart }) {
  let startX = 0, startW = 0;
  const onMove = (e) => {
    const dx = e.clientX - startX;
    const w = Math.min(max, Math.max(min, startW + dx));
    document.documentElement.style.setProperty(cssVar, w + "px");
  };
  const onUp = () => {
    handle.classList.remove("dragging");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10);
    try {
      prefs.setItem(storageKey, String(w));
    } catch { /* ignore */ }
  };
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (beforeStart) beforeStart();
    startX = e.clientX;
    startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10) || min;
    handle.classList.add("dragging");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

makeResizer($("#resize-sidebar"), {
  cssVar: "--sidebar-w",
  min: 160,
  max: 480,
  storageKey: "fethr.sidebarWidth",
  // Un-collapse first so the drag starts from a real, visible width — else
  // the baseline it reads (from :root, unaffected by the collapsed-state
  // CSS override on body) wouldn't match what's on screen.
  beforeStart: () => {
    if (document.body.classList.contains("sidebar-collapsed")) {
      document.documentElement.style.setProperty("--sidebar-w", "220px");
      document.body.classList.remove("sidebar-collapsed");
      syncSidebarIcon();
    }
  },
});
try {
  const w = parseInt(prefs.getItem("fethr.sidebarWidth"), 10);
  if (w >= 160 && w <= 480) document.documentElement.style.setProperty("--sidebar-w", w + "px");
} catch { /* ignore */ }

// No restore-on-load here (unlike the sidebar): --agent-w must stay at its
// 0px default while the panel is closed, or the grid would reserve empty
// space for it. toggleAgent() reads the saved width at the moment it opens.
makeResizer($("#resize-agent"), {
  cssVar: "--agent-w",
  min: 260,
  max: 640,
  storageKey: "fethr.agentWidth",
});

// ---------- agent panel ----------

let agentSession = null;
// True from a "fork" launch until the agent's init event hands back the new
// session id. Cleared there, not when the request is sent: a request that
// fails before init must not leave agentSession pointing at the original
// with no fork flag, or the next message would append to the original.
let pendingFork = false;
let streaming = false;

const chatEl = $("#chat");
const inputEl = $("#input");

// ---------- scroll-follow ----------
// New content scrolls the transcript only when the reader is already at the
// bottom (within FOLLOW_PX). Someone reading further up stays put and gets a
// "Latest ↓" pill instead.
const FOLLOW_PX = 48;
const latestBtn = $("#latest");
const nearBottom = () => chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight <= FOLLOW_PX;
function scrollChatToEnd() {
  chatEl.scrollTop = chatEl.scrollHeight;
  latestBtn.hidden = true;
}
function follow(change) {
  const stick = nearBottom();
  const out = change();
  if (stick) scrollChatToEnd();
  else latestBtn.hidden = false;
  return out;
}
latestBtn.onclick = () => {
  chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: "smooth" });
  latestBtn.hidden = true;
};
chatEl.addEventListener("scroll", () => { if (nearBottom()) latestBtn.hidden = true; });

// ---------- turn list (agent-only, wide windows): one row per prompt ----------
const turnsEl = $("#turns");
function addTurn(msgEl, text) {
  const b = document.createElement("button");
  b.type = "button";
  const n = document.createElement("span");
  n.className = "n";
  n.textContent = String(turnsEl.children.length + 1);
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = text;
  b.append(n, t);
  b.title = text.slice(0, 300);
  b.onclick = () => msgEl.scrollIntoView({ block: "start", behavior: "smooth" });
  turnsEl.appendChild(b);
}

// ---------- context bar — makes what's actually sent to the agent visible ----------
// The current file + live selection (auto), plus any files attached with @.

let mentions = [];

function renderCtxBar() {
  const bar = $("#ctx-bar");
  bar.innerHTML = "";
  if (current) {
    const sel = view.state.selection.main;
    let label = current;
    if (!sel.empty) {
      const l1 = view.state.doc.lineAt(sel.from).number;
      const l2 = view.state.doc.lineAt(sel.to).number;
      label += l1 === l2 ? `:${l1}` : `:${l1}-${l2}`;
    }
    const pill = document.createElement("span");
    pill.className = "ctx-pill";
    pill.textContent = label;
    pill.title = "Current file (and selection, if any) — sent automatically";
    bar.appendChild(pill);
  }
  for (const m of mentions) {
    const pill = document.createElement("span");
    pill.className = "ctx-pill mention";
    pill.title = "Attached file — sent with your next message";
    pill.appendChild(document.createTextNode(m));
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "Remove";
    x.onclick = () => {
      mentions = mentions.filter((p) => p !== m);
      renderCtxBar();
    };
    pill.appendChild(x);
    bar.appendChild(pill);
  }
  pendingImages.forEach((im, i) => {
    const pill = document.createElement("span");
    pill.className = "ctx-pill image";
    pill.title = `${im.name} — sent with your next message`;
    const img = document.createElement("img");
    img.src = im.url; // a data: URL; the CSP allows img-src data:
    img.alt = im.name;
    pill.appendChild(img);
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "Remove";
    x.onclick = () => {
      pendingImages.splice(i, 1);
      renderCtxBar();
    };
    pill.appendChild(x);
    bar.appendChild(pill);
  });
}

// ---------- images: paste or drop into the composer ----------
// Sent with the next message as image blocks (src/agent.js promptInput).
// Large images are scaled down here first: past ~1568px on the long edge the
// model downsamples anyway, and a smaller payload keeps under the API's 5 MB
// per-image limit. Saved chats keep only a count, never the image data.

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGES = 6;
const MAX_IMAGE_EDGE = 1568;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
let pendingImages = []; // { mediaType, data (base64), url (data: URL), name }

const readAsDataURL = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

async function prepareImage(file) {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error(`${file.name || "that file"} isn't a PNG, JPEG, GIF or WebP image`);
  let url = await readAsDataURL(file);
  let mediaType = file.type;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bmp.width, bmp.height));
  // Re-encode only when it helps: a GIF that is already small keeps its frames.
  if (scale < 1 || file.size > MAX_IMAGE_BYTES * 0.7) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    mediaType = file.type === "image/png" ? "image/png" : "image/jpeg";
    url = c.toDataURL(mediaType, 0.9);
    if (mediaType === "image/png" && url.length * 0.75 > MAX_IMAGE_BYTES) {
      mediaType = "image/jpeg"; // a big screenshot as PNG can still be too large
      url = c.toDataURL(mediaType, 0.9);
    }
  }
  bmp.close();
  const data = url.slice(url.indexOf(",") + 1);
  if (data.length * 0.75 > MAX_IMAGE_BYTES) throw new Error(`${file.name || "image"} is still over 5 MB after scaling down`);
  return { mediaType, data, url: `data:${mediaType};base64,${data}`, name: file.name || "pasted image" };
}

async function addImages(files) {
  for (const file of files) {
    if (pendingImages.length >= MAX_IMAGES) {
      setStatus(`at most ${MAX_IMAGES} images per message`);
      break;
    }
    try {
      pendingImages.push(await prepareImage(file));
    } catch (e) {
      setStatus(String(e.message || e));
    }
  }
  renderCtxBar();
}

const imageFiles = (list) => [...(list || [])].filter((f) => f.type && f.type.startsWith("image/"));

inputEl.addEventListener("paste", (e) => {
  const files = imageFiles([...(e.clipboardData?.items || [])].filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter(Boolean));
  if (!files.length) return; // plain text pastes as usual
  e.preventDefault();
  addImages(files);
});

const composerEl = $("#composer");
composerEl.addEventListener("dragover", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault();
  composerEl.classList.add("drop-target");
});
composerEl.addEventListener("dragleave", (e) => {
  if (!composerEl.contains(e.relatedTarget)) composerEl.classList.remove("drop-target");
});
composerEl.addEventListener("drop", (e) => {
  composerEl.classList.remove("drop-target");
  const files = imageFiles(e.dataTransfer?.files);
  if (!files.length) return;
  e.preventDefault();
  addImages(files);
});

// The thumbnails a sent message showed, kept only for this page's life.
function addImageThumbs(msgEl, imgs) {
  const row = document.createElement("div");
  row.className = "msg-images";
  for (const im of imgs) {
    const img = document.createElement("img");
    img.src = im.url;
    img.alt = im.name;
    img.title = im.name;
    row.appendChild(img);
  }
  msgEl.appendChild(row);
}

// ---------- @-mention: attach any workspace file as context ----------

const mentionMenu = $("#mention-menu");
let mentionMatches = [];
let mentionSel = -1;

function mentionQueryAt(text, pos) {
  const upto = text.slice(0, pos);
  const m = upto.match(/@([\w./-]*)$/);
  return m ? m[1] : null;
}

function showMentionMenu(query) {
  mentionMatches = fileList
    .filter((p) => p.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8);
  mentionSel = mentionMatches.length ? 0 : -1;
  if (!mentionMatches.length) return hideMentionMenu();
  mentionMenu.innerHTML = "";
  mentionMatches.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "row" + (i === mentionSel ? " sel" : "");
    row.textContent = p;
    row.onclick = () => pickMention(i);
    mentionMenu.appendChild(row);
  });
  mentionMenu.classList.add("open");
}

function hideMentionMenu() {
  mentionMenu.classList.remove("open");
  mentionMatches = [];
  mentionSel = -1;
}

function pickMention(i) {
  const p = mentionMatches[i];
  if (!p) return;
  const pos = inputEl.selectionStart;
  const upto = inputEl.value.slice(0, pos);
  const idx = upto.lastIndexOf("@");
  inputEl.value = inputEl.value.slice(0, idx) + inputEl.value.slice(pos);
  inputEl.selectionStart = inputEl.selectionEnd = idx;
  if (!mentions.includes(p)) mentions.push(p);
  renderCtxBar();
  hideMentionMenu();
  inputEl.focus();
}

inputEl.addEventListener("input", () => {
  const q = mentionQueryAt(inputEl.value, inputEl.selectionStart);
  if (q !== null) showMentionMenu(q);
  else hideMentionMenu();
});

// ---------- voice input ----------
// macOS system dictation (press Fn twice) already works in this field for
// free, no code needed — this button adds a visible, explicit alternative
// with live partial transcription, for browsers that support it.

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = $("#mic");
if (!SpeechRec) {
  micBtn.disabled = true;
  micBtn.title = "Voice input isn't supported in this browser — macOS dictation (press Fn twice) still works here.";
} else {
  let recognizing = false;
  let recog = null;
  micBtn.onclick = () => {
    if (recognizing) {
      recog.stop();
      return;
    }
    const base = inputEl.value ? inputEl.value.replace(/\s+$/, "") + " " : "";
    recog = new SpeechRec();
    recog.continuous = true;
    recog.interimResults = true;
    recog.onresult = (e) => {
      let finalText = base, interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript + " ";
        else interim += r[0].transcript;
      }
      inputEl.value = finalText + interim;
    };
    recog.onerror = () => {
      recognizing = false;
      micBtn.classList.remove("recording");
    };
    recog.onend = () => {
      recognizing = false;
      micBtn.classList.remove("recording");
    };
    recog.start();
    recognizing = true;
    micBtn.classList.add("recording");
  };
}

const toggleAgent = () => {
  const opening = !document.body.classList.contains("agent-open");
  document.body.classList.toggle("agent-open");
  if (opening) {
    let w = 340;
    try {
      const saved = parseInt(prefs.getItem("fethr.agentWidth"), 10);
      if (saved >= 260 && saved <= 640) w = saved;
    } catch { /* ignore */ }
    document.documentElement.style.setProperty("--agent-w", w + "px");
    inputEl.focus();
  } else {
    document.documentElement.style.setProperty("--agent-w", "0px");
  }
};
$("#toggle-agent").onclick = () => {
  // Closing the agent while the files are hidden would leave nothing on
  // screen, so bring the files back with it.
  if (document.body.classList.contains("agent-open") && filesHidden()) setFilesHidden(false);
  toggleAgent();
};

// ---------- files view: show/hide the sidebar + editor (⌘E) ----------
// Agent-only is a class: it owns visibility and the grid's track list only.
// Widths stay JS-owned (--agent-w is set by toggleAgent), per ARCHITECTURE.md's
// custom-property cascade trap. Remembered per window in sessionStorage.
const FILES_KEY = "fethr.filesHidden";
const filesHidden = () => document.body.classList.contains("files-hidden");
function loadFilesHidden(fallback) {
  try {
    const v = sessionStorage.getItem(FILES_KEY);
    if (v === "1" || v === "0") return v === "1";
  } catch { /* storage blocked: use the window's default */ }
  return fallback;
}
function setFilesHidden(hide) {
  if (!hide && document.body.classList.contains("focus-mode")) setFocus(false);
  document.body.classList.toggle("files-hidden", hide);
  if (hide && !document.body.classList.contains("agent-open")) toggleAgent();
  $("#toggle-files").setAttribute("aria-pressed", String(!hide));
  $("#toggle-files").title = hide ? "Show files and the editor (⌘E)" : "Hide files and the editor: the agent takes the window (⌘E)";
  try {
    sessionStorage.setItem(FILES_KEY, hide ? "1" : "0");
  } catch { /* not remembered, still applied */ }
  if (!hide) view.requestMeasure(); // CodeMirror measured nothing while hidden
}
$("#toggle-files").onclick = () => setFilesHidden(!filesHidden());

// ---------- focus: agent-only with no chrome, only transcript + composer ----------
// ⌘⇧F or the header's "focus" button; the corner button or Esc leaves it.
const inFocus = () => document.body.classList.contains("focus-mode");
function setFocus(on) {
  if (on && !filesHidden()) setFilesHidden(true);
  document.body.classList.toggle("focus-mode", on);
  $("#exit-focus").hidden = !on;
  if (on) inputEl.focus();
}
$("#focus-btn").onclick = () => setFocus(true);
$("#exit-focus").onclick = () => setFocus(false);
window.addEventListener("keydown", (e) => {
  if (homeMode) return;
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    setFocus(!inFocus());
  } else if (e.key === "Escape" && inFocus() && claimEsc(e)) {
    setFocus(false); // registered on window: anything nearer claimed Esc first
  }
});
window.addEventListener("keydown", (e) => {
  if (homeMode) return;
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "e") {
    e.preventDefault();
    setFilesHidden(!filesHidden());
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "j") {
    e.preventDefault();
    toggleAgent();
  }
});

function addMsg(cls, who, text) {
  const d = document.createElement("div");
  d.className = "msg " + cls;
  if (who) {
    const w = document.createElement("span");
    w.className = "who";
    w.textContent = who;
    d.appendChild(w);
  }
  d.appendChild(document.createTextNode(text));
  follow(() => chatEl.appendChild(d));
  return d;
}

// Minimal line diff (LCS) for proposal preview.
function lineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  const m = A.length, n = B.length;
  if (m * n > 400000) return null; // too big to diff cheaply — show summary only
  const L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push(["=", A[i]]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push(["-", A[i]]); i++; }
    else { out.push(["+", B[j]]); j++; }
  }
  while (i < m) out.push(["-", A[i++]]);
  while (j < n) out.push(["+", B[j++]]);
  return out;
}

async function applyProposal(p) {
  if (p.path !== current) {
    const opened = await openFile(p.path);
    if (!opened) {
      setStatus(`proposal for ${p.path} not applied — couldn't open that file`);
      return false;
    }
  }
  suppressAutosaveOnce = true;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: p.content } });
  markDirty(true, true); // belt-and-suspenders in case the dispatch above didn't fire docChanged
}

function renderProposal(p, opts = {}) {
  const { live = false } = opts; // live=false for proposals redisplayed from chat history — never auto-applied
  const box = document.createElement("div");
  box.className = "proposal";
  const head = document.createElement("div");
  head.className = "phead";
  // p.path/p.note come from the agent's tool call — never trust them as HTML.
  const b = document.createElement("b");
  b.textContent = "propose_edit";
  head.appendChild(b);
  head.appendChild(document.createTextNode(" " + p.path + (p.note ? " — " + p.note : "")));
  box.appendChild(head);

  const pre = document.createElement("pre");
  const oldContent = p.path === current ? view.state.doc.toString() : null;
  if (oldContent !== null) {
    const diff = lineDiff(oldContent, p.content);
    if (diff) {
      for (const [op, line] of diff) {
        if (op === "=") continue;
        const s = document.createElement("span");
        s.className = op === "+" ? "add" : "del";
        s.textContent = (op === "+" ? "+ " : "- ") + line + "\n";
        pre.appendChild(s);
      }
      if (!pre.childNodes.length) pre.textContent = "(no changes)";
    } else {
      pre.textContent = p.content.slice(0, 4000);
    }
  } else {
    pre.textContent = p.content.slice(0, 4000);
  }
  box.appendChild(pre);

  const actions = document.createElement("div");
  actions.className = "pactions";

  if (live && $("#auto").checked) {
    actions.textContent = "applying…";
    applyProposal(p).then((ok) => {
      actions.textContent = ok === false ? "couldn't apply — file not found" : "auto-applied — review and ⌘S to save";
    });
  } else {
    if (!live) {
      const note = document.createElement("div");
      note.className = "pnote";
      note.textContent = "from an earlier session — review before applying";
      box.appendChild(note); // appended before `actions` below, so it lands between diff and buttons
    }
    const accept = document.createElement("button");
    accept.className = "accept";
    accept.textContent = "Accept";
    const reject = document.createElement("button");
    reject.textContent = "Reject";
    const done = (label) => {
      actions.textContent = label;
    };
    accept.onclick = async () => {
      const ok = await applyProposal(p);
      done(ok === false ? "couldn't apply — file not found" : "accepted — review and ⌘S to save");
    };
    reject.onclick = () => done("rejected");
    actions.append(accept, reject);
  }
  box.appendChild(actions);
  follow(() => chatEl.appendChild(box));
}

// Minimal safe markdown: escape everything, then fences / file:line refs /
// inline code / bold. File refs run before inline-code so `file.js:12` in
// backticks (how Claude usually writes them) still becomes clickable; the
// inline-code regex excludes `<` so it never re-wraps the anchor it made.
function renderMd(el, raw) {
  const esc = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Fences out first (their lines are not headings or lists), blocks on the
  // escaped text, fences back before the inline rules as before.
  const fences = [];
  const fenceRaw = []; // each block's own text, for its copy button
  let html = esc.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    const i = fences.push(`<div class="code-block"><pre data-fence="${fenceRaw.length}">${code}</pre></div>`) - 1;
    fenceRaw.push(code.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\n$/, ""));
    return `\u0000${i}\u0000`;
  });
  html = mdBlocks(html);
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => fences[Number(i)]);
  html = html.replace(/\b([\w./-]+\.\w+):(\d+)(-\d+)?\b/g, (m, p, l1, l2) => {
    if (!fileList.includes(p) && !fileList.some((f) => f.endsWith("/" + p))) return m;
    return `<a href="#" class="fileref" data-p="${p}" data-l1="${l1}" data-l2="${l2 ? l2.slice(1) : ""}">${m}</a>`;
  });
  html = html.replace(/`([^`\n<]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  el.innerHTML = html;
  // The copy button carries the block's original text: the inline rules above
  // also run inside code blocks, so the displayed text can differ (** → bold).
  el.querySelectorAll("pre[data-fence]").forEach((pre) => addCopyButton(pre, fenceRaw[Number(pre.dataset.fence)] ?? pre.textContent));
}

// ---------- copy button on code blocks ----------
const COPY_SVG =
  '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M11 3.5V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6.5A1.5 1.5 0 0 0 3 11h.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>' +
  '<svg class="ok" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// The async clipboard API first; the older execCommand path if the webview
// refuses it. Returns whether the text reached the clipboard.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* refused */ }
  ta.remove();
  return ok;
}

function addCopyButton(pre, text) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "copy-code";
  b.title = "Copy";
  b.setAttribute("aria-label", "Copy code");
  b.innerHTML = COPY_SVG; // a fixed string, never transcript text
  let timer = null;
  b.onclick = async () => {
    const ok = await copyText(text);
    if (!ok) {
      // Couldn't reach the clipboard: select the block so ⌘C still works.
      const r = document.createRange();
      r.selectNodeContents(pre);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    b.classList.toggle("done", ok);
    b.title = ok ? "Copied" : "Selected — press ⌘C";
    clearTimeout(timer);
    timer = setTimeout(() => { b.classList.remove("done"); b.title = "Copy"; }, 1500);
  };
  pre.parentNode.appendChild(b);
}

// GitHub-style tables: a header row, a delimiter row (---, :--, :-:, --:),
// then body rows. Cells are already escaped; only fixed tags and one of three
// fixed alignment classes are added. \| inside a cell is a literal pipe.
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
function tableCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
function mdTable(head, delim, rows) {
  const aligns = tableCells(delim).map((d) =>
    d.startsWith(":") && d.endsWith(":") ? "a-c" : d.endsWith(":") ? "a-r" : "");
  const cell = (tag, text, i) => `<${tag}${aligns[i] ? ` class="${aligns[i]}"` : ""}>${text}</${tag}>`;
  const width = aligns.length;
  const row = (cells, tag) => {
    const padded = cells.slice(0, width);
    while (padded.length < width) padded.push("");
    return `<tr>${padded.map((c, i) => cell(tag, c, i)).join("")}</tr>`;
  };
  return `<div class="md-table"><table><thead>${row(tableCells(head), "th")}</thead>` +
    `<tbody>${rows.map((r) => row(tableCells(r), "td")).join("")}</tbody></table></div>`;
}

// Block markdown on already-escaped text: # to ### headings, - / * and 1.
// lists, > quotes (">" arrives escaped as &gt;), tables. Only fixed tags, a
// digits-only start= and fixed alignment classes are added, so nothing from
// the text becomes markup.
function mdBlocks(text) {
  const out = [];
  let list = null, quote = null;
  const flush = () => {
    if (list) out.push(`<${list.tag}${list.start > 1 ? ` start="${list.start}"` : ""}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
    if (quote) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    list = quote = null;
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (line.includes("|") && i + 1 < lines.length && TABLE_DELIM_RE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flush();
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim()) rows.push(lines[j++]);
      out.push(mdTable(line, lines[i + 1], rows));
      i = j - 1;
    } else if ((m = line.match(/^(#{1,3}) +(.+)$/))) {
      flush();
      const tag = "h" + (m[1].length + 2); // h3–h5: inside a message, never louder than the page
      out.push(`<${tag}>${m[2]}</${tag}>`);
    } else if ((m = line.match(/^\s*[-*] +(.+)$/))) {
      if (!list || list.tag !== "ul") { flush(); list = { tag: "ul", items: [] }; }
      list.items.push(m[1]);
    } else if ((m = line.match(/^\s*(\d{1,4})[.)] +(.+)$/))) {
      if (!list || list.tag !== "ol") { flush(); list = { tag: "ol", start: Number(m[1]), items: [] }; }
      list.items.push(m[2]);
    } else if ((m = line.match(/^&gt; ?(.*)$/))) {
      if (!quote) { flush(); quote = []; }
      quote.push(m[1]);
    } else {
      flush();
      out.push(line + "\n");
    }
  }
  flush();
  return out.join("").replace(/\n$/, "");
}

async function jumpToFileRef(p, l1raw, l2raw) {
  const target = fileList.includes(p) ? p : fileList.find((f) => f.endsWith("/" + p));
  if (!target) return setStatus(`${p} not in this workspace`);
  if (target !== current) await openFile(target);
  const line1 = parseInt(l1raw, 10);
  const line2 = l2raw ? parseInt(l2raw, 10) : line1;
  const doc = view.state.doc;
  if (!(line1 >= 1 && line1 <= doc.lines)) return;
  const from = doc.line(line1).from;
  const to = doc.line(Math.min(line2, doc.lines)).to;
  view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
  view.focus();
}

chatEl.addEventListener("click", (e) => {
  const a = e.target.closest("a.fileref");
  if (!a) return;
  e.preventDefault();
  jumpToFileRef(a.dataset.p, a.dataset.l1, a.dataset.l2);
});

// ---------- chat history — persisted to .fethr/chat.json in the workspace ----------
// A plain project file, not browser storage: it survives across separate
// launches even though the local server's port (and therefore origin) is
// random each time, and it's something the user can see or delete like any
// other file (already hidden from the sidebar — dotfiles are skipped there).

let transcript = [];

// A window opened on a past session (resumeSession) never writes chat.json:
// that session lives in ~/.claude/projects and is reachable from home, and
// writing here would replace the folder's own conversation.
let resumeMode = false;
let resumedId = null; // the original session's id, kept after a fork replaces agentSession
let resumedSource = null; // where it was started ("CLI", "VS Code / Cursor", …), sent with every request

function persistChat() {
  if (resumeMode) return;
  api.saveChat({ session: agentSession, entries: transcript });
}

// live=true only for entries just received over the live SSE stream (via
// recordAndAdd). Entries replayed by restoreChat() are always live=false —
// a proposal must never auto-apply itself just because it's being
// redisplayed and the Auto checkbox happens to be on right now.
function renderEntry(entry, live = false) {
  if (entry.type === "user") {
    const el = addMsg("user", "you", entry.text);
    if (entry.images && !live) {
      // Saved chats keep the count, not the image data.
      const n = document.createElement("div");
      n.className = "msg-images-note";
      n.textContent = entry.images === 1 ? "[1 image]" : `[${entry.images} images]`;
      el.appendChild(n);
    }
    addTurn(el, entry.text || (entry.images ? "[image]" : ""));
    return el;
  }
  if (entry.type === "assistant") {
    const el = addMsg("assistant", "agent", "");
    renderMd(el, entry.text);
    return el;
  }
  if (entry.type === "thought") {
    const box = document.createElement("details");
    box.className = "thought";
    box.innerHTML = "<summary>thought</summary><div class='ttext'></div>";
    box.querySelector(".ttext").textContent = entry.text;
    follow(() => chatEl.appendChild(box));
    return box;
  }
  if (entry.type === "tool") return entry.text.startsWith("⚙ ") ? addToolStep(entry.text) : addMsg("tool", null, entry.text);
  if (entry.type === "proposal") return renderProposal(entry, { live });
}

// ---------- tool steps: short paths, consecutive steps folded into one row ----------
// A run of Read/Grep/Bash calls used to print one full-width line each, with
// absolute paths. Now consecutive steps share one row that shows the latest
// step and a count, and expands to the list. Full text stays in the tooltip.
const MAX_PATH_SHOWN = 48;
function shortPath(p) {
  let s = p;
  for (const r of [workspaceRoot, workspaceRealRoot]) {
    if (r && s.startsWith(r + "/")) { s = s.slice(r.length + 1); break; }
  }
  if (s.length <= MAX_PATH_SHOWN) return s;
  const parts = s.split("/");
  if (parts.length <= 3) return s;
  const head = parts[0] === "" ? "/" + parts[1] : parts[0];
  return `${head}/…/${parts.slice(-2).join("/")}`;
}
const shortStep = (text) => text.split(" ").map((t) => (t.includes("/") ? shortPath(t) : t)).join(" ");

function addToolStep(text) {
  const last = chatEl.lastElementChild;
  let group = last && last.classList.contains("tool-group") ? last : null;
  if (!group) {
    group = document.createElement("details");
    group.className = "msg tool tool-group single";
    const sum = document.createElement("summary");
    const lastEl = document.createElement("span");
    lastEl.className = "last";
    const count = document.createElement("span");
    count.className = "count";
    sum.append(lastEl, count);
    // One step has nothing to expand.
    sum.addEventListener("click", (e) => { if (group.classList.contains("single")) e.preventDefault(); });
    const lines = document.createElement("div");
    lines.className = "lines";
    group.append(sum, lines);
    follow(() => chatEl.appendChild(group));
  }
  const short = shortStep(text.slice(2)); // the row draws its own ⚙ or ▸
  const line = document.createElement("div");
  line.textContent = short;
  line.title = text;
  const lines = group.querySelector(".lines");
  follow(() => lines.appendChild(line));
  const n = lines.children.length;
  group.classList.toggle("single", n === 1);
  const lastEl = group.querySelector(".last");
  lastEl.textContent = short;
  lastEl.title = text;
  group.querySelector(".count").textContent = n > 1 ? ` · ${n} steps` : "";
  return group;
}

function recordAndAdd(entry) {
  transcript.push(entry);
  persistChat();
  return renderEntry(entry, true);
}

async function restoreChat() {
  const saved = await api.loadChat();
  if (!saved || !Array.isArray(saved.entries) || !saved.entries.length) return;
  agentSession = saved.session || null;
  for (const e of saved.entries) {
    transcript.push(e);
    renderEntry(e); // live defaults false
  }
  addMsg("tool", null, "— restored earlier conversation —");
}

// Launched with --session (meta.resume): show that session's history from
// ~/.claude/projects instead of .fethr/chat.json, and point the agent at it.
// History text is untrusted; renderEntry renders it as text or escaped md.
const HISTORY_TYPES = new Set(["user", "assistant", "tool"]);
async function resumeSession(resume, folder) {
  resumeMode = true;
  resumedId = resume.id;
  agentSession = resume.id;
  pendingFork = Boolean(resume.fork);
  resumedSource = typeof resume.source === "string" ? resume.source : null;
  const title = resume.title || "untitled session";
  const label = `${title} · ${resume.id.slice(0, 8)} · ${folder}`;
  document.title = `${label} — fethr`;
  $("#agent-title").textContent = label;
  $("#agent-title").title = `${resume.fork ? "Forked from" : "Resumed"} session ${resume.id} in ${folder}`;
  let hist = null, why = "server not answering";
  try {
    const r = await f(`/api/session-history?id=${encodeURIComponent(resume.id)}`);
    const data = await r.json().catch(() => null);
    if (r.ok) hist = data;
    else why = (data && data.error) || `error ${r.status}`;
  } catch { /* why stays as set */ }
  if (!resumedSource && hist && typeof hist.source === "string") resumedSource = hist.source;
  if (!hist || !Array.isArray(hist.entries)) {
    addMsg("tool", null, `— couldn't load this session's earlier turns: ${hist ? "unreadable reply" : why} —`);
  } else {
    if (hist.omitted > 0) addMsg("tool", null, `— ${hist.omitted} earlier turns not shown —`);
    else if (hist.truncated) addMsg("tool", null, "— earlier turns not shown —");
    for (const e of hist.entries) {
      if (!e || !HISTORY_TYPES.has(e.type) || typeof e.text !== "string") continue;
      const entry = { type: e.type, text: e.type === "tool" ? `⚙ ${e.text}` : e.text };
      transcript.push(entry);
      renderEntry(entry); // live defaults false
    }
  }
  addMsg("tool", null, pendingFork ? `— forked from: ${title} (original untouched) —` : `— resumed session: ${title} —`);
  if (!document.body.classList.contains("agent-open")) toggleAgent();
}

const statusEl = document.querySelector("#agent-status");
const phaseEl = $("#phase");
let abortCtl = null;

function setPhase(label) {
  if (label) {
    statusEl.classList.add("on");
    phaseEl.textContent = label;
  } else {
    statusEl.classList.remove("on");
  }
}

$("#stop").onclick = () => abortCtl && abortCtl.abort();

$("#model").onchange = () => {
  agentSession = null;
  pendingFork = false;
  addMsg("tool", null, `model → ${$("#model").value || "default"} (new conversation)`);
};

try {
  $("#auto").checked = prefs.getItem("fethr.autoApply") === "1";
} catch { /* ignore */ }
$("#auto").onchange = () => {
  try {
    prefs.setItem("fethr.autoApply", $("#auto").checked ? "1" : "0");
  } catch { /* ignore */ }
};

// fable 5 isn't detectable ahead of time without an extra probe call (the
// Agent SDK runs on the machine's Claude Code login, not a raw API key, so
// there's no cheap models.list() here) — show it optimistically and fold on
// the first real failure instead of paying a probe on every panel open.
function markFableUnavailable() {
  const opt = document.querySelector("#model option[value='fable']");
  if (opt) {
    opt.disabled = true;
    opt.textContent = "fable 5 (unavailable)";
  }
  $("#model").value = "";
  agentSession = null;
  pendingFork = false;
  addMsg("tool", null, "fable 5 isn't available on this account — switched back to default.");
}

// ---------- agent mode: read-only (default) or full ----------
// Full is Claude Code in its auto permission mode (server side): tools run
// without asking and a classifier may block risky ones. Opt-in per window,
// remembered only for this window (sessionStorage). Switching keeps the
// session; the next message uses the new mode.
const MODE_KEY = "fethr.agentMode";
const READONLY_NOTE = $("#composer-note").textContent;
let agentMode = "readonly";
try {
  if (sessionStorage.getItem(MODE_KEY) === "full") agentMode = "full";
} catch { /* storage blocked: read-only */ }
function applyMode() {
  const full = agentMode === "full";
  document.body.classList.toggle("agent-full", full);
  $("#mode-note").hidden = !full;
  $("#composer-note").textContent = full
    ? "Full Claude Code: reads, edits and runs commands in this folder without asking. Uses your Claude Code login."
    : READONLY_NOTE;
  for (const b of document.querySelectorAll("#mode button")) {
    b.setAttribute("aria-checked", String(b.dataset.mode === agentMode));
  }
}
function setMode(mode) {
  if (mode === agentMode) return;
  agentMode = mode;
  try {
    sessionStorage.setItem(MODE_KEY, mode);
  } catch { /* applied, not remembered */ }
  applyMode();
  addMsg("tool", null, `mode → ${mode === "full" ? "full" : "read-only"} (from the next message; same conversation)`);
}
for (const b of document.querySelectorAll("#mode button")) b.onclick = () => setMode(b.dataset.mode);
applyMode();

// ---------- keeping the editor in step with what the agent changed ----------
// The open file: reloaded in place when the buffer is clean, a Reload / Keep
// mine banner when it has unsaved edits. The tree: re-fetched, folds kept.
async function syncOpenFile() {
  if (!current) return;
  const p = current;
  let disk;
  try {
    disk = await api.read(p);
  } catch {
    return; // deleted or unreadable: leave the buffer alone
  }
  if (p !== current || disk === view.state.doc.toString()) return;
  if (dirty) {
    $("#disk-banner").hidden = false;
    clearTimeout(autoSaveTimer);
    return;
  }
  replaceBuffer(disk);
  setStatus("updated by agent");
  setTimeout(() => { if ($("#status").textContent === "updated by agent") setStatus(""); }, 2500);
}

// Swap in the disk content without counting it as an edit, keeping the
// cursor (clamped) and the scroll position.
function replaceBuffer(content) {
  const sel = view.state.selection.main;
  const top = view.scrollDOM.scrollTop;
  view.setState(EditorState.create({ doc: content, extensions: extensions() }));
  const len = view.state.doc.length;
  view.dispatch({ selection: { anchor: Math.min(sel.anchor, len), head: Math.min(sel.head, len) } });
  view.scrollDOM.scrollTop = top;
  markDirty(false);
  $("#disk-banner").hidden = true;
}

$("#disk-reload").onclick = async () => {
  try {
    replaceBuffer(await api.read(current));
    setStatus("reloaded from disk");
  } catch {
    setStatus(`could not read ${current}`);
  }
};
$("#disk-keep").onclick = () => {
  $("#disk-banner").hidden = true; // the next save writes yours over the agent's
  scheduleAutoSave();
};

function relPath(p) {
  const s = String(p || "");
  if (workspaceRoot && s.startsWith(workspaceRoot + "/")) return s.slice(workspaceRoot.length + 1);
  return s.replace(/^\.\//, "");
}

let treeTimer = null;
function refreshWorkspace() {
  clearTimeout(treeTimer);
  treeTimer = setTimeout(async () => {
    try {
      const tree = await api.tree();
      fileList = tree.filter((n) => !n.dir).map((n) => n.path);
      renderTree(tree);
    } catch { /* keep the old tree */ }
    syncOpenFile();
  }, 150);
}

// Tell the server which chat this folder is on (home's Recent list shows it),
// once per session id, including the new id a fork gets. Fire-and-forget.
const reportedSessions = new Set();
function reportRecentSession(id) {
  if (!id || reportedSessions.has(id)) return;
  reportedSessions.add(id);
  f("/api/recent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: id }),
  }).catch(() => {});
}

async function askAgent(prompt, images = []) {
  streaming = true;
  abortCtl = new AbortController();
  const selectedModel = $("#model").value || undefined;
  let sawSession = false;
  let sawError = false; // an error/ended/stopped line already explains a missing reply
  let doneDetail = null;
  let replyNote = false; // the bubble got a plain-text error instead of a reply
  let stopped = false; // the stop button: queued messages go back to the composer
  const runMode = agentMode; // a switch mid-run applies from the next message
  const userEl = recordAndAdd({ type: "user", text: prompt, ...(images.length ? { images: images.length } : {}) });
  if (images.length) addImageThumbs(userEl, images);
  scrollChatToEnd(); // your own message always brings you to the bottom
  const reply = addMsg("assistant", "agent", "");
  let replyRaw = "";
  let thoughtBox = null, thoughtRaw = "";
  setPhase("thinking…");

  const context = current
    ? {
        path: current,
        content: view.state.doc.length < 100000 ? view.state.doc.toString() : "",
        selection: view.state.sliceDoc(
          view.state.selection.main.from,
          view.state.selection.main.to
        ) || undefined,
      }
    : undefined;

  const attached = mentions.slice();
  mentions = [];
  renderCtxBar();
  const extraFiles = attached.length
    ? await Promise.all(attached.map(async (p) => ({ path: p, content: await api.read(p).catch(() => "") })))
    : undefined;

  try {
    const r = await f("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: abortCtl.signal,
      body: JSON.stringify({
        prompt,
        sessionId: agentSession,
        fork: pendingFork && Boolean(agentSession),
        context,
        extraFiles,
        gitBranch,
        model: selectedModel,
        mode: runMode,
        ...(images.length ? { images: images.map(({ mediaType, data }) => ({ mediaType, data })) } : {}),
        ...(resumeMode ? { resumed: { source: resumedSource } } : {}),
      }),
    });
    if (!r.ok || !r.body) {
      const err = await r.json().catch(() => ({}));
      if (selectedModel === "fable") { sawError = true; return markFableUnavailable(); }
      reply.appendChild(document.createTextNode(err.error || `agent error (${r.status})`));
      replyNote = true;
      return;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!chunk.startsWith("data: ")) continue;
        const ev = JSON.parse(chunk.slice(6));
        if (ev.type === "session") {
          agentSession = ev.id;
          pendingFork = false;
          sawSession = true;
          reportRecentSession(ev.id);
        } else if (ev.type === "delta") {
          replyRaw += ev.text;
          follow(() => { reply.textContent = replyRaw; });
          setPhase("writing…");
        } else if (ev.type === "thinking") {
          if (!thoughtBox) {
            thoughtBox = document.createElement("details");
            thoughtBox.className = "thought";
            thoughtBox.innerHTML = "<summary>thinking…</summary><div class='ttext'></div>";
            reply.parentNode.insertBefore(thoughtBox, reply);
          }
          thoughtRaw += ev.text;
          follow(() => { thoughtBox.querySelector(".ttext").textContent = thoughtRaw; });
          setPhase("thinking…");
        } else if (ev.type === "phase") {
          setPhase(ev.phase === "thinking" ? "thinking…" : "writing…");
        } else if (ev.type === "tool") {
          setPhase(`${ev.name}…`);
          recordAndAdd({ type: "tool", text: `⚙ ${ev.name}${ev.detail ? " " + ev.detail : ""}` });
        } else if (ev.type === "proposal") {
          recordAndAdd({ type: "proposal", path: ev.path, content: ev.content, note: ev.note });
        } else if (ev.type === "file-changed") {
          if (ev.outside) recordAndAdd({ type: "tool", text: `changed outside this folder: ${ev.path}` });
          else if (relPath(ev.path) === current) syncOpenFile();
          else refreshWorkspace(); // maybe a new file: the tree should show it
        } else if (ev.type === "maybe-changed") {
          refreshWorkspace();
        } else if (ev.type === "tool-denied") {
          recordAndAdd({ type: "tool", text: `blocked: ${ev.name}${ev.detail ? " — " + ev.detail : ""}` });
        } else if (ev.type === "error") {
          sawError = true;
          if (selectedModel === "fable" && !sawSession) markFableUnavailable();
          else offerForkIfBusy(recordAndAdd({ type: "tool", text: `error: ${ev.message}` }));
        } else if (ev.type === "done" && ev.ok && typeof ev.detail === "string") {
          doneDetail = ev.detail;
        } else if (ev.type === "done" && !ev.ok) {
          sawError = true;
          if (selectedModel === "fable" && !sawSession) markFableUnavailable();
          else offerForkIfBusy(recordAndAdd({ type: "tool", text: `ended: ${ev.error}${ev.detail ? " — " + ev.detail : ""}` }));
        }
      }
    }
  } catch (e) {
    sawError = true;
    if (e.name === "AbortError") stopped = true;
    if (e.name === "AbortError") recordAndAdd({ type: "tool", text: "stopped" });
    else recordAndAdd({ type: "tool", text: `agent unreachable: ${e.message}` });
  } finally {
    if (replyRaw) {
      follow(() => renderMd(reply, replyRaw));
      transcript.push({ type: "assistant", text: replyRaw });
    } else if (!replyNote) {
      // Never leave an empty agent bubble: say why there is no text, or drop
      // it when an error line below already does.
      if (sawError && !doneDetail) reply.remove();
      else {
        reply.classList.add("no-reply");
        follow(() => reply.appendChild(document.createTextNode(doneDetail || "no reply")));
      }
    }
    if (thoughtBox) {
      thoughtBox.querySelector("summary").textContent = "thought";
      transcript.push({ type: "thought", text: thoughtRaw });
    }
    if (replyRaw || thoughtBox) persistChat();
    if (runMode === "full") refreshWorkspace(); // a full run may have changed anything
    setPhase(null);
    streaming = false;
    abortCtl = null;
    drainQueue(stopped);
  }
}

// A resumed session that Claude Code is still running (a background session,
// or one open in a terminal) cannot be resumed here; the CLI says so and
// suggests --fork-session. Offer that as one click: a new window on a fork,
// leaving the original alone. Matching the CLI's wording is a fallback only:
// the home screen already disables Resume for sessions the server reports as
// open, and this catches the ones it could not see (opened after the list
// loaded, or not reported). If the wording changes, the button just doesn't
// appear and the plain error remains.
const BUSY_SESSION_RE = /running in the background|--fork-session/;
// "running in the background (abcdef12)" names a background session; only
// then is attaching an option (the `claude attach` command is background-only).
const BACKGROUND_ID_RE = /running in the background \(([0-9a-f]{8})/;
function offerForkIfBusy(msgEl) {
  if (!resumeMode || !resumedId || !msgEl || !BUSY_SESSION_RE.test(msgEl.textContent)) return;
  const bg = msgEl.textContent.match(BACKGROUND_ID_RE);
  const row = document.createElement("div");
  row.className = "fork-offer";
  const note = document.createElement("span");
  const offer = (label, title, url, body, done, failed) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.title = title;
    btn.onclick = async () => {
      btn.disabled = true;
      note.textContent = "opening…";
      try {
        const r = await f(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && (data.ok || data.pending)) {
          note.textContent = done;
          return;
        }
        note.textContent = failed(r, data);
      } catch {
        note.textContent = "server not answering";
      }
      btn.disabled = false;
    };
    return btn;
  };
  const why = (r, data) => [data.error || r.status, data.hint].filter(Boolean).join(" — ");
  row.appendChild(offer("Fork instead", "Open a new window on a copy of this session; the original is untouched",
    "/api/open", { session: resumedId, fork: true }, "opening a fork in a new window…",
    (r, data) => `couldn't fork: ${why(r, data)}`));
  if (bg) {
    row.appendChild(offer("Attach in Terminal", `Open the running session in Terminal (claude attach ${bg[1]})`,
      "/api/session-action", { id: resumedId, action: "attach" }, "opening it in Terminal…",
      (r, data) => r.status === 501
        ? `Attach needs macOS Terminal — run \`claude attach ${bg[1]}\``
        : `couldn't attach: ${why(r, data)}`));
  }
  row.appendChild(note);
  msgEl.appendChild(row);
}

// ---------- slash commands: answered here, never sent to the agent ----------
// "/name" at the start (a path like /Users/x/a.js is not one: the name must
// end at a space or the end). fethr's agent is not Claude Code's REPL, so its
// slash commands do nothing here; say so, and say where the real thing is.
// ---------- queue: messages sent while the agent is working ----------
// Like Claude Code in a terminal: they wait above the composer and go out one
// at a time as each run ends. Stop puts them back in the composer unsent.
let queued = []; // { text, images }
const queueEl = $("#queue");
function renderQueue() {
  queueEl.replaceChildren();
  queueEl.hidden = !queued.length;
  queued.forEach((q, i) => {
    const row = document.createElement("div");
    row.className = "queued";
    const label = document.createElement("b");
    label.textContent = "queued";
    const t = document.createElement("span");
    const n = q.images.length;
    t.textContent = (n ? (n === 1 ? "[1 image] " : `[${n} images] `) : "") + q.text;
    t.title = q.text;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.title = "Don't send";
    x.onclick = () => { queued.splice(i, 1); renderQueue(); };
    row.append(label, t, x);
    queueEl.appendChild(row);
  });
}
function drainQueue(stopped) {
  if (!queued.length) return;
  if (stopped) {
    inputEl.value = [...queued.map((q) => q.text), inputEl.value].filter(Boolean).join("\n\n");
    pendingImages = [...queued.flatMap((q) => q.images), ...pendingImages].slice(0, MAX_IMAGES);
    queued = [];
    renderQueue();
    renderCtxBar();
    return;
  }
  const next = queued.shift();
  renderQueue();
  setTimeout(() => askAgent(next.text || "(see the attached image)", next.images), 0);
}

const SLASH_RE = /^\/([a-z][\w:-]*)(\s|$)/i;
function terminalHint() {
  const id = agentSession || resumedId;
  // The full id: per `claude --help`, --resume takes a session ID, and
  // anything else opens its picker as a search term.
  if (!id) return "For full Claude Code, run `claude` in a terminal in this folder.";
  return `For full Claude Code, run \`claude --resume ${id}${pendingFork ? " --fork-session" : ""}\` in a terminal.`;
}
function localCard(lines) {
  const d = document.createElement("div");
  d.className = "msg local-card";
  for (const [tag, text] of lines) {
    const n = document.createElement(tag);
    n.textContent = text;
    d.appendChild(n);
  }
  follow(() => chatEl.appendChild(d));
  return d;
}
function slashCommand(text) {
  const name = text.match(SLASH_RE)[1].toLowerCase();
  addMsg("user", "you", text); // shown, not sent, not saved
  if (name === "permissions" || name === "tools") {
    // The card describes the mode the next message will run in.
    const card = agentMode === "full" ? localCard([
      ["b", "Full mode: Claude Code's tools, without asking"],
      ["li", "Read, search, edit and write files; run commands; fetch from the web; start subagents"],
      ["li", "Claude Code's auto mode decides: a classifier can block risky actions, and you'll see a \"blocked\" line when it does"],
      ["li", "Your Claude Code settings, hooks and CLAUDE.md files apply, as in a terminal"],
      ["p", "Switch to read-only in the agent header to go back to proposals only."],
    ]) : localCard([
      ["b", "What fethr's agent can do"],
      ["li", "Read files in this folder"],
      ["li", "Search them (Grep, Glob)"],
      ["li", "Propose an edit — you review and accept it in the editor; nothing is written until you save"],
      ["b", "Turned off by design"],
      ["li", "Bash (running commands)"],
      ["li", "Write / Edit (changing files directly)"],
      ["li", "Web fetch and search"],
      ["li", "Subagents"],
      ["p", "Switch to full (top of this panel) to give the agent Claude Code's tools here, in this same conversation."],
    ]);
    card.dataset.cmd = name;
    return;
  }
  localCard([
    ["p", `/${name}: Claude Code's slash commands aren't available in fethr's panel.`],
    ["p", terminalHint()],
  ]).dataset.cmd = name;
}

inputEl.addEventListener("keydown", (e) => {
  if (mentionMenu.classList.contains("open")) {
    if (e.key === "Escape" && claimEsc(e)) {
      hideMentionMenu();
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      mentionSel = (mentionSel + (e.key === "ArrowDown" ? 1 : -1) + mentionMatches.length) % mentionMatches.length;
      [...mentionMenu.children].forEach((r, i) => r.classList.toggle("sel", i === mentionSel));
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pickMention(mentionSel);
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const t = inputEl.value.trim();
    if (!t && !pendingImages.length) return;
    if (t && SLASH_RE.test(t) && !pendingImages.length) {
      inputEl.value = "";
      return slashCommand(t); // local, so it answers even mid-run
    }
    inputEl.value = "";
    const imgs = pendingImages;
    pendingImages = [];
    renderCtxBar();
    if (streaming) {
      queued.push({ text: t, images: imgs });
      return renderQueue();
    }
    askAgent(t || "(see the attached image)", imgs);
  }
});

// Heartbeat — lets the server (CLI-spawned or app-shell sidecar alike) exit
// when the window closes, instead of lingering as an orphaned process.
setInterval(() => f("/api/alive", { method: "POST" }).catch(() => {}), 5000);
f("/api/alive", { method: "POST" }).catch(() => {});

boot();

// ---- home button: back to (or open) the home window ----
$("#go-home").onclick = async () => {
  try {
    const r = await f("/api/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ home: true }),
    });
    const data = await r.json().catch(() => ({}));
    setStatus(r.ok && data.ok ? "opening home…" : `couldn't open home: ${data.error || r.status}`);
  } catch {
    setStatus("couldn't open home: server not answering");
  }
  setTimeout(() => setStatus(""), 3000);
};

// ---- update check (web/update.js) ----
// Off switch in the footer; the daily fetch is the editor's only network
// call on its own. The notice names the version and links to where it is.
try {
  $("#updatecheck").checked = isEnabled(prefs);
} catch { /* ignore */ }
$("#updatecheck").onchange = () => {
  try {
    prefs.setItem(ENABLED_KEY, $("#updatecheck").checked ? "1" : "0");
  } catch { /* ignore */ }
};

async function checkForUpdate(meta) {
  if (!meta.version || !isEnabled(prefs)) return;
  const manifest = await fetchManifest(prefs);
  if (!manifest) return;
  const state = decide(manifest, meta.version, meta.channel);
  if (state.kind === "current") return;
  const el = $("#update");
  el.href = state.url;
  el.textContent = state.kind === "download" ? `${state.version} is out — download` : `${state.version} is out — npx @evojewel/fethr@alpha`;
  el.title = "Learned from fethr.dev/version.json, fetched once a day. Nothing was sent.";
  el.hidden = false;
}

// ---- view menu ----
// A popover of the themes in web/theme.js, each row a swatch drawn from its
// own two colours so it is readable before the theme is applied.
{
  const menu = $("#viewmenu");
  for (const t of THEMES) {
    const row = document.createElement("button");
    row.className = "row";
    row.setAttribute("role", "menuitemradio");
    row.dataset.id = t.id;
    const sw = document.createElement("span");
    sw.className = "sw" + (t.swatch ? "" : " auto");
    if (t.swatch) {
      sw.style.background = t.swatch.ground;
      const i = document.createElement("i");
      i.style.background = t.swatch.accent;
      sw.appendChild(i);
    }
    const text = document.createElement("span");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = t.label;
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = t.note;
    text.append(name, note);
    row.append(sw, text);
    row.onclick = () => {
      themeId = t.id;
      saveTheme(prefs, themeId);
      applyTheme();
      closeViewMenu();
    };
    menu.appendChild(row);
  }
  applyTheme();

  function closeViewMenu() {
    menu.classList.remove("open");
    $("#toggle-view").setAttribute("aria-expanded", "false");
  }
  $("#toggle-view").onclick = (e) => {
    e.stopPropagation();
    const open = !menu.classList.contains("open");
    menu.classList.toggle("open", open);
    $("#toggle-view").setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector('.row[aria-checked="true"]')?.focus();
  };
  document.addEventListener("click", (e) => {
    if (menu.classList.contains("open") && !menu.contains(e.target)) closeViewMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.classList.contains("open") && claimEsc(e)) { closeViewMenu(); $("#toggle-view").focus(); }
  });
}
