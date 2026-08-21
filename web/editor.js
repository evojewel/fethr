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

// Transport: HTTP against the local server (CLI mode) or Tauri invoke (app shell).
const TAURI = typeof window.__TAURI__ !== "undefined" ? window.__TAURI__.core : null;
const api = {
  meta: () => (TAURI ? TAURI.invoke("meta") : fetch("/api/meta").then((r) => r.json())),
  tree: () => (TAURI ? TAURI.invoke("tree") : fetch("/api/tree").then((r) => r.json())),
  read: async (p) => {
    if (TAURI) return TAURI.invoke("read_file", { p });
    const r = await fetch(`/api/file?p=${encodeURIComponent(p)}`);
    if (!r.ok) throw new Error("not found");
    return (await r.json()).content;
  },
  save: async (p, content) => {
    if (TAURI) return TAURI.invoke("save_file", { p, content });
    const r = await fetch(`/api/file?p=${encodeURIComponent(p)}`, { method: "PUT", body: content });
    if (!r.ok) throw new Error("save failed");
  },
};

const setStatus = (t) => { $("#status").textContent = t; };
const markDirty = (d) => {
  dirty = d;
  $("#file").textContent = current ? current + (d ? " •" : "") : "no file open";
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
  try {
    await api.save(current, view.state.doc.toString());
    markDirty(false);
    setStatus("saved");
    setTimeout(() => setStatus(""), 1500);
  } catch {
    setStatus("save failed");
  }
}

async function boot() {
  const meta = await api.meta();
  $("#root").textContent = meta.name;
  document.title = `${meta.name} — fethr`;
  if (TAURI) {
    $("#input").disabled = true;
    $("#input").placeholder = "The agent panel runs in CLI mode: npx @evojewel/fethr@alpha";
  }
  const tree = await api.tree();
  const el = $("#tree");
  for (const n of tree) {
    const d = document.createElement("div");
    d.className = n.dir ? "dir" : "file";
    d.style.paddingLeft = 10 + n.path.split("/").length * 12 + "px";
    d.textContent = n.path.split("/").pop();
    if (!n.dir) {
      d.dataset.p = n.path;
      d.onclick = () => openFile(n.path);
    }
    el.appendChild(d);
  }
}

window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
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
  const accept = document.createElement("button");
  accept.className = "accept";
  accept.textContent = "Accept";
  const reject = document.createElement("button");
  reject.textContent = "Reject";
  const done = (label) => {
    actions.textContent = label;
  };
  accept.onclick = async () => {
    if (p.path !== current) await openFile(p.path);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: p.content } });
    markDirty(true);
    done("accepted — review and ⌘S to save");
  };
  reject.onclick = () => done("rejected");
  actions.append(accept, reject);
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

async function askAgent(prompt) {
  streaming = true;
  abortCtl = new AbortController();
  addMsg("user", "you", prompt);
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
        model: $("#model").value || undefined,
      }),
    });
    if (!r.ok || !r.body) {
      const err = await r.json().catch(() => ({}));
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
        if (ev.type === "session") agentSession = ev.id;
        else if (ev.type === "delta") {
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
          addMsg("tool", null, `⚙ ${ev.name}${ev.detail ? " " + ev.detail : ""}`);
        } else if (ev.type === "proposal") renderProposal(ev);
        else if (ev.type === "error") addMsg("tool", null, `error: ${ev.message}`);
        else if (ev.type === "done" && !ev.ok) addMsg("tool", null, `ended: ${ev.error}`);
      }
    }
  } catch (e) {
    if (e.name === "AbortError") addMsg("tool", null, "stopped");
    else addMsg("tool", null, `agent unreachable: ${e.message}`);
  } finally {
    if (replyRaw) renderMd(reply, replyRaw);
    if (thoughtBox) thoughtBox.querySelector("summary").textContent = "thought";
    setPhase(null);
    streaming = false;
    abortCtl = null;
  }
}

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const t = inputEl.value.trim();
    if (t && !streaming) {
      inputEl.value = "";
      askAgent(t);
    }
  }
});

// Heartbeat — lets the server exit when the window closes (CLI mode only).
if (!TAURI) {
  setInterval(() => fetch("/api/alive", { method: "POST" }).catch(() => {}), 5000);
  fetch("/api/alive", { method: "POST" }).catch(() => {});
}

boot();
