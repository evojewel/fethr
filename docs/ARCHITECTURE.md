# Architecture & hard-won lessons

**Status:** current as of v0.9.2-alpha (2026-08-22)

This doc exists so the debugging in this repo's early history never has to happen twice.
For what shipped in each release, see [`CHANGELOG.md`](../CHANGELOG.md). For usage, see
[`README.md`](../README.md).

## The shape

One Node server (`src/server.js`) does everything: serves the built frontend
(`dist/index.html`, `dist/editor.js`), a small file API (`/api/meta`, `/api/tree`,
`/api/file`, `/api/chat`), and proxies agent requests to `src/agent.js`. There are two ways
to run it, and — deliberately — **no code branches on which one is active**:

- **CLI mode** (`bin/fethr.js`, `npx @evojewel/fethr`) — the server binds a random
  `127.0.0.1` port, opens the OS browser (or Chrome `--app` mode) at that URL.
- **Native app mode** (`src-tauri/`) — a Rust/Tauri shell spawns the *same* server as a
  child process ("sidecar") and points its native window at the URL it prints, instead of
  loading a static bundle. See "The sidecar" below.

`web/editor.js`'s `api` object talks to the server purely over `fetch()` — there used to be
a `window.__TAURI__`-branching transport shim for the app-shell case; it was deleted once
the sidecar made both modes identical from the frontend's point of view. If you're tempted
to add app-vs-CLI branching to the frontend again, that's very likely the wrong move —
push the difference into how the window gets its URL, not into the page's own JS.

## The sidecar (native app agent parity)

`src-tauri/src/lib.rs`'s `run()`:
1. Resolves a `node` binary by checking known install locations directly (Homebrew,
   nvm) — **not** `Command::new("node")`. GUI-launched macOS apps get launchd's bare
   `PATH`, not the Terminal shell's, so a bare invocation silently can't find a
   Homebrew/nvm-installed node even though `node` works fine for the same user in
   Terminal. A `$SHELL -l -c "node ..."` wrapper was tried first and discarded — it can
   hang indefinitely if anything in the user's shell profile is slow or interactive
   (nvm lazy-load, prompt frameworks, update checks), with no useful error.
2. Spawns `node bin/fethr.js <root> --sidecar` from `Resources/sidecar/` (staged by
   `scripts/stage-sidecar.sh`, run as part of `beforeBuildCommand`) and reads a single
   `FETHR_URL=...` line from its stdout.
3. Creates the native window pointed at that URL.
4. Kills the child on window close (matched against `window.label() == "main"` — an
   earlier version killed on *any* window-destroy event, which is wrong if the app ever
   grows a second window).

**Why the sidecar is only ~43MB staged, not ~360MB:** `@anthropic-ai/claude-agent-sdk`
ships a full copy of the `claude` binary as a platform-specific `optionalDependency`
(e.g. `claude-agent-sdk-darwin-arm64`, ~310MB — it's the whole harness, not a thin API
client). fethr's entire premise is that the user already has Claude Code installed (that
supplies the agent's login), so depending on the *binary* too is no new assumption.
`stage-sidecar.sh` installs with `--omit=optional` (skips the platform package cleanly,
not a manual `rm -rf` after the fact, with a guard that fails the build loudly if it's
somehow still present) and `src/agent.js`'s `findClaudeExecutable()` points the SDK at the
system install via the documented `pathToClaudeCodeExecutable` option. Verified repeatedly
that this behaves identically to the SDK's own bundled copy.

**Why `stage-sidecar.sh` copies `dist/`, not just `bin/` and `src/`:** `server.js` resolves
`index.html`/`editor.js` relative to itself at `../dist`. The first version of the staging
script forgot this — the sidecar would spawn, print its `FETHR_URL` line successfully (so
it *looked* alive), then crash with `ENOENT` the instant the WebView made its first HTTP
request. Caught by piping the child's `stderr` to a log file instead of `Stdio::null()`
— an earlier version had it discarded, which hid the actual crash reason for several
debugging iterations before that was noticed.

## DMG packaging without Finder automation

Tauri's built-in DMG bundler drives Finder via AppleScript to lay out icons prettily. That
needs a macOS Automation permission — a GUI-only TCC prompt with no non-interactive grant
path, on a sandboxed dev shell *or* a CI runner. `build-shell.yml` (and the local release
process) skip Tauri's DMG step (`tauri build --bundles app`, not `--bundles dmg`) and drive
`hdiutil create -format UDZO` directly against a folder containing the `.app` plus an
`Applications` symlink. Functionally identical, just unstyled.

**One consequence to know:** `cp -R`-ing the built `.app` into that staging folder
invalidates its ad-hoc code signature seal (`spctl` error: *"code has no resources but
signature indicates they must be present"*) — the signature was computed over the original
bundle, and the copy no longer matches exactly what the seal expects. Every DMG-build step
re-signs the copy afterward: `codesign --deep --force -s - <path>/fethr.app`. Skipping this
produces a DMG whose contents Gatekeeper rejects as "damaged" on first launch — not
literally damaged, just unsealed.

## Safety model (agent panel)

Same tier-thinking as this author's other CLI, `gigback`: the agent can **read** the
workspace (`Read`/`Grep`/`Glob` only — every mutating built-in tool, including `Bash`, is
in `disallowedTools`) and its *only* path to a file change is the `propose_edit` MCP tool,
which just emits an SSE event — nothing is written to disk by the tool call itself. The
frontend renders that as a diff card; **Accept** applies it as a normal editor change
(undoable with ⌘Z), and it isn't persisted until an explicit save (manual ⌘S, or
auto-save's debounced write). "Auto mode" skips the manual Accept click but never skips the
disk boundary — verified live: an auto-applied proposal changed the in-memory buffer while
the file on disk stayed byte-identical until save.

## Context correctness

Two things are given to the agent as **explicit, freshly-checked** context rather than left
for the model to infer or recall:

- **Current file + live selection** (`web/editor.js`'s `askAgent`) — shown to the user as a
  pill row above the composer, not just sent silently, so what the agent sees is visible,
  not implicit.
- **Git branch** (`src/server.js`'s `getGitBranch()`, added v0.9.2) — runs
  `git branch --show-current` server-side on every request. This exists because the Claude
  Code harness *itself* captures a git-status snapshot at session start, independent of
  anything fethr sends — real, but a snapshot: it goes stale if the branch changes
  mid-conversation (a resumed session, a checkout in another window). The agent's system
  prompt (`RULES` in `src/agent.js`) explicitly tells it to state the given branch plainly
  and to say it doesn't know rather than guess when none was given.

If you're adding a new kind of context the agent should have, follow this pattern: fetch it
server-side (don't trust the model to discover or remember it), send it explicitly per
request, and surface it somewhere visible in the UI.

## CSS custom properties: a cascade trap worth knowing about

The resizable-panel work (v0.9.0) hit the same bug twice. Grid track widths are driven by
CSS custom properties (`--sidebar-w`, `--agent-w`) set on `:root`. Two rules
(`body.sidebar-collapsed { --sidebar-w: 34px }`, `body.agent-open { --agent-w: 340px }`)
redefined those properties directly on `body`. **A property declared on an element always
wins for that element's own computed value, regardless of what an ancestor's inline style
says** — custom properties don't skip the cascade just because they're "variables." So
JS setting `--agent-w` on `document.documentElement.style` had *zero* visible effect while
`.agent-open` was present, because `body`'s own stylesheet declaration always overrode it.
Fixed by moving width control entirely into JS (`toggleAgent()` sets the variable
explicitly on open/close) and leaving the CSS classes to control only what they must
(visibility, the resizer-track width) — never a value JS also needs to own.

## Where things live

```
bin/fethr.js          CLI entry point (also the sidecar entry point, via --sidecar)
src/server.js          the one server — file API, chat persistence, static serving
src/agent.js            Agent SDK integration — tools, safety, context assembly
web/*.js, web/*.html    frontend source (bundled by esbuild into dist/)
src-tauri/              native app shell (Rust) — spawns the sidecar, owns the window
scripts/stage-sidecar.sh   builds src-tauri/sidecar/ (gitignored) before `tauri build`
test-ui/agent-panel.cjs    real-browser (puppeteer) regression suite — not run in CI
                           (no Chrome on the shellcheck/build runners); run locally
                           before any release touching web/ or src/agent.js
.github/workflows/         build-shell.yml (app+DMG), publish-npm.yml (token-based,
                           no interactive OTP)
```
