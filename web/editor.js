// fethr editor UI — CodeMirror 6 core, bundled at publish time.

import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
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
let current = null;
let dirty = false;

// Transport: fetch against the local server. In the native app shell (v0.3+)
// that server is a bundled Node sidecar the Rust side spawns and points the
// window at — same server.js, same origin-relative paths, so this file has
// no app-vs-CLI branching to carry.
const api = {
  meta: () => fetch("/api/meta").then((r) => r.json()),
  tree: () => fetch("/api/tree").then((r) => r.json()),
  read: async (p) => {
    const r = await fetch(`/api/file?p=${encodeURIComponent(p)}`);
    if (!r.ok) throw new Error("not found");
    return (await r.json()).content;
  },
  save: async (p, content) => {
    const r = await fetch(`/api/file?p=${encodeURIComponent(p)}`, { method: "PUT", body: content });
    if (!r.ok) throw new Error("save failed");
  },
  loadChat: () => fetch("/api/chat").then((r) => r.json()).catch(() => null),
  saveChat: (data) => fetch("/api/chat", { method: "PUT", body: JSON.stringify(data) }).catch(() => {}),
};

const setStatus = (t) => { $("#status").textContent = t; };

let autoSaveTimer = null;
function scheduleAutoSave() {
  if (!$("#autosave").checked) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    if (dirty) save();
  }, 800);
}

const markDirty = (d) => {
  dirty = d;
  $("#file").textContent = current ? current + (d ? " •" : "") : "no file open";
  if (d) scheduleAutoSave();
};

try {
  const v = localStorage.getItem("fethr.autoSave");
  $("#autosave").checked = v === null ? true : v === "1"; // on by default
} catch { /* private mode — stays checked, just doesn't persist */ }
$("#autosave").onchange = () => {
  try {
    localStorage.setItem("fethr.autoSave", $("#autosave").checked ? "1" : "0");
  } catch { /* ignore */ }
};

const view = new EditorView({
  parent: $("#editor"),
  state: EditorState.create({
    doc: "\n  fethr — pick a file on the left.\n",
    extensions: [basicSetup, oneDark, langC.of([])],
  }),
});

const extensions = () => [
  basicSetup,
  oneDark,
  langC.of(current ? langBy(current) : []),
  keymap.of([
    indentWithTab,
    { key: "Mod-s", preventDefault: true, run: () => (save(), true) },
  ]),
  EditorView.updateListener.of((u) => {
    if (u.docChanged) markDirty(true);
  }),
];

async function openFile(p) {
  if (dirty && !confirm(`Discard unsaved changes in ${current}?`)) return;
  let content;
  try {
    content = await api.read(p);
  } catch {
    return setStatus(`could not open ${p}`);
  }
  current = p;
  view.setState(EditorState.create({ doc: content, extensions: extensions() }));
  markDirty(false);
  setStatus("opened");
  document.querySelectorAll("#tree .active").forEach((n) => n.classList.remove("active"));
  const node = document.querySelector(`#tree [data-p="${CSS.escape(p)}"]`);
  if (node) node.classList.add("active");
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
      parent.appendChild(row);
    }
  }
}

async function boot() {
  const meta = await api.meta();
  $("#root").textContent = meta.name;
  document.title = `${meta.name} — fethr`;
  renderTree(await api.tree());
  await restoreChat();
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
    localStorage.setItem(
      "fethr.sidebarCollapsed",
      document.body.classList.contains("sidebar-collapsed") ? "1" : "0"
    );
  } catch { /* private mode / storage blocked — just don't persist */ }
};
$("#toggle-sidebar").onclick = toggleSidebar;
try {
  if (localStorage.getItem("fethr.sidebarCollapsed") === "1") {
    document.body.classList.add("sidebar-collapsed");
  }
} catch { /* ignore */ }
syncSidebarIcon();

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "b") {
    e.preventDefault();
    toggleSidebar();
  }
});

// ---------- agent panel ----------

let agentSession = null;
let streaming = false;

const chatEl = $("#chat");
const inputEl = $("#input");

const toggleAgent = () => {
  document.body.classList.toggle("agent-open");
  if (document.body.classList.contains("agent-open")) inputEl.focus();
};
$("#toggle-agent").onclick = toggleAgent;
window.addEventListener("keydown", (e) => {
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
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
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
  if (p.path !== current) await openFile(p.path);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: p.content } });
  markDirty(true);
}

function renderProposal(p) {
  const box = document.createElement("div");
  box.className = "proposal";
  const head = document.createElement("div");
  head.className = "phead";
  head.innerHTML = `<b>propose_edit</b> ${p.path}${p.note ? " — " + p.note : ""}`;
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

  if ($("#auto").checked) {
    applyProposal(p);
    actions.textContent = "auto-applied — review and ⌘S to save";
  } else {
    const accept = document.createElement("button");
    accept.className = "accept";
    accept.textContent = "Accept";
    const reject = document.createElement("button");
    reject.textContent = "Reject";
    const done = (label) => {
      actions.textContent = label;
    };
    accept.onclick = async () => {
      await applyProposal(p);
      done("accepted — review and ⌘S to save");
    };
    reject.onclick = () => done("rejected");
    actions.append(accept, reject);
  }
  box.appendChild(actions);
  chatEl.appendChild(box);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// Minimal safe markdown: escape everything, then fences / inline code / bold.
function renderMd(el, raw) {
  const esc = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = esc.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => `<pre>${code}</pre>`);
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  el.innerHTML = html;
}

// ---------- chat history — persisted to .fethr/chat.json in the workspace ----------
// A plain project file, not browser storage: it survives across separate
// launches even though the local server's port (and therefore origin) is
// random each time, and it's something the user can see or delete like any
// other file (already hidden from the sidebar — dotfiles are skipped there).

let transcript = [];

function persistChat() {
  api.saveChat({ session: agentSession, entries: transcript });
}

function renderEntry(entry) {
  if (entry.type === "user") return addMsg("user", "you", entry.text);
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
    chatEl.appendChild(box);
    return box;
  }
  if (entry.type === "tool") return addMsg("tool", null, entry.text);
  if (entry.type === "proposal") return renderProposal(entry);
}

function recordAndAdd(entry) {
  transcript.push(entry);
  persistChat();
  return renderEntry(entry);
}

async function restoreChat() {
  const saved = await api.loadChat();
  if (!saved || !Array.isArray(saved.entries) || !saved.entries.length) return;
  agentSession = saved.session || null;
  for (const e of saved.entries) {
    transcript.push(e);
    renderEntry(e);
  }
  addMsg("tool", null, "— restored earlier conversation —");
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
  addMsg("tool", null, `model → ${$("#model").value || "default"} (new conversation)`);
};

try {
  $("#auto").checked = localStorage.getItem("fethr.autoApply") === "1";
} catch { /* ignore */ }
$("#auto").onchange = () => {
  try {
    localStorage.setItem("fethr.autoApply", $("#auto").checked ? "1" : "0");
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
  addMsg("tool", null, "fable 5 isn't available on this account — switched back to default.");
}

async function askAgent(prompt) {
  streaming = true;
  abortCtl = new AbortController();
  const selectedModel = $("#model").value || undefined;
  let sawSession = false;
  recordAndAdd({ type: "user", text: prompt });
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

  try {
    const r = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: abortCtl.signal,
      body: JSON.stringify({
        prompt,
        sessionId: agentSession,
        context,
        model: selectedModel,
      }),
    });
    if (!r.ok || !r.body) {
      const err = await r.json().catch(() => ({}));
      if (selectedModel === "fable") return markFableUnavailable();
      reply.appendChild(document.createTextNode(err.error || `agent error (${r.status})`));
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
          sawSession = true;
        } else if (ev.type === "delta") {
          replyRaw += ev.text;
          reply.textContent = replyRaw;
          setPhase("writing…");
          chatEl.scrollTop = chatEl.scrollHeight;
        } else if (ev.type === "thinking") {
          if (!thoughtBox) {
            thoughtBox = document.createElement("details");
            thoughtBox.className = "thought";
            thoughtBox.innerHTML = "<summary>thinking…</summary><div class='ttext'></div>";
            reply.parentNode.insertBefore(thoughtBox, reply);
          }
          thoughtRaw += ev.text;
          thoughtBox.querySelector(".ttext").textContent = thoughtRaw;
          setPhase("thinking…");
        } else if (ev.type === "phase") {
          setPhase(ev.phase === "thinking" ? "thinking…" : "writing…");
        } else if (ev.type === "tool") {
          setPhase(`${ev.name}…`);
          recordAndAdd({ type: "tool", text: `⚙ ${ev.name}${ev.detail ? " " + ev.detail : ""}` });
        } else if (ev.type === "proposal") {
          recordAndAdd({ type: "proposal", path: ev.path, content: ev.content, note: ev.note });
        } else if (ev.type === "error") {
          if (selectedModel === "fable" && !sawSession) markFableUnavailable();
          else recordAndAdd({ type: "tool", text: `error: ${ev.message}` });
        } else if (ev.type === "done" && !ev.ok) {
          if (selectedModel === "fable" && !sawSession) markFableUnavailable();
          else recordAndAdd({ type: "tool", text: `ended: ${ev.error}` });
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") recordAndAdd({ type: "tool", text: "stopped" });
    else recordAndAdd({ type: "tool", text: `agent unreachable: ${e.message}` });
  } finally {
    if (replyRaw) {
      renderMd(reply, replyRaw);
      transcript.push({ type: "assistant", text: replyRaw });
    }
    if (thoughtBox) {
      thoughtBox.querySelector("summary").textContent = "thought";
      transcript.push({ type: "thought", text: thoughtRaw });
    }
    if (replyRaw || thoughtBox) persistChat();
    setPhase(null);
    streaming = false;
    abortCtl = null;
  }
}

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const t = inputEl.value.trim();
    if (!t || streaming) return;
    inputEl.value = "";
    askAgent(t);
  }
});

// Heartbeat — lets the server (CLI-spawned or app-shell sidecar alike) exit
// when the window closes, instead of lingering as an orphaned process.
setInterval(() => fetch("/api/alive", { method: "POST" }).catch(() => {}), 5000);
fetch("/api/alive", { method: "POST" }).catch(() => {});

boot();
