# Changelog

All notable changes to fethr are documented here. Dates are when each version was tagged.

## v0.9.2-alpha — 2026-08-22

**Fix:** the agent now gets a real, freshly-checked git branch instead of relying on the
Claude Code harness's own session-start snapshot (which goes stale if the branch changes
mid-conversation). `/api/meta` runs `git branch --show-current` server-side; the branch is
sent as explicit context with every agent request and shown as a small badge in the sidebar
header. Also fixed: git's stderr ("fatal: not a git repository") was leaking to the console
for every non-git workspace.

## v0.9.1-alpha — 2026-08-22

**Fix — native app: 365MB → 55MB.** The Agent SDK bundles its own copy of the `claude`
binary (~310MB, an npm `optionalDependency`) even though fethr's whole premise is that the
user already has Claude Code installed. `scripts/stage-sidecar.sh` now installs with
`--omit=optional`; `src/agent.js` points the SDK at the system `claude` install via
`pathToClaudeCodeExecutable` instead. DMG: 153MB → 46MB.

## v0.9.0-alpha — 2026-08-22

**Feature: resizable panels.** Drag the divider between sidebar/editor/agent to resize;
widths persist. Fixed two real bugs surfaced while building it: dragging from a collapsed
sidebar used to jump (drag baseline read from the wrong cascade level), and the agent
panel's width was hardcoded in CSS in a way that would have silently overridden anything
the resizer set.

## v0.8.0-alpha — 2026-08-22

**Feature: context visibility + voice input.**
- Context pill row above the composer — current file, live selection, plus anything
  attached — makes explicit what the agent actually sees.
- `@`-mention autocomplete to attach any workspace file.
- Clickable `file:line` references in agent replies jump the editor there.
- Mic button does live speech-to-text via the Web Speech API (Chromium only, verified;
  untested in the native app's WebKit view).

## v0.7.0-alpha — 2026-08-21

**Feature: the native app shell gets the full agent panel (v0.3 + v0.4 unified).** Instead
of reimplementing file/agent APIs in Rust, the app bundles the same Node server as a
sidecar and points the window at it. See `docs/ARCHITECTURE.md` for the four distinct bugs
found getting this working (PATH resolution, a hanging login-shell approach, a missing
import, and a staging script that forgot to copy `dist/`).

## v0.6.0-alpha — 2026-08-21

Window resize hardening, auto-apply mode for agent proposals, Fable 5 in the model picker,
collapsible sidebar (⌘B).

## v0.5.1-alpha — 2026-08-21

**Fix:** the agent panel's input field was disabled in the app shell — keystrokes did
nothing. Caught by a real-browser (puppeteer) regression test added the same release.

## v0.5.0-alpha — 2026-08-21

**Feature: live agent UI.** Status line (thinking/tool/writing phases), streamed thinking
in a collapsible block, per-tool activity detail, stop button, model picker.

## v0.4.0-alpha — 2026-08-21

**Feature: the agent panel.** Claude Agent SDK as a peer process (CLI mode) — read-only by
construction (Read/Grep/Glob only, every mutating tool disallowed), with `propose_edit` as
the sole change mechanism. Proposals render as diff cards the writer accepts or rejects.

## v0.1.0-alpha — 2026-08-21

**Feature: the editor exists.** Local server + browser as the shell (no Electron),
CodeMirror 6 core, file tree, syntax highlighting, edit and save.

## v0.0.2-alpha — 2026-08-21

Name reservation: placeholder CLI, dynamic versioning from `package.json`.

---

For the *why* behind the trickier decisions in this history — the sidecar architecture,
the DMG signing workaround, the node/claude executable discovery pattern — see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
