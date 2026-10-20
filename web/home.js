// fethr home view: open a folder or a past Claude Code session.
// Contract: docs/plans/home-screen.md ("Page"). Mounted by editor.js's boot()
// when /api/meta says mode "home"; nothing here touches CodeMirror or the
// file tree, because a home server has no root.
//
// Everything shown here (folder paths, session titles, prompts, subagent
// transcripts) comes from files on disk that other tools wrote, so it is
// untrusted text: every string reaches the DOM through textContent or a
// property, or through editor.js's escaping renderMd — never raw innerHTML.

import { claimEsc } from "./keys.js";

const STATUS_CLEAR_MS = 4000;
// While the window is visible the lists are re-fetched this often, and the
// "active 12s ago" ages re-drawn every tick. Both stop while it is hidden.
const POLL_MS = 5000;
const TICK_MS = 1000;
// After a successful open, the same target is ignored this long, so a double
// click or a repeated Enter opens one window, not two.
const OPEN_COOLDOWN_MS = 2000;

// "3m ago". Accepts epoch ms, epoch seconds or an ISO string, since the
// server contract names the fields but not their encoding.
const toMs = (v) => {
  let t = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(t)) return NaN;
  return t < 1e11 ? t * 1000 : t; // seconds, not ms
};
export function relTime(v, now = Date.now()) {
  const t = toMs(v);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
const absTime = (v) => {
  const t = toMs(v);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "";
};

// Every whitespace-separated term must appear in title, project or first prompt.
export function matchesQuery(s, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [s.title, s.project, s.firstPrompt].map((x) => String(x || "").toLowerCase()).join("\n");
  return terms.every((t) => hay.includes(t));
}

// ---------- session state ----------
// The server reports `state` per session. An older server may only send
// `open` and `live`, so the state is derived from those when it is missing.
const SESSION_STATES = {
  busy: "Claude is working in this session right now",
  open: "Open in another Claude Code window",
  background: "Running as a Claude Code background session",
  recent: "Active in the last few minutes",
};
export function sessionState(s) {
  if (s && typeof s.state === "string" && (s.state in SESSION_STATES || s.state === "closed")) return s.state;
  const o = s && s.open;
  if (o && o.kind === "background") return "background"; // same precedence as the server
  if (o) return o.status === "busy" ? "busy" : "open";
  return s && s.live ? "recent" : "closed";
}
export const isActiveNow = (s) =>
  sessionState(s) !== "closed" || Boolean(s.subagents && s.subagents.active > 0);

// How the session is held open elsewhere, which decides the buttons: a
// background session offers Attach / Move here / Fork, an interactive one
// only Fork (Resume would write into a transcript another window is writing).
export function openKind(s) {
  if (s.open && typeof s.open === "object") return s.open.kind === "background" ? "background" : "interactive";
  const st = sessionState(s);
  if (st === "background") return "background";
  if (st === "open" || st === "busy") return "interactive";
  return null;
}
const INTERACTIVE_WHY = "Open in another Claude Code window — fork, or close it there first";

// Fork is the primary (Enter / double-click) action for anything not closed.
export const prefersFork = (s) => sessionState(s) !== "closed" || Boolean(s.live);

// Subagent states that get a chip. "ended" (its session is closed, so it
// cannot be running) and "unknown" get none, like a closed session.
const SUB_STATES = {
  active: "Working right now",
  idle: "Started, not working at the moment",
  finished: "Finished",
  failed: "Ended with an error",
  killed: "Killed before it finished",
  stopped: "Stopped before it finished",
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function stateChip(kind, title) {
  const c = el("span", "state state-" + kind);
  if (kind === "busy" || kind === "active") c.append(el("span", "dot"));
  c.append(document.createTextNode(kind));
  c.title = title;
  return c;
}

const baseName = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(p || "");
// A stable hue per project: FNV-1a over the folder path, spread round the
// wheel by the golden angle so neighbouring hashes land far apart. Saturation
// and lightness come from the theme (--hue-s, --hue-l).
export function projectHue(path) {
  let h = 0x811c9dc5;
  for (const ch of String(path || "")) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return Math.round((h * 137.508) % 360);
}
const hue = (row, path) => {
  if (!path) return;
  row.classList.add("hued");
  row.style.setProperty("--hue", String(projectHue(path)));
};

// An empty-state line: text with <kbd> hints, given as ["text", {kbd: "⌘O"}, …].
function emptyNode(parts) {
  const li = el("li", "empty");
  for (const p of parts) li.append(typeof p === "string" ? document.createTextNode(p) : el("kbd", null, p.kbd));
  return li;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Keyed update of a list's children: rows whose signature is unchanged are
// kept as they are (so focus, a half-finished confirm and scroll survive a
// refresh), changed ones are rebuilt in place, and order is fixed with the
// fewest moves. Children without a key (empty-state lines) are dropped.
// Each node's _data is data(item) (the item itself by default), refreshed on
// every pass so handlers and the age ticker read current values.
function reconcile(list, items, { key, sig, build, data = (it) => it }) {
  const active = document.activeElement;
  const hadFocus = active && list.contains(active);
  let refocus = null;
  const old = new Map();
  for (const c of [...list.children]) {
    if (c._k) old.set(c._k, c);
    else c.remove();
  }
  const next = items.map((it) => {
    const k = key(it), sg = sig(it);
    const prev = old.get(k);
    old.delete(k);
    if (prev && (prev._sig === sg || prev.querySelector(".confirming"))) {
      prev._data = data(it);
      return prev;
    }
    const node = build(it);
    node._k = k;
    node._sig = sg;
    node._data = data(it);
    if (prev) {
      if (hadFocus && prev.contains(active)) refocus = node.matches("li.row") ? node : node.querySelector("li.row");
      prev.replaceWith(node);
    }
    return node;
  });
  for (const n of old.values()) n.remove();
  next.forEach((n, i) => {
    if (list.children[i] !== n) list.insertBefore(n, list.children[i] || null);
  });
  if (hadFocus && document.activeElement !== active) {
    const target = active.isConnected ? active : refocus;
    if (target) target.focus({ preventScroll: true });
  }
}

export function mountHome(root, { f, renderMd }) {
  const state = {
    recent: [],
    recentHidden: [],
    sessions: [],
    query: "",
    source: "", // "" = all, ACTIVE = active now, else a source name
    showTemp: false,
    loaded: false,
    loadError: null,
    picking: false,
    expanded: new Set(), // session ids whose subagent list is open
    subs: new Map(), // session id -> { agents: [] | null, error: string | null }
  };
  const ACTIVE = "\u0000active"; // cannot collide with a source name

  // ---------- skeleton ----------
  root.replaceChildren();
  const head = el("header", "home-head");
  const brand = el("h1", "home-title", "fethr");
  const status = el("span", "home-status");
  status.id = "home-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  head.append(brand, status);

  const cols = el("div", "home-cols");

  // Folder column
  const folders = el("section", "home-sec home-folders");
  folders.setAttribute("aria-labelledby", "home-h-folders");
  const fh = el("h2", null, "Open a folder");
  fh.id = "home-h-folders";
  const pickBtn = el("button", "home-btn primary");
  pickBtn.id = "home-pick";
  pickBtn.type = "button";
  pickBtn.append(document.createTextNode("Open folder…"), el("kbd", null, navigator.platform.includes("Mac") ? "⌘O" : "Ctrl+O"));
  const pathForm = el("form", "home-path");
  pathForm.id = "home-path";
  pathForm.hidden = true;
  const pathInput = el("input");
  pathInput.id = "home-path-input";
  pathInput.type = "text";
  pathInput.placeholder = "/path/to/folder";
  pathInput.spellcheck = false;
  pathInput.autocomplete = "off";
  pathInput.setAttribute("aria-label", "Folder path");
  const pathGo = el("button", "home-btn", "Open");
  pathGo.type = "submit";
  pathForm.append(pathInput, pathGo);
  const recentHead = el("h3", null, "Recent");
  const recentList = el("ul", "home-list");
  recentList.id = "home-recent";
  recentList.setAttribute("aria-label", "Recent folders");
  const hiddenBox = el("div", "home-hidden");
  const hiddenToggle = el("button", "home-disclose");
  hiddenToggle.type = "button";
  hiddenToggle.setAttribute("aria-expanded", "false");
  hiddenToggle.setAttribute("aria-controls", "home-recent-hidden");
  const hiddenList = el("ul", "home-list");
  hiddenList.id = "home-recent-hidden";
  hiddenList.hidden = true;
  hiddenList.setAttribute("aria-label", "Removed from Recent");
  hiddenBox.append(hiddenToggle, hiddenList);
  hiddenBox.hidden = true;
  hiddenToggle.onclick = () => {
    const open = hiddenToggle.getAttribute("aria-expanded") !== "true";
    hiddenToggle.setAttribute("aria-expanded", String(open));
    hiddenList.hidden = !open;
    renderHidden();
  };
  folders.append(fh, pickBtn, pathForm, recentHead, recentList, hiddenBox);

  // Session column
  const sess = el("section", "home-sec home-sessions");
  sess.setAttribute("aria-labelledby", "home-h-sessions");
  const sh = el("h2", null, "Open a session");
  sh.id = "home-h-sessions";
  const search = el("input", "home-search");
  search.id = "home-search";
  search.type = "search";
  search.placeholder = "Search sessions";
  search.spellcheck = false;
  search.autocomplete = "off";
  search.setAttribute("aria-label", "Search sessions (press / to focus)");
  const searchWrap = el("div", "home-searchwrap");
  searchWrap.append(search, el("kbd", "home-slash", "/"));
  const filters = el("div", "home-filters");
  const chips = el("div", "home-chips");
  chips.setAttribute("role", "radiogroup");
  chips.setAttribute("aria-label", "Filter");
  const tempLabel = el("label", "home-temp");
  const tempBox = el("input");
  tempBox.type = "checkbox";
  tempBox.id = "home-temp";
  const tempText = el("span", null, "show temp folders");
  tempLabel.append(tempBox, tempText);
  filters.append(chips, tempLabel);
  const sessList = el("ul", "home-list");
  sessList.id = "home-sessions";
  sessList.setAttribute("aria-label", "Claude Code sessions");
  const sub = el("p", "home-sub",
    "Listed from Claude Code's history on this computer. Reading it here sends nothing anywhere.");
  sess.append(sh, sub, searchWrap, filters, sessList);

  cols.append(folders, sess);

  // Read-only transcript viewer for a subagent: a drawer over the page.
  const viewer = el("div", "home-viewer");
  viewer.id = "home-viewer";
  viewer.hidden = true;
  const vPanel = el("div", "vpanel");
  vPanel.setAttribute("role", "dialog");
  vPanel.setAttribute("aria-modal", "true");
  vPanel.setAttribute("aria-labelledby", "home-viewer-title");
  const vHead = el("div", "vhead");
  const vTitleBox = el("div", "vtitlebox");
  const vTitle = el("h3", "vtitle");
  vTitle.id = "home-viewer-title";
  const vMeta = el("div", "vmeta");
  vTitleBox.append(vTitle, vMeta);
  const vClose = el("button", "home-btn small", "Close");
  vClose.type = "button";
  vClose.title = "Close (Esc)";
  vHead.append(vTitleBox, vClose);
  const vBody = el("div", "vbody");
  vPanel.append(vHead, vBody);
  viewer.append(vPanel);

  root.append(head, cols, viewer);

  // ---------- status line ----------
  let statusTimer = null;
  function setStatus(text, { error = false, sticky = false } = {}) {
    clearTimeout(statusTimer);
    status.textContent = text;
    status.classList.toggle("error", error);
    if (text && !sticky && !error) statusTimer = setTimeout(() => setStatus(""), STATUS_CLEAR_MS);
  }

  // ---------- open ----------
  // One open per target at a time: ignored while one is in flight and for
  // OPEN_COOLDOWN_MS after it succeeds. Keyed by session id or folder.
  const openBusy = new Map(); // key -> time the block ends (Infinity while in flight)
  const openKey = (b) =>
    b.session ? "s:" + b.session : b.root ? "r:" + b.root.replace(/[\\/]+$/, "") : b.pick ? "pick" : "home";
  async function guarded(key, run) {
    if ((openBusy.get(key) || 0) > Date.now()) return false;
    openBusy.set(key, Infinity);
    let ok = false;
    try {
      ok = await run();
    } finally {
      if (ok) openBusy.set(key, Date.now() + OPEN_COOLDOWN_MS);
      else openBusy.delete(key);
    }
    return ok;
  }
  const open = (body, label) => guarded(openKey(body), () => post(body, label));

  // Claude Code's own options for a background session (server runs the
  // `claude` command): "attach" opens it in Terminal, "stop-and-resume" stops
  // it there and opens it here. 501 means this machine can't attach for us.
  const short = (s) => String(s.id || "").slice(0, 8);
  // The server answers 428 {broad, folder} when the target folder is the home
  // folder (or above it): the agent could read everything there. Ask once more,
  // with an in-page button, since window.confirm() is unavailable in the app.
  function askBroad(label, folder, retry) {
    setStatus(`${label} opens in ${folder}, so the agent could read everything there. `, { sticky: true });
    const go = el("button", "confirm-broad", "Open anyway");
    go.type = "button";
    go.onclick = () => { setStatus(""); retry(); };
    status.appendChild(go);
    go.focus();
  }

  function sessionAction(s, action, confirmBroad = false) {
    return guarded(`a:${action}:${s.id}`, async () => {
      let r, data;
      try {
        r = await f("/api/session-action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: s.id, action, ...(confirmBroad ? { confirmBroad: true } : {}) }),
        });
        data = await r.json().catch(() => ({}));
      } catch {
        setStatus("fethr's server is not answering", { error: true });
        return false;
      }
      if (r.status === 428 && data && data.broad) {
        askBroad(s.title || "This session", data.folder, () => sessionAction(s, action, true));
        return false;
      }
      if (action === "attach" && r.status === 501) {
        setStatus(`Attach needs macOS Terminal — run \`claude attach ${short(s)}\``, { error: true });
        return false;
      }
      if (!r.ok || !data || data.error || !data.ok) {
        const why = [(data && data.error) || `error ${r.status}`, data && data.hint].filter(Boolean).join(" — ");
        setStatus(`Couldn't ${action === "attach" ? "attach to" : "move"} ${s.title || "session"}: ${why}`, { error: true });
        return false;
      }
      setStatus(action === "attach" ? `Opening ${s.title || "session"} in Terminal…` : `Moving ${s.title || "session"} here…`);
      return true;
    });
  }

  // One POST for every way out of this page. The server answers {ok},
  // {pending} (the native shell is showing its own folder dialog),
  // {cancelled} (picker dismissed) or {error}; 501 on pick means there is no
  // native folder dialog here, so the path box takes its place.
  async function post(body, label) {
    let r, data;
    try {
      r = await f("/api/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      data = await r.json().catch(() => ({}));
    } catch {
      setStatus("fethr's server is not answering", { error: true });
      return false;
    }
    if (body.pick && r.status === 501) {
      revealPathBox();
      setStatus("No folder dialog here. Type a path instead.", { sticky: true });
      return false;
    }
    if (data && data.cancelled) {
      setStatus("");
      return false;
    }
    if (r.status === 428 && data && data.broad) {
      askBroad(label, data.folder, () => open({ ...body, confirmBroad: true }, label));
      return false;
    }
    if (r.ok && data && data.pending) {
      setStatus(""); // the dialog is the feedback; a window follows only if a folder is chosen
      return true;
    }
    if (!r.ok || !data || data.error || !data.ok) {
      const why = [(data && data.error) || `error ${r.status}`, data && data.hint].filter(Boolean).join(" — ");
      setStatus(`Couldn't open ${label}: ${why}`, { error: true });
      return false;
    }
    setStatus(`Opening ${label}…`);
    return true;
  }

  function revealPathBox() {
    pathForm.hidden = false;
    pathInput.focus();
  }

  async function pick() {
    if (state.picking) return;
    if (!pathForm.hidden) return pathInput.focus();
    state.picking = true;
    pickBtn.disabled = true;
    setStatus("Choose a folder…", { sticky: true });
    try {
      await open({ pick: true }, "folder");
    } finally {
      state.picking = false;
      pickBtn.disabled = false;
    }
  }
  pickBtn.onclick = pick;

  pathForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = pathInput.value.trim();
    if (!p) return pathInput.focus();
    if (await open({ root: p }, baseName(p))) pathInput.value = "";
  });

  const openFolder = (r) => open({ root: r.path }, r.name || baseName(r.path));
  const openSession = (s, fork) => open({ session: s.id, fork }, s.title || "session");

  // ---------- rows: roving focus, arrows, Enter ----------
  // Each list keeps exactly one row in the tab order. Arrows move between
  // rows (subagent rows included, in display order); Enter on a row (not on
  // one of its buttons) runs its primary action. Right/Left open and close a
  // session's subagent list.
  function wireList(list, { onEnter, onTopUp, onRight, onLeft }) {
    list.addEventListener("keydown", (e) => {
      const row = e.target.closest("li.row");
      if (!row) return;
      const rows = [...list.querySelectorAll("li.row")];
      const i = rows.indexOf(row);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (e.key === "ArrowUp" && i === 0 && onTopUp) return onTopUp();
        const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
        focusRow(list, next);
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        focusRow(list, e.key === "Home" ? rows[0] : rows[rows.length - 1]);
      } else if (e.target === row && e.key === "Enter") {
        e.preventDefault();
        onEnter(row);
      } else if (e.target === row && e.key === "ArrowRight" && onRight) {
        e.preventDefault();
        onRight(row);
      } else if (e.target === row && e.key === "ArrowLeft" && onLeft) {
        e.preventDefault();
        onLeft(row);
      }
    });
    list.addEventListener("focusin", (e) => {
      const row = e.target.closest("li.row");
      if (row) setRoving(list, row);
    });
  }
  function setRoving(list, row) {
    for (const r of list.querySelectorAll("li.row")) r.tabIndex = r === row ? 0 : -1;
  }
  function ensureRoving(list) {
    if (!list.querySelector('li.row[tabindex="0"]')) {
      const first = list.querySelector("li.row");
      if (first) first.tabIndex = 0;
    }
  }
  function focusRow(list, row) {
    if (!row) return;
    setRoving(list, row);
    row.focus();
    row.scrollIntoView({ block: "nearest" });
  }

  wireList(recentList, {
    onEnter: (row) => {
      const r = row._data;
      if (r && r.exists !== false) openRecent(r);
    },
  });
  wireList(sessList, {
    onEnter: (row) => {
      if (row.classList.contains("subrow")) return openViewer(row._data, row._session, row);
      const s = row._data;
      if (s && s.cwdExists !== false) openSession(s, prefersFork(s));
    },
    onTopUp: () => search.focus(),
    onRight: (row) => {
      if (row.classList.contains("session") && row._data.subagents && row._data.subagents.total > 0) {
        setExpanded(row._data.id, true);
      }
    },
    onLeft: (row) => {
      if (row.classList.contains("subrow")) {
        const parent = sessList.querySelector(`li.row.session[data-id="${CSS.escape(row._session.id)}"]`);
        if (parent) focusRow(sessList, parent);
      } else if (row.classList.contains("session")) {
        setExpanded(row._data.id, false);
      }
    },
  });

  function setEmpty(list, text, extra) {
    const li = el("li", "empty", text);
    if (extra) li.append(" ", extra);
    list.replaceChildren(li);
  }

  // ---------- render: recent folders ----------
  function renderRecent() {
    if (!state.loaded) return setEmpty(recentList, state.loadError ? "" : "Loading…");
    renderHidden();
    if (!state.recent.length) {
      return recentList.replaceChildren(emptyNode(["No folders yet. Open one with ", { kbd: "⌘O" }, " and it's listed here, with the chat you had in it."]));
    }
    reconcile(recentList, state.recent, {
      // One folder can be listed once per chat, so the chat is part of the key.
      key: recentKey,
      sig: (r) => JSON.stringify([r.path, r.name, r.exists, recentSession(r) && [
        r.session.id, r.session.title, sessionState(r.session), openKind(r.session)]]),
      build: folderRow,
    });
    ensureRoving(recentList);
    tickRecent();
  }

  // A recent folder remembers the session last used in it (r.session):
  // the row then leads with that chat's title, the folder underneath.
  const recentSession = (r) => (r.session && typeof r.session === "object" && r.session.id ? r.session : null);

  const recentKey = (r) => "r:" + r.path + "|" + ((recentSession(r) || {}).id || "");

  function folderRow(r) {
    const gone = r.exists === false;
    const rs = recentSession(r);
    const name = r.name || baseName(r.path);
    const row = el("li", "row folder" + (gone ? " gone" : "") + (rs ? " with-session" : ""));
    row.tabIndex = -1;
    hue(row, r.path);
    const main = el("div", "rmain");
    const title = el("div", "rtitle");
    title.append(el("span", "ttext", rs ? rs.title || "(untitled)" : name));
    const st = rs ? sessionState(rs) : "closed";
    if (st !== "closed") title.append(stateChip(st, SESSION_STATES[st]));
    main.append(title, el("div", "rmeta", rs ? `${name} · ${r.path}` : r.path));
    const btns = el("div", "rbtns quiet");
    const remove = smallBtn("Remove", "Take this off Recent. The folder and its chats are not touched.");
    const normal = [remove];
    remove.onclick = (e) => {
      e.stopPropagation();
      confirmInRow(btns, normal, "Remove from Recent?", "Remove", () => setHidden(r, true));
    };
    btns.append(...normal);
    row.append(main, el("span", "rwhen", gone ? "missing" : ""), btns);
    if (gone) {
      row.setAttribute("aria-disabled", "true");
      row.title = "This folder no longer exists";
    } else {
      row.title = rs ? `Resume this chat in ${r.path}` : r.path;
      row.onclick = () => openRecent(row._data);
    }
    return row;
  }

  function smallBtn(text, title) {
    const b = el("button", "home-btn small", text);
    b.type = "button";
    if (title) b.title = title;
    b.ondblclick = (e) => e.stopPropagation();
    return b;
  }

  // A yes/no asked inside the row (window.confirm() is unavailable in the
  // app's webview). Esc or Cancel puts the row's buttons back.
  function confirmInRow(btns, normal, question, yesLabel, onYes) {
    const q = el("span", "confirm-q", question);
    const yes = smallBtn(yesLabel);
    yes.className += " primary";
    const no = smallBtn("Cancel");
    const restore = () => {
      btns.classList.remove("confirming");
      btns.onkeydown = null;
      btns.replaceChildren(...normal);
      if (normal[0] && normal[0].isConnected) normal[0].focus();
    };
    yes.onclick = async (ev) => {
      ev.stopPropagation();
      yes.disabled = no.disabled = true;
      await onYes();
      if (btns.isConnected) restore();
    };
    no.onclick = (ev) => { ev.stopPropagation(); restore(); };
    btns.onkeydown = (ev) => {
      if (btns.classList.contains("confirming") && claimEsc(ev)) { ev.preventDefault(); restore(); }
    };
    btns.classList.add("confirming");
    btns.replaceChildren(q, yes, no);
    no.focus();
  }

  // Remove from Recent / put back: fethr's own list only (server side).
  async function setHidden(r, hide) {
    const rs = recentSession(r);
    try {
      const res = await f(hide ? "/api/recent/hide" : "/api/recent/unhide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: r.path, session: rs ? rs.id : null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `error ${res.status}`);
      setStatus(hide ? `Removed ${r.name || baseName(r.path)} from Recent` : `Put ${r.name || baseName(r.path)} back`);
    } catch (e) {
      setStatus(`Couldn't ${hide ? "remove" : "put back"} ${r.name || baseName(r.path)}: ${e.message}`, { error: true });
    }
    await load();
  }

  function renderHidden() {
    const n = state.recentHidden.length;
    hiddenBox.hidden = !n;
    if (!n) {
      hiddenToggle.setAttribute("aria-expanded", "false");
      hiddenList.hidden = true;
    }
    const open = hiddenToggle.getAttribute("aria-expanded") === "true";
    hiddenToggle.textContent = `${open ? "Hide" : "Show"} ${n} removed`;
    if (!open) return;
    reconcile(hiddenList, state.recentHidden, {
      key: recentKey,
      sig: (r) => JSON.stringify([r.path, r.name, (recentSession(r) || {}).title]),
      build: (r) => {
        const rs = recentSession(r);
        const row = el("li", "row folder removed");
        hue(row, r.path);
        const main = el("div", "rmain");
        main.append(el("div", "rtitle", rs ? rs.title || "(untitled)" : r.name || baseName(r.path)), el("div", "rmeta", r.path));
        const back = smallBtn("Put back", "Show it in Recent again");
        back.onclick = () => setHidden(r, false);
        const btns = el("div", "rbtns");
        btns.append(back);
        row.append(main, btns);
        return row;
      },
    });
  }

  // A recent row with a session resumes it, unless Claude Code has it open
  // elsewhere: then the choice (Attach / Move here / Fork) belongs to that
  // session's own row, so take the person there instead of guessing.
  function openRecent(r) {
    const rs = recentSession(r);
    if (!rs) return openFolder(r);
    if (openKind(rs) && revealSession(rs.id)) return;
    return open({ session: rs.id, fork: false }, rs.title || r.name || baseName(r.path));
  }

  function revealSession(id) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return false;
    const find = () => sessList.querySelector(`li.row.session[data-id="${CSS.escape(id)}"]`);
    if (!find()) {
      // filtered out: clear what hides it
      state.query = search.value = "";
      state.source = "";
      if (s.temp) state.showTemp = tempBox.checked = true;
      renderChips();
      renderSessions();
    }
    const row = find();
    if (!row) return false;
    focusRow(sessList, row);
    row.scrollIntoView({ block: "center" });
    row.classList.remove("flash");
    void row.offsetWidth; // restart the highlight if it is already running
    row.classList.add("flash");
    setTimeout(() => row.classList.remove("flash"), 1600);
    setStatus(`${s.title || "That session"} is open elsewhere — choose here how to continue it`);
    return true;
  }

  // ---------- render: sessions ----------
  // A session continued in another (moved here, or resumed under a new id)
  // is listed once, as its successor; it shows on its own only when the
  // successor is not in the list.
  function listable() {
    const ids = new Set(state.sessions.map((s) => s.id));
    return state.sessions.filter((s) => !(s.superseded && s.continuedIn && ids.has(s.continuedIn)));
  }

  function visibleSessions() {
    return listable().filter((s) =>
      (state.showTemp || !s.temp) &&
      (!state.source || (state.source === ACTIVE ? isActiveNow(s) : (s.source || "other") === state.source)) &&
      matchesQuery(s, state.query)
    );
  }

  let chipsSig = "";
  function renderChips() {
    const pool = listable().filter((s) => state.showTemp || !s.temp);
    const counts = new Map();
    for (const s of pool) {
      const k = s.source || "other";
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const active = pool.filter(isActiveNow).length;
    if (state.source && state.source !== ACTIVE && !counts.has(state.source)) state.source = "";
    const defs = [["", "All", pool.length], [ACTIVE, "Active now", active],
      ...[...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, k, n])];
    const hidden = listable().filter((s) => s.temp).length;
    tempText.textContent = hidden ? `show temp folders (${hidden})` : "show temp folders";
    tempLabel.hidden = !hidden;
    const sig = JSON.stringify([defs, state.source]);
    if (sig === chipsSig) return;
    chipsSig = sig;
    const focused = chips.contains(document.activeElement) ? document.activeElement.dataset.value : null;
    chips.replaceChildren();
    for (const [value, label, n] of defs) {
      const b = el("button", "chip" + (value === ACTIVE ? " chip-active" : ""));
      b.type = "button";
      b.dataset.value = value;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(state.source === value));
      b.append(document.createTextNode(label), el("span", "n", String(n)));
      b.onclick = () => {
        state.source = value;
        renderChips();
        renderSessions();
      };
      chips.append(b);
      if (focused === value) b.focus({ preventScroll: true });
    }
  }

  function renderSessions() {
    if (!state.loaded) {
      if (state.loadError) {
        const retry = el("button", "home-btn small", "Retry");
        retry.type = "button";
        retry.onclick = () => load();
        return setEmpty(sessList, `Couldn't load sessions: ${state.loadError}`, retry);
      }
      return setEmpty(sessList, "Loading…");
    }
    if (!listable().length) {
      return sessList.replaceChildren(emptyNode(["No Claude Code sessions on this computer yet. Run ", { kbd: "claude" }, " in a terminal and they show up here."]));
    }
    const list = visibleSessions();
    if (!list.length) {
      return sessList.replaceChildren(emptyNode(state.query
        ? ["No sessions match. ", { kbd: "Esc" }, " clears the search."]
        : ["Nothing here with this filter. Choose All to see every session."]));
    }
    const items = [];
    for (const s of list) {
      items.push({ kind: "row", s });
      if (state.expanded.has(s.id) && s.subagents && s.subagents.total > 0) items.push({ kind: "subs", s });
    }
    reconcile(sessList, items, {
      key: (it) => (it.kind === "row" ? "s:" : "x:") + it.s.id,
      // Everything that changes how a row looks or acts, except the ages,
      // which tick() redraws in place.
      sig: (it) => it.kind === "subs" ? "subs" : JSON.stringify([
        it.s.title, it.s.project, it.s.source, it.s.cwd, it.s.cwdExists, sessionState(it.s), openKind(it.s),
        it.s.subagents && [it.s.subagents.total, it.s.subagents.active], state.expanded.has(it.s.id),
        continuation(it.s),
      ]),
      build: (it) => (it.kind === "row" ? sessionRow(it.s) : subWrap(it.s)),
      data: (it) => (it.kind === "row" ? it.s : it),
    });
    for (const id of state.expanded) renderSubs(id);
    ensureRoving(sessList);
    tickSessions();
  }

  function continuation(s) {
    const from = Array.isArray(s.continuedFrom) ? s.continuedFrom.filter((x) => typeof x === "string") : [];
    if (from.length) return "continued from " + from.map((x) => x.slice(0, 8)).join(", ");
    if (s.superseded && typeof s.continuedIn === "string") return "continued in " + s.continuedIn.slice(0, 8);
    return "";
  }

  function sessionRow(s) {
    const gone = s.cwdExists === false;
    const st = sessionState(s);
    const kind = openKind(s);
    const row = el("li", "row session" + (gone ? " gone" : "") + (st !== "closed" ? " st-" + st : ""));
    row.dataset.id = String(s.id || "");
    row.tabIndex = -1;
    hue(row, s.cwd);
    const main = el("div", "rmain");
    const title = el("div", "rtitle");
    title.append(el("span", "ttext", s.title || "(untitled)"));
    // Closed sessions carry no chip: the list stays calm, and anything with
    // a chip is something happening now.
    if (st !== "closed") title.append(stateChip(st, SESSION_STATES[st]));
    // The short id tells apart sessions that share an auto-title, and is what
    // `claude attach` takes.
    const meta = el("div", "rmeta dots");
    const where = [s.project || baseName(s.cwd), s.source].filter(Boolean).join(" · ");
    const sid = el("span", "sid", short(s));
    sid.title = String(s.id || "");
    meta.append(el("span", "rwhere", where), sid);
    const cont = continuation(s);
    if (cont) meta.append(el("span", "cont", cont));
    meta.append(el("span", "rage"));
    main.append(title, meta);
    const subs = s.subagents && s.subagents.total > 0 ? s.subagents : null;
    if (subs) {
      const open = state.expanded.has(s.id);
      const t = el("button", "subtoggle");
      t.type = "button";
      t.setAttribute("aria-expanded", String(open));
      t.append(el("span", "chev", open ? "▾" : "▸"),
        document.createTextNode(plural(subs.total, "subagent") + (subs.active ? ` · ${subs.active} active` : "")));
      t.title = open ? "Hide subagents (←)" : "Show subagents (→)";
      t.onclick = (e) => { e.stopPropagation(); setExpanded(s.id, !state.expanded.has(s.id)); };
      t.ondblclick = (e) => e.stopPropagation();
      main.append(t);
    }
    row.title = gone ? `Folder no longer exists: ${s.cwd || ""}` : String(s.cwd || "");

    const forkFirst = prefersFork(s);
    const btns = el("div", "rbtns");
    const resume = el("button", "home-btn small", "Resume");
    resume.type = "button";
    resume.className += forkFirst ? "" : " primary";
    resume.title = kind === "interactive" ? INTERACTIVE_WHY
      : st === "recent" ? "May be open elsewhere: both would write to the same session" : "Continue this session";
    const fork = el("button", "home-btn small", "Fork");
    fork.type = "button";
    fork.className += forkFirst ? " primary" : "";
    fork.title = "Start a new session from this history; the original stays untouched";
    fork.disabled = gone;
    resume.disabled = gone || Boolean(kind);
    resume.onclick = (e) => { e.stopPropagation(); openSession(s, false); };
    fork.onclick = (e) => { e.stopPropagation(); openSession(s, true); };
    // A double click on a button is two clicks already; it must not also
    // reach the row's own double-click action.
    resume.ondblclick = fork.ondblclick = (e) => e.stopPropagation();
    if (kind === "background") btns.append(...backgroundButtons(s, btns, fork));
    else btns.append(resume, fork);
    row.append(main, btns);
    if (gone) row.setAttribute("aria-disabled", "true");
    else row.ondblclick = (e) => { if (!e.target.closest(".rbtns, .subtoggle")) openSession(s, forkFirst); };
    return row;
  }

  // A background session gets Claude Code's three ways out instead of Resume:
  // Attach (in Terminal), Move here (stop it there, resume here) and Fork.
  // Move here stops a running session, so it asks first, inside the row:
  // window.confirm() is unavailable in the app's webview.
  function backgroundButtons(s, btns, fork) {
    const attach = smallBtn("Attach", `Open the running session in Terminal (claude attach ${short(s)})`);
    attach.onclick = (e) => { e.stopPropagation(); sessionAction(s, "attach"); };
    const move = smallBtn("Move here", "Stop it in the background and resume it in a window here");
    const normal = [attach, move, fork];
    move.onclick = (e) => {
      e.stopPropagation();
      confirmInRow(btns, normal, "Stop it there and resume here?", "Confirm", () => sessionAction(s, "stop-and-resume"));
    };
    return normal;
  }

  // ---------- subagents ----------
  function setExpanded(id, open) {
    if (open === state.expanded.has(id)) return;
    if (open) {
      state.expanded.add(id);
      if (!state.subs.has(id)) loadSubs(id);
    } else {
      state.expanded.delete(id);
    }
    renderSessions();
  }

  function subWrap() {
    const li = el("li", "subwrap");
    const ul = el("ul", "subs");
    ul.setAttribute("role", "group");
    li.append(ul);
    return li;
  }

  async function loadSubs(id) {
    let entry;
    try {
      const r = await f(`/api/subagents?id=${encodeURIComponent(id)}`);
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error((data && data.error) || `error ${r.status}`);
      const list = Array.isArray(data) ? data : data && Array.isArray(data.subagents) ? data.subagents : [];
      entry = { agents: list.filter((a) => a && a.agentId), error: null };
    } catch (e) {
      // A failed refresh keeps the last good list rather than blanking it.
      const prev = state.subs.get(id);
      entry = prev && prev.agents ? prev : { agents: null, error: e.message || String(e) };
    }
    state.subs.set(id, entry);
    renderSubs(id);
  }

  function renderSubs(id) {
    const wrap = [...sessList.children].find((c) => c._k === "x:" + id);
    if (!wrap) return;
    const ul = wrap.querySelector("ul.subs");
    const entry = state.subs.get(id);
    if (!entry || (!entry.agents && !entry.error)) return setEmpty(ul, "Loading subagents…");
    if (!entry.agents) return setEmpty(ul, `Couldn't load subagents: ${entry.error}`);
    if (!entry.agents.length) return setEmpty(ul, "No subagent transcripts found.");
    const session = wrap._data.s;
    reconcile(ul, entry.agents, {
      key: (a) => "a:" + a.agentId,
      sig: (a) => JSON.stringify([a.description, a.agentType, a.workflow, a.state]),
      build: (a) => subRow(a, session),
    });
    for (const r of ul.children) r._session = session;
    ensureRoving(sessList);
    tickSessions();
  }

  function subRow(a, session) {
    const row = el("li", "row subrow");
    row.dataset.agent = String(a.agentId);
    row.tabIndex = -1;
    row._session = session;
    const main = el("div", "rmain");
    const title = el("div", "rtitle");
    title.append(el("span", "ttext", a.description || a.agentId));
    if (a.state in SUB_STATES) title.append(stateChip(a.state, SUB_STATES[a.state]));
    const meta = el("div", "rmeta");
    if (a.agentType) meta.append(el("span", "rwhere", String(a.agentType)));
    if (a.workflow) meta.append(el("span", "tag", String(a.workflow)));
    meta.append(el("span", "rage"));
    main.append(title, meta);
    row.append(main);
    row.title = "Read-only transcript";
    row.onclick = () => openViewer(row._data, row._session, row);
    return row;
  }

  // ---------- ages: redrawn in place every tick ----------
  function setAge(node, text, title) {
    if (node.textContent !== text) node.textContent = text;
    if (title !== undefined && node.title !== title) node.title = title;
  }
  function tickSessions() {
    for (const row of sessList.querySelectorAll("li.row")) {
      const d = row._data;
      const age = row.querySelector(".rage");
      if (!d || !age) continue;
      const last = d.lastActivity ?? d.mtime;
      if (row.classList.contains("subrow")) {
        setAge(age, last != null ? `active ${relTime(last)}` : "",
          [d.startedAt != null && `Started ${absTime(d.startedAt)}`, last != null && `Last activity ${absTime(last)}`].filter(Boolean).join("\n"));
        continue;
      }
      const parts = [];
      if (d.startedAt != null) parts.push(`started ${relTime(d.startedAt)}`);
      if (last != null) parts.push(`active ${relTime(last)}`);
      setAge(age, parts.join(" · "),
        [d.startedAt != null && `Started ${absTime(d.startedAt)}`, last != null && `Last activity ${absTime(last)}`].filter(Boolean).join("\n"));
    }
  }
  function tickRecent() {
    for (const row of recentList.querySelectorAll("li.row:not(.gone)")) {
      const when = row.querySelector(".rwhen");
      if (when && row._data) setAge(when, relTime(row._data.lastOpened), `Last opened ${absTime(row._data.lastOpened)}`);
    }
  }
  function tick() {
    tickSessions();
    tickRecent();
  }

  // ---------- read-only subagent transcript ----------
  let viewerOpener = null;
  let viewerSeq = 0;
  async function openViewer(a, session, opener) {
    if (!a || !session) return;
    viewerOpener = opener || null;
    const seq = ++viewerSeq;
    vTitle.textContent = a.description || a.agentId;
    vMeta.replaceChildren();
    vMeta.append(el("span", "ro", "read-only"));
    for (const part of [a.agentType, session.title && `in ${session.title}`]) if (part) vMeta.append(el("span", null, String(part)));
    if (a.workflow) vMeta.append(el("span", "tag", String(a.workflow)));
    if (a.state in SUB_STATES) vMeta.append(stateChip(a.state, SUB_STATES[a.state]));
    vBody.replaceChildren(el("div", "msg tool", "Loading…"));
    viewer.hidden = false;
    vClose.focus();
    let data = null, why = "server not answering";
    try {
      const r = await f(`/api/session-history?id=${encodeURIComponent(session.id)}&agent=${encodeURIComponent(a.agentId)}`);
      const body = await r.json().catch(() => null);
      if (r.ok) data = body;
      else why = (body && body.error) || `error ${r.status}`;
    } catch { /* why stays */ }
    if (seq !== viewerSeq || viewer.hidden) return; // closed or replaced meanwhile
    vBody.replaceChildren();
    if (!data || !Array.isArray(data.entries)) {
      vBody.append(el("div", "msg tool", `— couldn't load this transcript: ${data ? "unreadable reply" : why} —`));
      return;
    }
    if (data.omitted > 0) vBody.append(el("div", "msg tool", `— ${data.omitted} earlier turns not shown —`));
    else if (data.truncated) vBody.append(el("div", "msg tool", "— earlier turns not shown —"));
    for (const e of data.entries) {
      if (!e || typeof e.text !== "string") continue;
      if (e.type === "user" || e.type === "assistant") {
        const d = el("div", "msg " + e.type);
        d.append(el("span", "who", e.type === "user" ? "prompt" : "agent"));
        const body = el("div");
        if (e.type === "assistant" && renderMd) renderMd(body, e.text);
        else body.textContent = e.text;
        d.append(body);
        vBody.append(d);
      } else if (e.type === "tool") {
        vBody.append(el("div", "msg tool", "⚙ " + e.text));
      }
    }
    if (!vBody.childNodes.length) vBody.append(el("div", "msg tool", "— nothing to show yet —"));
  }
  function closeViewer() {
    if (viewer.hidden) return;
    viewer.hidden = true;
    viewerSeq++;
    vBody.replaceChildren();
    if (viewerOpener && viewerOpener.isConnected) viewerOpener.focus();
    viewerOpener = null;
  }
  vClose.onclick = closeViewer;
  viewer.addEventListener("click", (e) => { if (e.target === viewer) closeViewer(); });

  // ---------- data ----------
  let loading = null;
  function load() {
    // One fetch at a time; a poll that lands while one is running joins it.
    if (loading) return loading;
    loading = (async () => {
      try {
        const r = await f("/api/home");
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `error ${r.status}`);
        state.recent = Array.isArray(data.recentFolders) ? data.recentFolders.filter((x) => x && x.path) : [];
        state.recentHidden = Array.isArray(data.recentHidden) ? data.recentHidden.filter((x) => x && x.path) : [];
        state.sessions = Array.isArray(data.sessions) ? data.sessions.filter((x) => x && x.id) : [];
        state.loaded = true;
        state.loadError = null;
      } catch (e) {
        if (!state.loaded) state.loadError = e.message || String(e);
      }
      renderRecent();
      renderChips();
      renderSessions();
    })().finally(() => { loading = null; });
    return loading;
  }

  // Live refresh while visible; nothing runs while the window is hidden.
  let pollTimer = null, tickTimer = null;
  function poll() {
    load();
    for (const id of state.expanded) loadSubs(id);
  }
  function startLive() {
    if (pollTimer) return;
    pollTimer = setInterval(poll, POLL_MS);
    tickTimer = setInterval(tick, TICK_MS);
  }
  function stopLive() {
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    pollTimer = tickTimer = null;
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") return stopLive();
    poll();
    startLive();
  });

  // ---------- controls ----------
  search.addEventListener("input", () => {
    state.query = search.value;
    renderSessions();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(sessList, sessList.querySelector("li.row"));
    } else if (e.key === "Enter") {
      // Enter in the box opens the top match with its primary action.
      const first = sessList.querySelector("li.row.session:not(.gone)");
      if (first && first._data) {
        e.preventDefault();
        openSession(first._data, prefersFork(first._data));
      }
    } else if (e.key === "Escape" && search.value && claimEsc(e)) {
      e.preventDefault();
      search.value = "";
      state.query = "";
      renderSessions();
    }
  });
  tempBox.onchange = () => {
    state.showTemp = tempBox.checked;
    renderChips();
    renderSessions();
  };
  pathInput.addEventListener("keydown", (e) => {
    if (claimEsc(e)) {
      pathForm.hidden = true;
      pickBtn.focus();
    }
  });

  const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  document.addEventListener("keydown", (e) => {
    if (!viewer.hidden) {
      if (claimEsc(e)) {
        e.preventDefault();
        closeViewer();
      }
      return; // the viewer is modal: no page shortcuts behind it
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      pick();
    } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target)) {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });

  renderRecent();
  renderChips();
  renderSessions();
  search.focus();
  if (document.visibilityState !== "hidden") startLive();
  return load();
}
