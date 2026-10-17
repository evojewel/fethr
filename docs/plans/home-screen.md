# Home screen: open a folder or a past Claude session

**Date:** 2026-10-17
**Status:** Built 2026-10-17, uncommitted. Grew beyond this plan during the build: session state, subagents, moved sessions, agent-only windows, full mode, preferences. CHANGELOG "Unreleased" and ARCHITECTURE are the current description; this file records the original contract.
**Scope:** `bin/fethr.js`, `src/server.js`, new `src/sessions.js`, `src/agent.js` (fork flag), `web/`, `src-tauri/src/lib.rs`
**Last-verified:** 2026-10-17 against main @ 637b251

## What it is

Launching fethr with no folder opens a **home** window with two entry points:

1. **Open a folder**: "Open folder…" (native picker) plus a list of recently opened folders.
2. **Open a session**: every Claude Code session on this machine (from `~/.claude/projects`, so it
   includes sessions started in the CLI, the VS Code/Cursor extension and fethr itself), newest first,
   searchable. Each row has **Resume** (continue the same session) and **Fork** (new session id,
   original transcript untouched).

Each folder or session opens in **its own window with its own sidecar**. The home window stays open.

## Why this shape

- The server's root is fixed per process and the launch token rides in the URL
  (`src/server.js` `serve()`, the token block at the top). A window per folder keeps both intact. The
  alternative, a server whose root can change, would touch every function that closes over `root`.
- The agent panel already maps to Claude session ids: the SDK's init `session_id` is emitted as
  `{type:"session"}` (`src/agent.js`, the `for await` loop) and sent back as `resume`. Resuming a
  session from `~/.claude/projects` therefore needs no new agent code, only `forkSession` for Fork.
- A session belongs to a working directory. The SDK resumes with `cwd: root`, so a session must open
  in the folder it was recorded in. **The server derives the root from the session file, never from
  the client.**

## Contract between the pieces

### CLI flags (`bin/fethr.js`)

| Invocation | Meaning |
|---|---|
| `fethr [dir]` | unchanged: open `dir` (default cwd) |
| `fethr --home` | open the home page |
| `fethr <dir> --session <uuid> [--fork]` | open `dir` and resume (or fork) that session |
| `... --sidecar` | any of the above, spawned by the native shell |

Parse flags explicitly: `--session` takes a value, so the "first non-`--` arg is the dir" rule no
longer holds.

### Server (`serve(root, onReady, opts)`)

New opts: `home: true` (root is `null`), `session: {id, fork}`, `onOpen(target)` (see `/api/open`).

| Endpoint | Modes | Response |
|---|---|---|
| `GET /api/meta` | both | home: `{mode:"home", version, channel}`. Editor: as today plus `mode:"editor"` and, when launched with a session, `resume:{id, fork, title}` |
| `GET /api/home` | both | `{recentFolders:[{path, name, lastOpened, exists}], sessions:[Session]}` |
| `GET /api/session-history?id=<uuid>` | both | `{id, cwd, title, entries:[{type:"user"\|"assistant"\|"tool", text}], omitted:<n>}` |
| `POST /api/open` | both | body is one of `{root}`, `{session, fork}`, `{pick:true}`, `{home:true}`. Returns `{ok:true}` or `{error}` |

`Session` = `{id, cwd, project, title, firstPrompt, source, mtime, size, cwdExists, temp, live}`.

- `title`: last `custom-title.customTitle`, else last `ai-title.aiTitle`, else the first prompt cut to 80 chars.
- `source`: from the `entrypoint` field: `cli` → "CLI", `claude-vscode` → "VS Code / Cursor",
  `sdk-*` → "SDK", otherwise the raw value. Best effort only: a process launched from an
  editor terminal inherits that editor's entrypoint.
- `temp`: cwd is under `os.tmpdir()`, `/private/var/folders` or `/private/tmp`. Hidden by default in the UI.
- `live`: file modified in the last 120 s. It may be open elsewhere, so the UI recommends Fork.

`/api/open` resolution:
- `{session}`: look the id up server-side, `root = session.cwd`. 404 if unknown, 409 if cwd is gone.
- `{root}`: must be an existing directory.
- Then call `opts.onOpen(target)` where `target = {root, session?, fork?} | {pick:true} | {home:true}`.
  - **Sidecar** (`bin/fethr.js` wires this): print one line `FETHR_OPEN=<json>` to stdout. The Rust
    shell acts on it.
  - **CLI** (default when no `onOpen`): spawn a detached `node bin/fethr.js <args>` (passing `--app`
    through), which opens its own tab. `{pick:true}` on macOS runs
    `osascript -e 'POSIX path of (choose folder)'`; elsewhere it returns 501 and the page shows a path box.

### Sessions source (`src/sessions.js`)

- Directory: `$CLAUDE_CONFIG_DIR/projects` if set, else `~/.claude/projects`.
- Only top-level `<dir>/<uuid>.jsonl`; subagent transcripts live deeper and are skipped. Note that
  directory names start with `-`, so any shell glob over them needs `./` in front.
- Stat everything and parse only the newest 200: read the head (≤256 KB) for `cwd`, `entrypoint` and the
  first real user prompt, and the tail (≤256 KB) for titles. Skip empty files and files with neither
  a prompt nor a title. Cache by `(path, mtime, size)`.
- A "real user prompt" is a `type:"user"` record that is not `isMeta` or `isSidechain`, whose content is a
  string or `text` block, and that does not start with `<`.
- Session ids must match `^[0-9a-f-]{36}$`. Find a file by checking `<dir>/<id>.jsonl` across
  project dirs. Never build a path from anything else the client sends.
- History: user prompts, merged assistant `text` blocks, and `tool_use` as `{type:"tool", text:"Read <path>"}`.
  Return the last 200 entries; `omitted` counts the rest. Refuse files over 50 MB.
- **The format is internal to Claude Code and undocumented.** Every field read is optional; a parse
  failure drops one session, never the list.

### Recent folders

`~/.fethr/recent.json` (`$FETHR_STATE_DIR` overrides it for tests), holding `[{path, lastOpened}]`,
capped at 30. An editor-mode server upserts its root at start.

### Agent (`src/agent.js`)

The request body gains `fork: boolean`. It passes `forkSession: true` only when `fork && sessionId`.
The init event's new id then replaces `agentSession` in the page, as today.

### Page (`web/`)

- `boot()`: if `meta.mode === "home"`, render the home view (`web/home.js`) and skip the editor boot.
  The `/api/alive` ping must keep running in home mode, or the CLI reaper kills the server.
- Editor launched with `meta.resume`: do not load `chat.json`. Fetch `/api/session-history`, render
  the entries as non-live, set `agentSession = id`, and send `fork:true` on the first agent call only.
  Show the line "resumed session: <title>" or "forked from: <title> (original untouched)".
- A **home** button in the status bar posts `{home:true}`.
- **Transcript text is untrusted.** Render it through `textContent` or the existing escaped `renderMd`,
  never raw `innerHTML`.

### Native shell (`src-tauri/src/lib.rs`)

- No argv dir: open the **home** window, replacing today's blocking folder picker.
- One child per window: `HashMap<label, Child>`, killed on that window's `Destroyed` event.
  Labels are `home` (single; focus it if it already exists) and `w1`, `w2`, ….
- Each sidecar's stdout reader thread parses `FETHR_OPEN=` lines with serde_json:
  - `{root, session?, fork?}`: spawn a sidecar with matching args and open a window titled with the
    folder name. Opening a folder that is already open **without** a session focuses that window.
  - `{pick:true}`: native folder dialog, then the same as `{root}`.
  - `{home:true}`: open or focus home.
  Window creation goes through `run_on_main_thread`.
- The app quits when its last window closes, as today.

## Known gaps (accepted for v1)

- Two windows on the same folder (for example a folder plus a session in it) share
  `.fethr/chat.json`, and the last write wins.
- Resuming a session that was started in full Claude Code gives the agent that history, but the panel
  keeps fethr's read-only tool set. That is deliberate (see ARCHITECTURE "Safety model"). A
  full-capability mode is a separate decision.
- Resuming a `live` session that is still open in another tool appends to the same transcript from two
  places. The UI recommends Fork; it does not prevent Resume.

## What not to break

- The token model: each window gets its own sidecar, token and URL.
- No app-vs-CLI branching in the page. The difference lives in `onOpen`.
- Workspace confinement: `/api/file` and `/api/tree` stay root-bound. Home mode has no root, so those
  return 400 there.
- The orphan watch, find_node order and verbatim-path handling in `lib.rs`.
