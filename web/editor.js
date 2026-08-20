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
  const r = await fetch(`/api/file?p=${encodeURIComponent(p)}`);
  if (!r.ok) return setStatus(`could not open ${p}`);
  const { content } = await r.json();
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
  const r = await fetch(`/api/file?p=${encodeURIComponent(current)}`, {
    method: "PUT",
    body: view.state.doc.toString(),
  });
  if (r.ok) {
    markDirty(false);
    setStatus("saved");
    setTimeout(() => setStatus(""), 1500);
  } else {
    setStatus("save failed");
  }
}

async function boot() {
  const meta = await (await fetch("/api/meta")).json();
  $("#root").textContent = meta.name;
  document.title = `${meta.name} — fethr`;
  const tree = await (await fetch("/api/tree")).json();
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

boot();
