# fethr

**A featherweight code editor with first-class agent integration.**

> Status: **alpha.** A working editor with an agent panel: file tree, syntax highlighting,
> edit and save — plus a Claude-powered agent that reads your workspace and proposes edits
> you accept or reject.

```bash
npx @evojewel/fethr@alpha .     # open the current directory in the editor
```

fethr starts a local server bound to 127.0.0.1 and opens your browser — the rendering
engine your OS already ships — as the shell. No Electron, no app download. The editor core
itself is CodeMirror 6 (JS/TS, Python, Markdown, HTML, CSS, JSON highlighting), ~650 KB —
that's the code that actually runs the editor. File access is confined to the directory
you launch with. **The editor itself makes no network calls — but the agent panel does:**
the current file, your selection, and anything you `@`-attach are sent to Anthropic's API
when you use it (via your existing Claude Code login), same as using Claude Code directly.
Don't use the agent panel on files you don't want leaving your machine.

**Honest note on `npx`'s first-run weight:** the ~650 KB above is the editor; it isn't the
size of what `npx` downloads. `@anthropic-ai/claude-agent-sdk` ships its own copy of the
`claude` binary as an npm `optionalDependency` (~300 MB) — the native app avoids this by
controlling its own install command (`--omit=optional`, see below), but there's no
supported way for a package to make a *downstream* `npx`/`npm install` skip its own
optionalDependencies (npm deliberately strips things like `.npmrc` from published
packages so one package can't silently alter another's install config — verified by
trying it and checking the actual packed tarball, not assuming). So: **first `npx` run
pulls the full SDK, npx caches it after that** — a one-time cost, not a per-run one, but
real and worth knowing before you judge "featherweight" by that first download.

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
fethr --app     # chromeless app-mode window (via Chrome/Edge when installed)
```

⌘S saves. ⌘J toggles the agent panel. ⌘B collapses the file sidebar (state persists).
Drag the divider between any two panels to resize — widths persist too. That's the manual.

## The agent panel

The agent is a peer process, not a plugin — fethr's founding thesis. Press ⌘J, ask
anything about the project; the current file and selection travel as context automatically.

- Runs on the **Claude Agent SDK** using your existing [Claude Code](https://claude.com/claude-code)
  login — no API key to configure. (No Claude Code auth on the machine → the panel tells you.)
- **Read-only by construction:** the agent can Read/Grep/Glob inside your workspace and
  nothing else — every mutating tool is disabled server-side.
- **Edits arrive as proposals.** The agent's only change mechanism is `propose_edit`; you
  see a diff card, and Accept applies it *in the editor* where ⌘Z works and ⌘S saves.
  The agent process never touches your disk.
- **You can see it working:** a live status line (thinking… / tool name / writing…),
  streamed thinking in a collapsible block, per-tool activity with the file or pattern it's
  touching, a stop button, and a model picker (default / opus / sonnet / haiku / fable 5 —
  switching starts a fresh conversation; fable folds back to default if your account can't
  reach it). Replies render markdown.
- **Auto mode:** check "auto" in the panel header and proposals apply straight to the
  editor buffer without a manual Accept click — still not written to disk until you ⌘S,
  still fully undoable with ⌘Z. Off by default; your choice persists locally.
- **Context is visible, not implicit.** A pill row above the composer shows exactly what's
  riding along with your next message — the current file (and selection, live, if you've
  highlighted something) plus anything you've attached. Type `@` to attach any workspace
  file by name; autocomplete filters as you type, arrow keys navigate, Enter or Tab picks.
- **File:line references in replies are clickable** — `app.js:42` in the agent's answer
  jumps the editor straight to that file and line.
- **Voice input.** The mic button next to the composer does live speech-to-text via the
  browser's built-in recognizer — no server, no API key. (macOS system dictation, Fn twice,
  already works in the composer for free either way; the mic button is the explicit,
  visible alternative with live partial transcription.)

## The app shell (v0.3, agent parity as of v0.7)

`src-tauri/` builds a native macOS window with the full agent panel included. Rather
than reimplementing the agent in Rust, the app bundles the same Node server CLI mode
uses (as a "sidecar" under `Resources/sidecar/`) and points the native window's WebView
at it on launch — same HTML/JS, same `fetch()` transport, same `src/agent.js` safety
model. Nothing agent-side had to change; only how the window boots.

**The tradeoff, and why it's smaller than you'd expect:** this needs a system Node
install (the sidecar is Node source + its runtime deps, not a bundled Node binary — the
app looks in Homebrew/nvm's usual install locations, no PATH configuration needed). It
also needs Claude Code itself installed — fethr's whole premise is that you already have
it (that's what supplies the login), so rather than bundling the Agent SDK's own copy of
the `claude` binary (300MB+ — it's the full harness, not a thin client), the sidecar is
staged with `--omit=optional` and points the SDK at your existing install via
`pathToClaudeCodeExecutable`. Net result: **~55 MB**, not ~360 MB. `npx @evojewel/fethr`
stays the lightweight, no-native-build option regardless.

```bash
npm run build && ./scripts/stage-sidecar.sh   # bundle the frontend + a minimal sidecar
npx tauri build --bundles app                  # or: cd src-tauri && cargo tauri build
```

Unsigned local builds work immediately; distribution builds need code signing.

(The unscoped npm name `fethr` is blocked by npm's typosquat filter — "too similar to
`fetch`" — so the package lives under the author scope. The installed command is still
`fethr`.)

## More docs

- [`CHANGELOG.md`](CHANGELOG.md) — what shipped in each release
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the sidecar pattern, the safety model,
  and the debugging lessons behind the trickier fixes (worth reading before touching
  `src-tauri/`, `src/agent.js`, or the DMG build)

## License

MIT — see [LICENSE](LICENSE).
