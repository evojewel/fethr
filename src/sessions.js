// Claude Code sessions on this machine, and fethr's recently opened folders.
// Both feed the home screen (docs/plans/home-screen.md).
//
// Sessions come from Claude Code's own transcripts: one JSONL file per
// session at <config>/projects/<encoded-cwd>/<session-id>.jsonl, written by
// the CLI, the VS Code/Cursor extension and the Agent SDK alike, so the list
// covers sessions started anywhere. That format is internal to Claude Code
// and undocumented. Every field read here is treated as optional, and a file
// that fails to parse drops that one session, never the list.
//
// Paths: the only thing a client ever supplies is a session id, checked
// against SESSION_ID_RE before it goes near the filesystem. No path from a
// request is ever joined.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { findClaudeExecutable } from "./claude-path.js";
import { readState, writeState } from "./state.js";

export const SESSION_ID_RE = /^[0-9a-f-]{36}$/;
const TRANSCRIPT_RE = /^[0-9a-f-]{36}\.jsonl$/;
// Subagent transcripts: <project>/<session-id>/subagents/agent-<agentId>.jsonl,
// or one level deeper under workflows/wf_<id>/ for workflow agents.
export const AGENT_ID_RE = /^[0-9a-z]{1,64}$/;
const AGENT_FILE_RE = /^agent-([0-9a-z]{1,64})\.jsonl$/;
const MAX_SUBAGENT_DEPTH = 3; // subagents/workflows/wf_x/agent-*.jsonl

// The list parses only the newest sessions, and only a window at each end of
// each file: transcripts run to tens of MB (the largest seen locally is 160
// MB), and the list needs just the first prompt (near the head) and the
// latest title (appended over time, so near the tail).
const MAX_LISTED = 200;
const WINDOW_BYTES = 256 * 1024;
const TITLE_CHARS = 80;
const PROMPT_CHARS = 500;
const LIVE_MS = 120_000;
// A subagent file written this recently is taken as still working.
const AGENT_ACTIVE_MS = 60_000;
// A completion notice counts only if it is no older than the agent's last
// write (with this much slack): agents get resumed after a notice, and then
// the file's mtime is the newer truth.
const NOTICE_SLACK_MS = 5_000;
const MAX_META_BYTES = 64 * 1024;

// History reads the whole of a transcript up to this size, and only its tail
// beyond it. 8 of 154 transcripts on the author's machine were over 50 MB
// (the largest 161 MB), and those are the long sessions most worth resuming;
// the last 8 MB holds far more than the 200 entries the page shows.
const HISTORY_WINDOW_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 200;
// One pasted log can be megabytes; the page shows past turns as context, not
// as an archive.
const MAX_ENTRY_CHARS = 20_000;

const MAX_RECENT = 30;

// `claude agents --json` (which sessions are open right now) is a process
// spawn, so its answer is reused for a few seconds across home renders.
const OPEN_TIMEOUT_MS = 3_000;
const OPEN_CACHE_MS = 5_000;

export function isSessionId(id) {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

// Read at call time, not import time, so tests can point it at a fixture.
export function projectsDir() {
  const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(config, "projects");
}


// ---------------------------------------------------------------- parsing

function parseLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object") out.push(r);
    } catch { /* a torn or foreign line costs that line only */ }
  }
  return out;
}

function readSlice(fd, start, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, start);
  return buf.subarray(0, n).toString("utf8");
}

// The last `bytes` of an open file. The window almost always starts mid-line;
// that partial first line is dropped rather than misparsed.
function readTail(fd, size, bytes) {
  const tail = readSlice(fd, size - bytes, bytes);
  return tail.slice(tail.indexOf("\n") + 1);
}

// The head and tail windows of a transcript, as parsed records. A window that
// cuts a line in half drops that partial line rather than misparse it.
function readWindows(file, size) {
  const fd = fs.openSync(file, "r");
  try {
    if (size <= 2 * WINDOW_BYTES) {
      const all = parseLines(readSlice(fd, 0, size));
      return { head: all, tail: [] };
    }
    let head = readSlice(fd, 0, WINDOW_BYTES);
    head = head.slice(0, head.lastIndexOf("\n") + 1);
    return { head: parseLines(head), tail: parseLines(readTail(fd, size, WINDOW_BYTES)) };
  } finally {
    fs.closeSync(fd);
  }
}

// Claude Code's own records that are typed "user" but were never typed by
// one: the summary written when a long session is compacted ("This session
// is being continued from a previous conversation…") carries both flags.
// Without this check it became the session's first prompt and title, and a
// user turn in the history.
function isCompaction(record) {
  return !!(record && (record.isCompactSummary || record.isVisibleInTranscriptOnly));
}

// The text a person typed, or null. Records that start with "<" are harness
// wrappers (slash-command echoes, local command output, reminders), not prompts.
// sidechain: a subagent's own transcript is all sidechain records, so its
// history view asks for them; a session's history never does.
function promptText(record, { sidechain = false } = {}) {
  if (!record || record.type !== "user" || record.isMeta || isCompaction(record)) return null;
  if (record.isSidechain && !sidechain) return null;
  const content = record.message && record.message.content;
  const parts = typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text)
      : [];
  const text = parts.filter((t) => !t.trimStart().startsWith("<")).join("\n\n").trim();
  return text || null;
}

// What the list needs from a transcript's records. Records come in file order.
function summarize(records) {
  let cwd = null, entrypoint = null, firstPrompt = null;
  let customTitle = null, aiTitle = null, lastPrompt = null, firstAt = null, continuedIn = null;
  for (const r of records) {
    if (firstAt === null && typeof r.timestamp === "string") {
      const t = Date.parse(r.timestamp);
      if (Number.isFinite(t)) firstAt = t;
    }
    if (!cwd && typeof r.cwd === "string" && r.cwd) cwd = r.cwd;
    if (!entrypoint && typeof r.entrypoint === "string" && r.entrypoint) entrypoint = r.entrypoint;
    if (!firstPrompt) firstPrompt = promptText(r);
    if (r.type === "custom-title" && typeof r.customTitle === "string" && r.customTitle.trim()) customTitle = r.customTitle.trim();
    if (r.type === "ai-title" && typeof r.aiTitle === "string" && r.aiTitle.trim()) aiTitle = r.aiTitle.trim();
    if (r.type === "last-prompt" && typeof r.lastPrompt === "string" && r.lastPrompt.trim()) lastPrompt = r.lastPrompt.trim();
    if (r.type === "continued-in" && isSessionId(r.continuedInSessionId)) continuedIn = r.continuedInSessionId;
  }
  return { cwd, entrypoint, firstPrompt, customTitle, aiTitle, lastPrompt, firstAt, continuedIn };
}

function oneLine(s, max) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function titleOf(sum) {
  if (sum.customTitle) return oneLine(sum.customTitle, TITLE_CHARS * 2);
  if (sum.aiTitle) return oneLine(sum.aiTitle, TITLE_CHARS * 2);
  // A session whose opening turn fell outside the head window still has the
  // harness's own "last-prompt" record to name it by.
  const p = sum.firstPrompt || sum.lastPrompt;
  return p ? oneLine(p, TITLE_CHARS) : null;
}

// Cache by (path, mtime, size): the list is fetched on every home render, and
// most transcripts have not changed since the last one.
const cache = new Map();

function parseTranscript(file, st) {
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.sum;
  const { head, tail } = readWindows(file, st.size);
  const h = summarize(head);
  const t = summarize(tail);
  // Identity and first prompt from the head; titles from whichever window
  // holds the latest one (the tail, when it exists).
  const sum = {
    cwd: h.cwd || t.cwd,
    entrypoint: h.entrypoint || t.entrypoint,
    firstPrompt: h.firstPrompt,
    customTitle: t.customTitle || h.customTitle,
    aiTitle: t.aiTitle || h.aiTitle,
    lastPrompt: t.lastPrompt || h.lastPrompt,
    firstAt: h.firstAt ?? t.firstAt,
    // Written into the OLD transcript when Claude Code continues a session
    // under a new id (for example a CLI session that became a background
    // one). Appended late, so the tail holds the latest.
    continuedIn: t.continuedIn || h.continuedIn,
  };
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, sum });
  return sum;
}

// ---------------------------------------------------------------- sessions

function sourceOf(entrypoint) {
  if (!entrypoint) return null;
  if (entrypoint === "cli") return "CLI";
  if (entrypoint === "claude-vscode") return "VS Code / Cursor";
  if (entrypoint.startsWith("sdk-")) return "SDK";
  return entrypoint;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const TEMP_ROOTS = (() => {
  const roots = new Set(["/private/var/folders", "/var/folders", "/private/tmp", "/tmp", os.tmpdir()]);
  try { roots.add(fs.realpathSync(os.tmpdir())); } catch { /* keep the lexical one */ }
  return [...roots];
})();

function isTemp(cwd) {
  return TEMP_ROOTS.some((t) => cwd === t || cwd.startsWith(t.endsWith(path.sep) ? t : t + path.sep));
}

// Where a session state comes from, strongest first: Claude Code's own list
// of open sessions, then how recently anything (the session or one of its
// subagents) was written.
function stateOf(o, lastActivity, now) {
  if (o && o.kind === "background") return "background";
  if (o) return o.status === "busy" ? "busy" : "open";
  return now - lastActivity < LIVE_MS ? "recent" : "closed";
}

function toSession(id, file, st, sum, now, open = null) {
  const cwd = sum.cwd;
  const o = (open && open.get(id)) || null;
  const agents = subagentFiles(file, id);
  const lastActivity = agents.reduce((m, a) => Math.max(m, a.st.mtimeMs), st.mtimeMs);
  return {
    id,
    cwd,
    project: cwd ? path.basename(cwd) : path.basename(path.dirname(file)),
    title: titleOf(sum),
    firstPrompt: sum.firstPrompt ? sum.firstPrompt.slice(0, PROMPT_CHARS) : null,
    source: sourceOf(sum.entrypoint),
    mtime: st.mtimeMs,
    size: st.size,
    cwdExists: cwd ? isDir(cwd) : false,
    temp: cwd ? isTemp(cwd) : false,
    live: now - st.mtimeMs < LIVE_MS,
    open: o ? { kind: o.kind, status: o.status } : null,
    continuedIn: sum.continuedIn || null,
    startedAt: (o && o.startedAt) ?? sum.firstAt ?? null,
    lastActivity,
    state: stateOf(o, lastActivity, now),
    subagents: {
      total: agents.length,
      active: agents.filter((a) => now - a.st.mtimeMs < AGENT_ACTIVE_MS).length,
    },
  };
}

// A session's subagent transcripts, from readdir and stat alone: the list
// shows counts, so nothing is parsed here. Other files in the tree (a
// workflow's journal.jsonl, the .meta.json siblings) are not agents.
function subagentFiles(sessionFile, id) {
  const root = path.join(path.dirname(sessionFile), id, "subagents");
  const out = [];
  const walk = (dir, depth, workflow) => {
    for (const d of readDirents(dir)) {
      if (d.isDirectory()) {
        if (depth < MAX_SUBAGENT_DEPTH) walk(path.join(dir, d.name), depth + 1, depth === 0 ? workflow : d.name);
        continue;
      }
      const m = d.isFile() && AGENT_FILE_RE.exec(d.name);
      if (!m) continue;
      const file = path.join(dir, d.name);
      try {
        out.push({ agentId: m[1], file, workflow, st: fs.statSync(file) });
      } catch { /* gone between readdir and stat */ }
    }
  };
  walk(root, 0, null);
  return out;
}

function readDirents(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Every top-level transcript, stat'ed. Subagent transcripts live a level
// deeper (<session-id>/subagents/...) and are not sessions of their own.
function allTranscripts() {
  const root = projectsDir();
  const out = [];
  for (const d of readDirents(root)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    for (const f of readDirents(dir)) {
      if (!f.isFile() || !TRANSCRIPT_RE.test(f.name)) continue;
      const file = path.join(dir, f.name);
      try {
        const st = fs.statSync(file);
        if (st.size > 0) out.push({ id: f.name.slice(0, 36), file, st });
      } catch { /* deleted between readdir and stat */ }
    }
  }
  return out;
}

// Newest first. Sessions with neither a prompt nor a title (a transcript of
// only harness bookkeeping) are left out: there is nothing to show for them.
// `open` is the Map from openSessions(), or null when that is unknown.
export function listSessions({ limit = MAX_LISTED, now = Date.now(), open = null } = {}) {
  const files = allTranscripts().sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, limit);
  const out = [];
  for (const { id, file, st } of files) {
    try {
      const sum = parseTranscript(file, st);
      if (!sum.firstPrompt && !sum.customTitle && !sum.aiTitle && !sum.lastPrompt) continue;
      out.push(toSession(id, file, st, sum, now, open));
    } catch { /* unreadable: drop this one */ }
  }
  // Link moved sessions both ways when both ends are listed, so the page can
  // fold the old one under its successor.
  const byId = new Map(out.map((s) => [s.id, s]));
  for (const s of out) {
    s.continuedFrom = [];
    s.superseded = false;
  }
  for (const s of out) {
    const next = s.continuedIn && byId.get(s.continuedIn);
    if (next && next !== s) {
      next.continuedFrom.push(s.id);
      s.superseded = true;
    }
  }
  return out;
}

const MAX_CONTINUATION_HOPS = 5;

// The session an id now lives on as: follow continued-in links (at most 5
// hops, never around a loop) while the next transcript exists. An id with no
// link, or whose successor is not on this machine, is its own answer.
export function latestContinuation(id) {
  const seen = new Set([id]);
  let cur = id;
  for (let hop = 0; hop < MAX_CONTINUATION_HOPS; hop++) {
    const s = getSession(cur);
    const next = s && s.continuedIn;
    if (!next || seen.has(next) || !findSessionFile(next)) break;
    seen.add(next);
    cur = next;
  }
  return cur;
}

// The transcript for an id, or null. The id is the only input and is
// validated first; the path is built from the projects dir and directory
// entries this process listed itself. If the id appears under two project
// dirs, the most recently written file wins.
export function findSessionFile(id) {
  if (!isSessionId(id)) return null;
  const root = projectsDir();
  let best = null;
  for (const d of readDirents(root)) {
    if (!d.isDirectory()) continue;
    const file = path.join(root, d.name, id + ".jsonl");
    try {
      const st = fs.statSync(file);
      if (st.isFile() && (!best || st.mtimeMs > best.st.mtimeMs)) best = { file, st };
    } catch { /* not in this project */ }
  }
  return best;
}

// One session's list entry, or null when the id is unknown or unreadable.
export function getSession(id, now = Date.now(), open = null) {
  const found = findSessionFile(id);
  if (!found || found.st.size === 0) return null;
  try {
    return toSession(id, found.file, found.st, parseTranscript(found.file, found.st), now, open);
  } catch {
    return null;
  }
}

function toolText(block) {
  const name = String(block.name || "tool").replace(/^mcp__.+?__/, "");
  const i = block.input && typeof block.input === "object" ? block.input : {};
  const detail =
    i.file_path || i.path || i.pattern || i.query ||
    (typeof i.command === "string" ? i.command.slice(0, 60) : "") || "";
  return detail ? `${name} ${detail}` : name;
}

function capText(s) {
  return s.length > MAX_ENTRY_CHARS ? s.slice(0, MAX_ENTRY_CHARS) + "…" : s;
}

// A transcript's records for history: the whole file, or only its last
// HISTORY_WINDOW_BYTES (truncated: true) when it is bigger than that.
function readForHistory(file, size) {
  const fd = fs.openSync(file, "r");
  try {
    if (size <= HISTORY_WINDOW_BYTES) return { records: parseLines(readSlice(fd, 0, size)), truncated: false };
    return { records: parseLines(readTail(fd, size, HISTORY_WINDOW_BYTES)), truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

// A session's past turns for display: the person's prompts, the assistant's
// text (streamed as one record per block, merged back per message), tool
// calls as one line each, and a marker where the context was compacted.
// Thinking, tool results and sidechains are left out. Returns null for an
// unknown id.
//
// omitted counts entries dropped from what was read (beyond the last 200).
// truncated says the file was bigger than the read window, so there are also
// earlier turns, of unknown number, that were never read.
//
// agentId: one of the session's subagents instead, read-only. It is found
// only by listing that session's own subagents tree, never joined as a path.
export function sessionHistory(id, { agentId = null } = {}) {
  const found = findSessionFile(id);
  if (!found) return null;
  let file = found.file, st = found.st, agent = null;
  if (agentId !== null) {
    if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) return null;
    agent = subagentFiles(found.file, id).find((a) => a.agentId === agentId);
    if (!agent) return null;
    ({ file, st } = agent);
  }
  const sidechain = !!agent;
  const { records, truncated } = readForHistory(file, st.size);
  const entries = [];
  let lastMsgId; // message id of the assistant text entry at the end, if any
  for (const r of records) {
    if (r.isSidechain && !sidechain) continue;
    if (r.type === "user" && isCompaction(r)) {
      // One marker per compaction; a transcript-only record without the
      // summary flag is not a compaction and is simply left out.
      if (r.isCompactSummary) {
        entries.push({ type: "tool", text: "context compacted" });
        lastMsgId = undefined;
      }
      continue;
    }
    if (r.type === "user") {
      const text = promptText(r, { sidechain });
      if (text) {
        entries.push({ type: "user", text: capText(text) });
        lastMsgId = undefined;
      }
      continue;
    }
    if (r.type !== "assistant") continue;
    const msg = r.message || {};
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        const prev = entries[entries.length - 1];
        if (prev && prev.type === "assistant" && lastMsgId === msg.id) {
          prev.text = capText(prev.text + "\n\n" + b.text);
        } else {
          entries.push({ type: "assistant", text: capText(b.text) });
          lastMsgId = msg.id;
        }
      } else if (b.type === "tool_use") {
        entries.push({ type: "tool", text: toolText(b) });
        lastMsgId = undefined;
      }
    }
  }
  // Folder and title as the list shows them (head and tail windows), not from
  // the history window, which for a big file has lost the opening turns.
  const sum = parseTranscript(found.file, found.st);
  const omitted = Math.max(0, entries.length - MAX_HISTORY_ENTRIES);
  let title = titleOf(sum);
  if (agent) {
    const meta = readAgentMeta(agent.file);
    title = meta.description || meta.agentType || `agent ${agentId}`;
  }
  return {
    id,
    ...(agent ? { agentId } : {}),
    cwd: sum.cwd,
    title,
    // Where the session was started, labelled as in the list, so the page
    // can tell the agent (resumed: {source}).
    source: sourceOf(sum.entrypoint),
    entries: entries.slice(omitted),
    omitted,
    truncated,
  };
}

// ---------------------------------------------------------------- subagents

// agent-<id>.meta.json beside the transcript: {agentType, description, …}.
// Missing or malformed is an empty object.
function readAgentMeta(agentFile) {
  const metaFile = agentFile.replace(/\.jsonl$/, ".meta.json");
  try {
    if (fs.statSync(metaFile).size > MAX_META_BYTES) return {};
    const m = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

// When a subagent started: the first timestamp in the first few records.
// Only a small head is read (a session can have hundreds of agents, and the
// full head/tail parse cost ~3 ms each); cached by (path, mtime, size).
const AGENT_HEAD_BYTES = 16 * 1024;
const startCache = new Map();
function agentStartedAt(file, st) {
  const hit = startCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.at;
  let at = null;
  const fd = fs.openSync(file, "r");
  try {
    let head = readSlice(fd, 0, Math.min(st.size, AGENT_HEAD_BYTES));
    if (st.size > AGENT_HEAD_BYTES) head = head.slice(0, head.lastIndexOf("\n") + 1);
    at = summarize(parseLines(head)).firstAt;
  } finally {
    fs.closeSync(fd);
  }
  startCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, at });
  return at;
}

const NOTICE_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;

// What the parent transcript says about its subagents, from its last
// HISTORY_WINDOW_BYTES only. Cached by (path, mtime, size) like the list.
//
// notices: background agents report back as a "user" record carrying
// <task-notification> with <task-id> and <status>; the subagent's own file
// has no such marker. Latest notice per task id wins.
//
// toolResults: the tool_use ids answered by a tool_result. A foreground
// agent's tool call returns only when the agent is done, so its result means
// finished. A background agent's call returns at launch, so its result means
// nothing about the end; listSubagents ignores it for those.
const parentCache = new Map();
function parentSignals(file, st) {
  const hit = parentCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.signals;
  const notices = new Map();
  const toolResults = new Set();
  const { records } = readForHistory(file, st.size);
  for (const r of records) {
    if (r.type !== "user") continue;
    const c = r.message && r.message.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === "tool_result" && typeof b.tool_use_id === "string") toolResults.add(b.tool_use_id);
      }
    }
    const text = typeof c === "string"
      ? c
      : Array.isArray(c) ? c.filter((b) => b && typeof b.text === "string").map((b) => b.text).join("\n") : "";
    if (!text.includes("<task-notification>")) continue;
    const at = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    if (!Number.isFinite(at)) continue;
    for (const m of text.matchAll(NOTICE_RE)) {
      const taskId = /<task-id>([^<]*)<\/task-id>/.exec(m[1]);
      const status = /<status>([^<]*)<\/status>/.exec(m[1]);
      if (!taskId || !status) continue;
      const prev = notices.get(taskId[1].trim());
      if (!prev || at >= prev.at) notices.set(taskId[1].trim(), { status: status[1].trim(), at });
    }
  }
  const signals = { notices, toolResults };
  parentCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, signals });
  return signals;
}

// completed reads as "finished"; failed, killed, stopped pass through.
function noticeState(status) {
  return status === "completed" ? "finished" : status || "unknown";
}

// An agent's state, strongest evidence first:
//   1. a notice no older than its last write (agents get resumed after one)
//   2. foreground: its tool call has a result in the parent
//   3. written in the last minute: active
//   4. the open-sessions list is known and the parent is not in it: ended
//      (a subagent runs inside its parent's process, so it cannot be running)
//   5. the parent is open: idle
//   6. otherwise (the list is unknown): unknown
function agentState({ notice, meta, mtime, toolResults, now, open, parentId }) {
  if (notice && notice.at >= mtime - NOTICE_SLACK_MS) return noticeState(notice.status);
  const foreground = meta.requestShape !== "background";
  if (foreground && typeof meta.toolUseId === "string" && toolResults.has(meta.toolUseId)) return "finished";
  if (now - mtime < AGENT_ACTIVE_MS) return "active";
  if (open && !open.get(parentId)) return "ended";
  if (open) return "idle";
  return "unknown";
}

// A session's subagents, newest first, or null for an unknown session.
// `open` is the openSessions() Map, or null when that list is unknown.
export function listSubagents(id, { now = Date.now(), open = null } = {}) {
  const found = findSessionFile(id);
  if (!found) return null;
  const files = subagentFiles(found.file, id);
  if (!files.length) return [];
  let signals = { notices: new Map(), toolResults: new Set() };
  try { signals = parentSignals(found.file, found.st); } catch { /* states fall back to mtime */ }
  const out = [];
  for (const a of files) {
    const meta = readAgentMeta(a.file);
    let startedAt = null;
    try { startedAt = agentStartedAt(a.file, a.st); } catch { /* unknown */ }
    const mtime = a.st.mtimeMs;
    const state = agentState({
      notice: signals.notices.get(a.agentId), meta, mtime, toolResults: signals.toolResults, now, open, parentId: id,
    });
    out.push({
      agentId: a.agentId,
      workflow: a.workflow,
      description: typeof meta.description === "string" ? meta.description : null,
      agentType: typeof meta.agentType === "string" ? meta.agentType : null,
      startedAt,
      lastActivity: mtime,
      size: a.st.size,
      state,
    });
  }
  return out.sort((x, y) => y.lastActivity - x.lastActivity);
}

// ---------------------------------------------------------------- open sessions

// Which sessions are open in Claude Code right now. The mtime-based `live`
// flag misses an idle one, and resuming a session that runs as a Claude Code
// background session fails outright ("running in the background … claude
// attach"). `claude agents --json` lists every active session, interactive
// and background, as [{sessionId, kind, status, …}]. Including, correctly,
// the one a fethr agent panel is in the middle of.

// [command, args] that run `claude <args>`, or null when there is no claude.
// On Windows an npm-global install is a cli.js, which needs node to run.
function claudeCommand(bin, args) {
  if (!bin) return null;
  return bin.endsWith(".js") ? [process.execPath, [bin, ...args]] : [bin, args];
}

// Resolves to the parsed JSON, or null for any failure: no claude binary, an
// older claude without the command, a timeout, output that is not JSON.
function runClaudeAgents() {
  return new Promise((resolve) => {
    const c = claudeCommand(findClaudeExecutable(), ["agents", "--json"]);
    if (!c) return resolve(null);
    execFile(c[0], c[1], { timeout: OPEN_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

let openRunner = runClaudeAgents;
let openCache = null; // { at, promise }

// Tests swap in a fake runner instead of spawning the real claude.
export function setOpenSessionsRunner(fn) {
  openRunner = fn || runClaudeAgents;
  openCache = null;
}

function toOpenMap(list) {
  if (!Array.isArray(list)) return null;
  const map = new Map();
  for (const a of list) {
    if (!a || !isSessionId(a.sessionId)) continue;
    map.set(a.sessionId, {
      kind: typeof a.kind === "string" ? a.kind : null,
      status: typeof a.status === "string" ? a.status : null,
      startedAt: Number.isFinite(a.startedAt) ? a.startedAt : null,
    });
  }
  return map;
}

// Map of session id -> {kind, status}, or null when unknown. Never rejects.
// fresh: skip the cache (the open-time check must not act on a 5 s old list).
export function openSessions({ fresh = false } = {}) {
  const now = Date.now();
  if (fresh || !openCache || now - openCache.at > OPEN_CACHE_MS) {
    const promise = Promise.resolve()
      .then(() => openRunner())
      .then(toOpenMap, () => null);
    openCache = { at: now, promise };
  }
  return openCache.promise;
}

// ---------------------------------------------------------------- background sessions

// What a person can do about a session Claude Code is running in the
// background, besides forking it: watch it in a terminal (`claude attach`,
// the session keeps running) or stop it (`claude stop`, its conversation is
// kept) and then resume it here. Both take the 8-character id prefix, which
// is what Claude Code's own messages show.

const STOP_TIMEOUT_MS = 10_000;
const STOP_SETTLE_MS = 5_000;
const STOP_POLL_MS = 250;

function execFileResult(cmd, args, options) {
  return new Promise((resolve) => {
    execFile(cmd, args, options, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

let execRunner = execFileResult;
let claudePath = findClaudeExecutable;

// Tests swap in a fake execFile (and a claude path, for machines without one).
export function setExecRunner(fn, { claudePath: pathFn } = {}) {
  execRunner = fn || execFileResult;
  claudePath = pathFn || findClaudeExecutable;
}

// The last few lines a failed command wrote, as one line for the page.
function errorTail(stderr, fallback) {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-3).join(" · ");
  return tail ? tail.slice(-300) : fallback;
}

export function shortId(id) {
  return id.slice(0, 8);
}

// Opens Terminal running `claude attach <id8>`. The command crosses two
// quoting layers, an AppleScript string and then the shell Terminal runs, so
// the claude path is single-quoted for the shell and refused outright if it
// holds anything either layer would interpret. The id prefix is hex.
export async function attachInTerminal(id, { platform = process.platform } = {}) {
  if (platform !== "darwin") {
    return { status: 501, error: `opening a terminal is macOS only; run: claude attach ${shortId(id)}` };
  }
  const bin = claudePath();
  if (!bin) return { status: 500, error: "Claude Code (claude) not found" };
  if (/["'\\\x00-\x1f]/.test(bin)) return { status: 500, error: "claude's install path cannot be passed to Terminal safely" };
  const r = await execRunner("osascript", [
    "-e", `tell application "Terminal" to do script "'${bin}' attach ${shortId(id)}"`,
    "-e", 'tell application "Terminal" to activate',
  ], { timeout: STOP_TIMEOUT_MS });
  return r.err ? { status: 500, error: errorTail(r.stderr, "could not open Terminal") } : { ok: true };
}

// Stops the background session and waits until `claude agents` no longer
// lists it, since resuming while it is still winding down fails the same
// way it did before the stop.
export async function stopBackgroundSession(id) {
  const c = claudeCommand(claudePath(), ["stop", shortId(id)]);
  if (!c) return { status: 500, error: "Claude Code (claude) not found" };
  const r = await execRunner(c[0], c[1], { timeout: STOP_TIMEOUT_MS, windowsHide: true });
  if (r.err) return { status: 500, error: errorTail(r.stderr, "claude stop failed") };
  const deadline = Date.now() + STOP_SETTLE_MS;
  for (;;) {
    const open = await openSessions({ fresh: true });
    // null: the list is unavailable, so there is nothing more to wait on.
    if (!open || !open.has(id)) return { ok: true };
    if (Date.now() >= deadline) return { status: 409, error: "the session is still stopping; try Resume again in a moment" };
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  }
}

// ---------------------------------------------------------------- recent folders

const RECENT_FILE = "recent.json";

// Entries are {path, lastOpened, session?, hidden?}: a folder, or a folder
// plus the Claude session that was open in it, so the list can show the
// chat's name. hidden: removed from the list by the user (nothing on disk is
// touched). Entries written before sessions existed have no session and stay
// valid. A missing or bad file starts over as an empty list.
function readRecent() {
  const list = readState(RECENT_FILE, []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e.path === "string" && Number.isFinite(e.lastOpened))
    .map((e) => ({
      path: e.path,
      lastOpened: e.lastOpened,
      ...(isSessionId(e.session) ? { session: e.session } : {}),
      ...(e.hidden === true ? { hidden: true } : {}),
    }));
}

const recentKey = (e) => e.path + "\0" + (e.session || "");

// The session part is resolved per request from the cached summary, so a
// title Claude Code adds later shows up. A session that is gone keeps its
// row (the folder may still be worth opening) with session: null.
//
// hidden: false lists the visible entries, true the ones the user removed.
export function recentFolders({ now = Date.now(), open = null, hidden = false } = {}) {
  return readRecent()
    .filter((e) => !!e.hidden === hidden)
    .sort((a, b) => b.lastOpened - a.lastOpened)
    .map((e) => {
      let session = null;
      if (e.session) {
        const s = getSession(e.session, now, open);
        if (s) session = { id: s.id, title: s.title, state: s.state, open: s.open };
      }
      return { path: e.path, name: path.basename(e.path) || e.path, lastOpened: e.lastOpened, exists: isDir(e.path), session };
    });
}

// Move (or add) a folder to the top of the list, visible again if it had
// been hidden. Written through state.js (temp file + rename,
// last-writer-wins with a narrow window: two windows starting at the same
// moment can drop one entry, which the next launch repairs; a lock file is
// not worth it here). A failure (read-only home, full disk) must not stop
// the editor, so it is swallowed.
//
// session: record the folder together with that session (deduped on
// folder + session). dropPlain: also remove the folder's sessionless entry,
// for a folder whose chat now has a name.
export function upsertRecent(folder, { session = null, dropPlain = false, now = Date.now() } = {}) {
  try {
    const entry = { path: folder, lastOpened: now, ...(session ? { session } : {}) };
    const key = recentKey(entry);
    const list = readRecent().filter((e) => recentKey(e) !== key && !(dropPlain && e.path === folder && !e.session));
    list.push(entry);
    list.sort((a, b) => b.lastOpened - a.lastOpened);
    writeState(RECENT_FILE, list.slice(0, MAX_RECENT));
  } catch { /* see above */ }
}

// Hide or unhide one entry (keyed on folder + session, as upsert is).
// Returns { ok: true } or { status, error }. Its place in the list is kept.
export function setRecentHidden(folder, session, hidden) {
  const key = recentKey({ path: folder, session });
  const list = readRecent();
  const entry = list.find((e) => recentKey(e) === key);
  if (!entry) return { status: 404, error: "not in the recent list" };
  if (hidden) entry.hidden = true;
  else delete entry.hidden;
  try {
    writeState(RECENT_FILE, list);
  } catch (e) {
    return { status: 500, error: "could not save the recent list: " + (e.code || e.message) };
  }
  return { ok: true };
}
