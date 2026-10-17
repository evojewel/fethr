// fethr agent panel backend — Claude Agent SDK as a peer process.
//
// Safety model (same tier-thinking as the rest of fethr):
//   - The agent can READ the workspace (Read/Grep/Glob, cwd-confined).
//   - It can NEVER write: every mutating built-in tool is disallowed.
//   - The only path to a change is propose_edit, which records a proposal
//     for the writer to review; the UI applies accepted proposals as
//     editor changes, and the writer saves. The agent never touches disk.
//
// Auth: the Agent SDK uses the machine's existing Claude Code login.
//
// The Agent SDK's own platform package (e.g. claude-agent-sdk-darwin-arm64)
// bundles a full copy of the claude binary — 300MB+, since it's the whole
// harness, not a thin API client. fethr's entire premise is that the user
// already has Claude Code installed (that's what supplies the login), so
// the sidecar staging script installs with --omit=optional to skip that
// bundled copy entirely, and findClaudeExecutable() (claude-path.js) points the SDK
// at the system install instead via pathToClaudeCodeExecutable. Verified:
// removing the bundled binary and using this option works identically to
// the SDK's built-in copy — same query(), same tools, same everything.
// (The search itself lives in claude-path.js: the session list runs
// `claude agents` with the same binary and must not load the SDK to find it.)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { findClaudeExecutable } from "./claude-path.js";

// Two modes, chosen per window by the user. readonly (the default, and
// whatever an unknown value means) is fethr's original safety model: read,
// and propose. full is an opt-in: Claude Code's own tools, run without
// prompts under the "auto" permission mode, whose classifier approves or
// denies each action. bypassPermissions is never used.
const RULES_COMMON = `
You are the agent panel inside fethr, a featherweight code editor.
The user is editing a project; their prompt may include the current file and selection.
Keep answers short and concrete; this is a side panel, not a chat site.
The <fethr_context> tag in each prompt is authoritative about which tools you have and
what mode you are in; earlier turns of a resumed conversation do not describe that.`;

const RULES_READONLY = `
You may read the workspace with Read/Grep/Glob.
You can NEVER modify files directly. To change a file, call the propose_edit tool with
the COMPLETE new content of that file — the writer reviews a diff and decides.
One proposal per file per reply.
If the prompt includes a <git_branch> tag, that is the real, checked branch — state it
plainly. If it's absent, you do not know the branch (you have no Bash tool to check it
yourself) — say you don't have that information rather than guessing one.
When a tool you want is unavailable, say plainly that this window is in read-only mode, and
that switching it to full (the read-only | full switch at the top of the agent panel) gives
you Claude Code's tools here, in this same conversation. That is the main option to offer:
do not send the user to another app or terminal to continue. Otherwise offer what works now:
a read-only check with Read/Grep/Glob, or a propose_edit. Never read settings files or
configuration to work out why a tool is missing; the answer is always the window's mode.
A resumed conversation may contain earlier turns from Claude Code with more tools (Bash,
Edit, subagents). Those turns do not describe what you can do now.`;

const RULES_FULL = `
You have Claude Code's tools, and they run without asking the user. Make real edits with
Edit/Write; the user sees them in their editor as you make them. Use propose_edit only
when the user asks for a proposal to review first.
If the prompt includes a <git_branch> tag, that is the real, checked branch.
An auto-mode classifier may block an action it judges risky. When that happens, say what
was blocked and offer an alternative; do not try to work around the block.`;

export function rulesFor(mode) {
  return RULES_COMMON + (normalizeMode(mode) === "full" ? RULES_FULL : RULES_READONLY);
}

// The agent's tool set, in one place: these arrays go to the SDK as they are,
// and fethrContext() below tells the model the same lists, so the two cannot
// drift. Everything that writes, runs commands, reaches the network or
// spawns subagents is out ("Task" and "Agent" are the subagent tool's old
// and current names).
export const PROPOSE_EDIT = "mcp__fethr__propose_edit";
export const ALLOWED_TOOLS = ["Read", "Grep", "Glob", PROPOSE_EDIT];
export const DISALLOWED_TOOLS = [
  "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash",
  "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "KillShell", "BashOutput",
];

export function normalizeMode(mode) {
  return mode === "full" ? "full" : "readonly";
}

// The SDK options that differ by mode, in one place: runAgent spreads these
// into query(), and fethrContext() and the tests read the same objects.
// full sets no tool lists at all (the fethr MCP server, and so propose_edit,
// is added for both modes), and never bypassPermissions.
export const MODE_OPTIONS = {
  readonly: { allowedTools: ALLOWED_TOOLS, disallowedTools: DISALLOWED_TOOLS },
  full: { permissionMode: "auto" },
};

const displayName = (t) => t.replace(/^mcp__fethr__/, "");
const disabledName = (t) => (t === "Task" || t === "Agent" ? `${t} (subagents)` : t);
// Where a resumed session came from, as the home page labels it ("CLI",
// "VS Code / Cursor", "SDK", or a raw entrypoint). It goes into the prompt,
// so only a short, plain label is accepted.
const SOURCE_RE = /^[A-Za-z0-9 ./()+_:-]{1,40}$/;

// Per-request context about fethr itself, sent like <git_branch>: a resumed
// session from Claude Code carries turns where Bash and Edit worked, and that
// history outweighed the system prompt. Seen: a resumed agent, told "Bash is
// disabled", spent turns reading settings files and then blamed the editor
// it was started in. Stating the tool set in every prompt keeps it current.
export function fethrContext(resumed, mode = "readonly") {
  const full = normalizeMode(mode) === "full";
  const ro = MODE_OPTIONS.readonly;
  const lines = full
    ? [
        "You are in fethr's agent panel in full mode: Claude Code's tools are available and run without asking; " +
          "an auto-mode classifier may block risky actions. The user sees your edits in their editor.",
      ]
    : [
        "You are in fethr's agent panel.",
        `Tools available: ${ro.allowedTools.map(displayName).join(", ")}.`,
        `Disabled in read-only mode (not by any settings file): ${ro.disallowedTools.map(disabledName).join(", ")}.`,
        "The user can switch this window to full mode (the read-only | full switch at the top of the agent panel) " +
          "to give you Claude Code's tools in this same conversation. When a task needs them, ask for that switch.",
        "Claude Code slash commands are not available here.",
      ];
  if (resumed && typeof resumed === "object") {
    const from = typeof resumed.source === "string" && SOURCE_RE.test(resumed.source) ? ` (${resumed.source})` : "";
    // In full mode the tools are all there, so the warning half would be false.
    lines.push(full
      ? `This conversation was started elsewhere${from} and resumed in fethr.`
      : `This conversation was started elsewhere${from} and resumed in fethr; earlier turns may assume tools you no longer have.`);
  }
  return `<fethr_context>\n${lines.join("\n")}\n</fethr_context>`;
}

// ---------------------------------------------------------------- editor sync

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Best effort: the SDK marks a refused tool call only as an is_error tool
// result whose text explains it, so a denial (auto-mode classifier,
// permission rules) is recognised by matching that text. A plain tool failure
// that happens to mention one of these words is reported as a denial too.
const DENIAL_RE = /permission|denied|blocked/i;
const MAX_DENIAL_DETAIL = 300;

function resultText(block) {
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((x) => x && typeof x.text === "string").map((x) => x.text).join("\n");
  return "";
}

// How the editor learns what the agent changed, in full mode. Events go out
// when a tool's result arrives, not when the call is made: at tool_use time
// the file is not written yet, and a refused or failed call wrote nothing.
//   file-changed: an edit tool succeeded; path is root-relative ("/"
//     separators, as /api/file takes it), or absolute with outside: true.
//   maybe-changed: a Bash command ran; what it touched is unknowable, so the
//     page should re-check open files. Once per run.
//   tool-denied: a call came back refused (both modes).
export function editorSync(root, mode, emitFn) {
  const full = normalizeMode(mode) === "full";
  const pending = new Map(); // tool_use id -> { name, file }
  let maybeSent = false;
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* keep the lexical root */ }

  const relative = (file) => {
    const abs = path.resolve(root, file);
    for (const base of [root, realRoot]) {
      if (abs === base || abs.startsWith(base + path.sep)) {
        return { path: path.relative(base, abs).split(path.sep).join("/") };
      }
    }
    return { path: abs, outside: true };
  };

  return {
    toolUse(b) {
      if (!b || typeof b.id !== "string") return;
      const i = b.input || {};
      const file = typeof i.file_path === "string" ? i.file_path : typeof i.notebook_path === "string" ? i.notebook_path : null;
      pending.set(b.id, { name: String(b.name || ""), file });
    },
    toolResult(b) {
      const call = pending.get(b.tool_use_id);
      if (!call) return;
      pending.delete(b.tool_use_id);
      if (b.is_error) {
        const text = resultText(b);
        if (DENIAL_RE.test(text)) {
          const detail = text.trim().slice(0, MAX_DENIAL_DETAIL);
          emitFn({ type: "tool-denied", name: call.name.replace(/^mcp__fethr__/, ""), detail });
          return; // refused: it never ran
        }
        if (call.name !== "Bash") return; // a failed edit changed nothing
      }
      if (!full) return;
      if (EDIT_TOOLS.has(call.name) && call.file) {
        emitFn({ type: "file-changed", ...relative(call.file) });
      } else if (call.name === "Bash" && !maybeSent) {
        // Even a failing command may have written something before it failed.
        maybeSent = true;
        emitFn({ type: "maybe-changed" });
      }
    },
  };
}

// The one place a run's final event is built. A run that produced no
// assistant text (a slash command the SDK turns away, an immediate error)
// would otherwise end as an empty reply in the panel, so it always carries a
// short detail: the result text, the SDK's errors, the stderr tail, or the
// subtype, whichever exists first.
export function doneEvent(msg, { sawText, stderrTail = [] }) {
  const ok = msg.subtype === "success";
  const stderr = stderrTail.filter((l) => !/^\s*at /.test(l)).slice(-3).join(" · ");
  const resultText = typeof msg.result === "string" ? msg.result.trim() : "";
  const errors = Array.isArray(msg.errors) ? msg.errors.filter((e) => typeof e === "string").join(" · ") : "";
  const short = (t) => (t.length > 300 ? t.slice(0, 299) + "…" : t);
  if (ok && sawText) return { type: "done", ok: true };
  if (ok) {
    return { type: "done", ok: true, empty: true, detail: short(resultText || stderr || "no reply") };
  }
  return {
    type: "done",
    ok: false,
    error: msg.subtype,
    ...(sawText ? {} : { empty: true }),
    detail: short(stderr || errors || resultText || String(msg.subtype || "error")),
  };
}

// queryFn: the SDK's query(), replaceable so the tests can see exactly what
// the SDK is given without starting Claude Code.
// Pasted or dropped images ride with the prompt as base64. The page downscales
// first, so these caps are for a misbehaving client, not normal use. 5 MB per
// image is the Messages API's own limit; past it the API rejects the turn.
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AGENT_BODY = 40 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Returns { images } (possibly empty) or { error } for a 400.
export function checkImages(images) {
  if (images === undefined || images === null) return { images: [] };
  if (!Array.isArray(images)) return { error: "images must be a list" };
  if (images.length > MAX_IMAGES) return { error: `at most ${MAX_IMAGES} images per message` };
  for (const im of images) {
    if (!im || typeof im !== "object" || !IMAGE_TYPES.has(im.mediaType)) {
      return { error: "images must be PNG, JPEG, GIF or WebP" };
    }
    if (typeof im.data !== "string" || !im.data || !BASE64_RE.test(im.data)) return { error: "image data must be base64" };
    if (Math.floor((im.data.length * 3) / 4) > MAX_IMAGE_BYTES) return { error: "an image is over 5 MB" };
  }
  return { images: images.map((im) => ({ mediaType: im.mediaType, data: im.data })) };
}

export function handleAgent(root, req, res, { queryFn = query } = {}) {
  let body = "";
  let tooBig = false;
  req.setEncoding("utf8");
  req.on("data", (c) => {
    if (tooBig) return;
    body += c;
    if (body.length > MAX_AGENT_BODY) { tooBig = true; body = ""; }
  });
  req.on("end", () => {
    if (tooBig) {
      res.writeHead(413, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "message too large (images over the limit)" }));
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "bad json" }));
    }
    const checked = checkImages(parsed && parsed.images);
    if (checked.error) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: checked.error }));
    }
    parsed.images = checked.images;
    runAgent(root, parsed, res, { queryFn }).catch((e) => {
      try {
        emit(res, { type: "error", message: String(e.message || e) });
        res.end();
      } catch { /* stream already gone */ }
    });
  });
}

// ---------- permission questions, answered in the panel ----------
// id -> settle(allow). An id is random and single-use; the page answers it
// with POST /api/agent/permission. Stop (the stream closing) denies every
// question still open on that stream.
const pendingAsks = new Map();
const MAX_ASK_DETAIL = 400;

function askDetail(name, input) {
  const i = input && typeof input === "object" ? input : {};
  const d = typeof i.command === "string" ? i.command
    : i.file_path || i.notebook_path || i.path || i.url || i.pattern || JSON.stringify(i);
  return String(d || "").slice(0, MAX_ASK_DETAIL);
}

export function askInPanel(res) {
  const open = new Set();
  res.on("close", () => { for (const id of open) settleAsk(id, false); });
  return (toolName, input, { signal } = {}) => new Promise((resolve) => {
    const id = crypto.randomUUID();
    const done = (allow) => {
      open.delete(id);
      pendingAsks.delete(id);
      resolve(allow
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "The user denied this in fethr's panel." });
    };
    pendingAsks.set(id, done);
    open.add(id);
    if (signal) signal.addEventListener("abort", () => settleAsk(id, false), { once: true });
    emit(res, { type: "permission", id, name: String(toolName).replace(/^mcp__fethr__/, ""), detail: askDetail(toolName, input) });
  });
}

// Answers one open question. Returns false for an unknown or settled id.
export function settleAsk(id, allow) {
  const done = pendingAsks.get(id);
  if (!done) return false;
  done(allow === true);
  return true;
}

function emit(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// Agent SDK model aliases pass straight through; "fable" isn't a standard
// alias so it's mapped to the full model ID. Availability isn't detected
// ahead of time — the panel shows it optimistically and folds gracefully
// on the first failure (see markFableUnavailable in web/editor.js).
const MODEL_MAP = { opus: "opus", sonnet: "sonnet", haiku: "haiku", fable: "claude-fable-5" };

// A plain string when there are no images (as before). With images, the SDK
// needs a structured user message: image blocks first, then the text, which
// is how the Messages API reads them best.
export function promptInput(text, images) {
  if (!images || !images.length) return text;
  const message = {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } })),
        { type: "text", text },
      ],
    },
  };
  return (async function* () { yield message; })();
}

export async function runAgent(root, { prompt, sessionId, fork, resumed, mode: askedMode, context, extraFiles, gitBranch, model, images }, res, { queryFn = query } = {}) {
  const mode = normalizeMode(askedMode);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });

  const fethrServer = createSdkMcpServer({
    name: "fethr",
    tools: [
      tool(
        "propose_edit",
        "Propose replacing one file's content. The writer reviews the diff and accepts or rejects; nothing is written to disk by this tool.",
        {
          path: z.string().describe("Workspace-relative path of the file"),
          new_content: z.string().describe("The complete proposed content of the file"),
          note: z.string().optional().describe("One line on what changed and why"),
        },
        async ({ path: rel, new_content, note }) => {
          const abs = path.resolve(root, rel);
          if (abs !== root && !abs.startsWith(root + path.sep)) {
            return { content: [{ type: "text", text: "Rejected: path escapes the workspace." }] };
          }
          emit(res, { type: "proposal", path: rel, content: new_content, note: note || "" });
          return {
            content: [{ type: "text", text: `Proposal for ${rel} shown to the writer for review.` }],
          };
        }
      ),
    ],
  });

  let fullPrompt = prompt;
  fullPrompt += `\n\n${fethrContext(resumed, mode)}`;
  if (gitBranch) fullPrompt += `\n\n<git_branch>${gitBranch}</git_branch>`;
  if (context && context.path) {
    fullPrompt += `\n\n<current_file path="${context.path}">\n${context.content ?? ""}\n</current_file>`;
    if (context.selection) fullPrompt += `\n<selection>\n${context.selection}\n</selection>`;
  }
  for (const f of extraFiles || []) {
    fullPrompt += `\n\n<attached_file path="${f.path}">\n${f.content ?? ""}\n</attached_file>`;
  }

  // The child's stderr is the only place the real reason for a failure
  // appears (a 400 from the API, a too-old claude, a missing login) — the
  // result message itself only says "error_during_execution". Keep the tail
  // and hand it to the panel when the run does not succeed.
  const stderrTail = [];
  const q = queryFn({
    prompt: promptInput(fullPrompt, images),
    options: {
      cwd: root,
      stderr: (chunk) => {
        for (const line of String(chunk).split("\n")) {
          if (line.trim()) stderrTail.push(line.trim());
        }
        if (stderrTail.length > 20) stderrTail.splice(0, stderrTail.length - 20);
      },
      systemPrompt: { type: "preset", preset: "claude_code", append: rulesFor(mode) },
      mcpServers: { fethr: fethrServer },
      ...MODE_OPTIONS[mode],
      includePartialMessages: true,
      ...(sessionId ? { resume: sessionId } : {}),
      // Fork: continue from that transcript under a new session id, leaving
      // the original file untouched (home screen "Fork", docs/plans/home-screen.md).
      // Meaningless without a session to fork from, so it needs both.
      ...(fork && sessionId ? { forkSession: true } : {}),
      ...(model && MODEL_MAP[model] ? { model: MODEL_MAP[model] } : {}),
      ...(findClaudeExecutable() ? { pathToClaudeCodeExecutable: findClaudeExecutable() } : {}),
      // Full mode: when Claude Code asks permission (auto mode's classifier
      // couldn't decide, or the model doesn't support auto mode), the question
      // goes to the panel as an Approve / Deny card and the run waits for the
      // user. Before this there was no one to ask and the call failed as
      // "requires approval". The classifier's outright blocks never get here.
      ...(mode === "full" ? { canUseTool: askInPanel(res) } : {}),
    },
  });

  // Stop the agent when the browser goes away (the panel's stop button aborts
  // the fetch). This must hang off the *response*: since Node 16 a request
  // emits "close" as soon as its body has been read, so listening there
  // interrupted every run the moment it started. With the August Claude Code
  // that interrupt was a no-op; 2.1.26x honours it, and every reply became
  // "error_during_execution ... result_type=user".
  res.on("close", () => {
    if (!res.writableFinished && typeof q.interrupt === "function") q.interrupt().catch(() => {});
  });

  let sawText = false;
  const sync = editorSync(root, mode, (ev) => emit(res, ev));
  for await (const msg of q) {
    if (msg.type === "system" && msg.subtype === "init") {
      emit(res, { type: "session", id: msg.session_id });
    } else if (msg.type === "stream_event") {
      const ev = msg.event || {};
      const d = ev.delta;
      if (d && d.type === "text_delta") {
        if (d.text) sawText = true;
        emit(res, { type: "delta", text: d.text });
      }
      else if (d && d.type === "thinking_delta" && d.thinking) {
        emit(res, { type: "thinking", text: d.thinking });
      } else if (ev.type === "content_block_start" && ev.content_block) {
        if (ev.content_block.type === "thinking") emit(res, { type: "phase", phase: "thinking" });
        else if (ev.content_block.type === "text") emit(res, { type: "phase", phase: "writing" });
      }
    } else if (msg.type === "assistant") {
      const blocks = (msg.message && msg.message.content) || msg.content || [];
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) sawText = true;
        if (b.type === "tool_use") {
          const i = b.input || {};
          const detail =
            i.file_path || i.path || i.pattern || i.query ||
            (typeof i.command === "string" ? i.command.slice(0, 60) : "") || "";
          emit(res, { type: "tool", name: b.name.replace(/^mcp__fethr__/, ""), detail });
          sync.toolUse(b);
        }
      }
    } else if (msg.type === "user") {
      // Tool results come back as user messages.
      const blocks = (msg.message && Array.isArray(msg.message.content)) ? msg.message.content : [];
      for (const b of blocks) if (b && b.type === "tool_result") sync.toolResult(b);
    } else if (msg.type === "result") {
      emit(res, doneEvent(msg, { sawText, stderrTail }));
    }
  }
  res.end();
}
