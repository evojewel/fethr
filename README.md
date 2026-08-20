# fethr

**A featherweight code editor with first-class agent integration.**

> Status: **alpha.** A working basic editor: file tree, syntax highlighting, edit and save.

```bash
npx @evojewel/fethr@alpha .     # open the current directory in the editor
```

fethr starts a local server bound to 127.0.0.1 and opens your browser — the rendering
engine your OS already ships — as the shell. No Electron, no app download. The editor core
is CodeMirror 6 (JS/TS, Python, Markdown, HTML, CSS, JSON highlighting), ~650 KB total.
File access is confined to the directory you launch with; nothing leaves your machine.

## The idea

Editors got heavy; agents got good. fethr starts from the opposite corner: a minimal, fast
editor shell where an AI coding agent (designed around [Claude Code](https://claude.com/claude-code)'s
front-end/runtime split — fethr is an independent project, unaffiliated with Anthropic) is
the first-class citizen rather than a bolted-on extension — a context pipe in, a renderer
out, and as little between you and the buffer as possible.

Principles, subject to change while we build:

- **Featherweight is the feature.** Startup, memory, and input latency are budgets, not wishes.
- **The agent is a peer process, not a plugin.** The editor forwards context (selection,
  files, project) and renders results (streams, diffs); intelligence lives in the agent runtime.
- **No extension platform.** Language smarts via LSP, syntax via tree-sitter, agent via its
  own protocol. The moat we skip is the weight we skip.

## Usage

```bash
fethr           # open the current directory
fethr <dir>     # open a specific directory
```

⌘S saves. That's the manual.

(The unscoped npm name `fethr` is blocked by npm's typosquat filter — "too similar to
`fetch`" — so the package lives under the author scope. The installed command is still
`fethr`.)

## License

MIT — see [LICENSE](LICENSE).
