// A synthetic CLAUDE_CONFIG_DIR for the session tests. The record shapes copy
// what Claude Code writes (custom-title, ai-title, last-prompt, user/assistant
// records with cwd, entrypoint, isMeta, isSidechain, message.content), with
// made-up content. Shared by sessions.test.js and server.test.js.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const IDS = {
  titled: "11111111-1111-4111-8111-111111111111",
  goneCwd: "22222222-2222-4222-8222-222222222222",
  empty: "33333333-3333-4333-8333-333333333333",
  badLine: "44444444-4444-4444-8444-444444444444",
  metaOnly: "55555555-5555-4555-8555-555555555555",
  big: "66666666-6666-4666-8666-666666666666",
  nested: "77777777-7777-4777-8777-777777777777",
  long: "88888888-8888-4888-8888-888888888888",
  compacted: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
  // Moved sessions: movedA was continued as movedB, then as successor.
  movedA: "a1a1a1a1-0000-4000-8000-000000000001",
  movedB: "b2b2b2b2-0000-4000-8000-000000000002",
  successor: "c3c3c3c3-0000-4000-8000-000000000003",
  cycleA: "d4d4d4d4-0000-4000-8000-000000000004", // cycleA -> cycleB -> cycleA
  cycleB: "e5e5e5e5-0000-4000-8000-000000000005",
  dangling: "f6f6f6f6-0000-4000-8000-000000000006", // continued in a session not on this machine
};
export const MISSING_ID = "0f0f0f0f-0000-4000-8000-00000000000f";

// Subagent ids, as Claude Code names them (17 lowercase alphanumerics).
export const AGENTS = {
  done: "a0000000000000001", // finished: a completion notice newer than its last write
  wf: "b0000000000000002", // inside workflows/wf_abc/, written 10 s ago: active
  quiet: "c0000000000000003", // no meta; its only notice predates its last write (resumed)
  failed: "d0000000000000004", // a failed notice
  gone: "e0000000000000005", // belongs to IDS.goneCwd, written 30 s ago
  fg: "f0000000000000006", // foreground; its tool call has a result in the parent: finished
  bg: "g0000000000000007", // background; its launch ack is a tool_result, which proves nothing
};
export const TITLED_STARTED = "2026-10-01T10:00:00.000Z";

// What Claude Code writes when it compacts a long session: a "user" record
// nobody typed. It must never become a prompt, a title or a user turn.
const COMPACT_SUMMARY = "This session is being continued from a previous conversation that ran out of context.";

const jsonl = (records) => records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
const user = (cwd, content, extra = {}) => ({ type: "user", cwd, entrypoint: "cli", message: { role: "user", content }, ...extra });
const assistant = (cwd, id, block) => ({ type: "assistant", cwd, entrypoint: "cli", message: { id, role: "assistant", content: [block] } });

const notice = (agentId, status, at) => ({
  type: "user",
  timestamp: new Date(at).toISOString(),
  origin: { kind: "task-notification" },
  message: { role: "user", content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>` },
});

export function claudeFixture() {
  const nowMs = Date.now();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fethr-claude-"));
  // A real folder for the sessions that should resolve. It sits under
  // os.tmpdir(), so these sessions also carry temp:true.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "fethr-work-"));
  const gone = path.join(work, "deleted-since");
  const projects = path.join(base, "projects");
  const proj = path.join(projects, "-Users-someone-work");
  const other = path.join(projects, "-Users-someone-other");
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const write = (dir, id, records) => {
    const f = path.join(dir, id + ".jsonl");
    fs.writeFileSync(f, records === "" ? "" : jsonl(records));
    return f;
  };
  const files = {};

  files.titled = write(proj, IDS.titled, [
    { type: "permission-mode", permissionMode: "default", sessionId: IDS.titled },
    user(work, "<command-name>/clear</command-name>", { timestamp: TITLED_STARTED }),
    user(work, "Caveat: injected context", { isMeta: true }),
    user(work, [{ type: "text", text: "fix the parser please" }]),
    assistant(work, "msg_1", { type: "thinking", thinking: "hmm" }),
    assistant(work, "msg_1", { type: "text", text: "Looking at it." }),
    assistant(work, "msg_1", { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/w/src/parser.js" } }),
    user(work, [{ type: "tool_result", tool_use_id: "tu1", content: "file text" }]),
    assistant(work, "msg_2", { type: "text", text: "First half," }),
    assistant(work, "msg_2", { type: "text", text: "second half." }),
    user(work, "sub-task prompt", { isSidechain: true }),
    { type: "ai-title", aiTitle: "Parser fix", sessionId: IDS.titled },
    { type: "custom-title", customTitle: "My parser session", sessionId: IDS.titled },
    { type: "last-prompt", lastPrompt: "fix the parser please", sessionId: IDS.titled },
    notice(AGENTS.quiet, "completed", nowMs - 1_200_000),
    notice(AGENTS.done, "failed", nowMs - 1_000_000), // superseded by the later notice below
    notice(AGENTS.done, "completed", nowMs - 590_000),
    notice(AGENTS.failed, "failed", nowMs - 200_000),
    user(work, [{ type: "tool_result", tool_use_id: "toolu_fg", content: "agent report" }]),
    user(work, [{ type: "tool_result", tool_use_id: "toolu_bg", content: "launched in the background" }]),
  ]);

  files.goneCwd = write(proj, IDS.goneCwd, [
    { ...user(gone, "side question"), isSidechain: true, entrypoint: "claude-vscode" },
    { ...user(gone, "where did that folder go"), entrypoint: "claude-vscode" },
    { type: "ai-title", aiTitle: "Missing folder", sessionId: IDS.goneCwd },
  ]);

  files.empty = write(proj, IDS.empty, "");

  files.badLine = write(other, IDS.badLine, [
    "{this is not json",
    { ...user(work, "survives a torn line"), entrypoint: "sdk-ts" },
  ]);

  files.metaOnly = write(other, IDS.metaOnly, [
    { type: "permission-mode", permissionMode: "default", sessionId: IDS.metaOnly },
    user(work, "only meta", { isMeta: true }),
  ]);

  // Larger than both read windows together: the prompt is only in the head
  // and the title only in the tail.
  const filler = [];
  for (let i = 0; filler.length * 1100 < 700 * 1024; i++) {
    filler.push(assistant(work, "msg_f" + i, { type: "text", text: "x".repeat(1000) }));
  }
  files.big = write(other, IDS.big, [
    { ...user(work, "the very first prompt"), entrypoint: "claude-desktop" },
    ...filler,
    { type: "ai-title", aiTitle: "Tail title", sessionId: IDS.big },
  ]);

  // More than the history cap: 250 prompt/answer pairs.
  const turns = [];
  for (let i = 0; i < 250; i++) {
    turns.push(user(work, "q" + i), assistant(work, "m" + i, { type: "text", text: "a" + i }));
  }
  files.long = write(other, IDS.long, turns);

  files.compacted = write(other, IDS.compacted, [
    user(work, COMPACT_SUMMARY, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    assistant(work, "mc1", { type: "text", text: "Picking up where we left off." }),
    user(work, "after compaction prompt"),
    user(work, "only shown in the transcript", { isVisibleInTranscriptOnly: true }),
  ]);

  const continued = (id, next, prompt) => write(other, id, [
    user(work, prompt),
    { type: "continued-in", sessionId: id, continuedInSessionId: next, timestamp: "2026-10-02T00:00:00.000Z" },
  ]);
  files.movedA = continued(IDS.movedA, IDS.movedB, "first home of the chat");
  files.movedB = continued(IDS.movedB, IDS.successor, "second home of the chat");
  files.successor = write(other, IDS.successor, [user(work, "where the chat lives now")]);
  files.cycleA = continued(IDS.cycleA, IDS.cycleB, "loop a");
  files.cycleB = continued(IDS.cycleB, IDS.cycleA, "loop b");
  files.dangling = continued(IDS.dangling, MISSING_ID, "moved off this machine");

  // Subagent transcripts live under <session-id>/subagents/ and must not be
  // listed, even when named like a session.
  const sub = path.join(proj, IDS.titled, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  write(sub, IDS.nested, [user(work, "subagent prompt")]);
  fs.writeFileSync(path.join(proj, "notes.jsonl"), jsonl([user(work, "not a session file")]));

  // Subagents: transcripts are all sidechain records; a .meta.json sits
  // beside each (except one, to show it is optional); a workflow keeps a
  // journal.jsonl that is not an agent.
  const agentFile = (dir, agentId, meta, ageS) => {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `agent-${agentId}.jsonl`);
    fs.writeFileSync(f, jsonl([
      { ...user(work, "build the home view"), isSidechain: true, timestamp: "2026-10-01T10:05:00.000Z" },
      { ...assistant(work, "s1", { type: "tool_use", id: "t", name: "Read", input: { file_path: "/w/web/home.js" } }), isSidechain: true },
      { ...assistant(work, "s1", { type: "text", text: "Done." }), isSidechain: true },
    ]));
    if (meta) fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
    fs.utimesSync(f, (nowMs / 1000) - ageS, (nowMs / 1000) - ageS);
    return f;
  };
  agentFile(sub, AGENTS.done, { agentType: "general-purpose", description: "Web: home view", spawnDepth: 1 }, 600);
  const wf = path.join(sub, "workflows", "wf_abc");
  agentFile(wf, AGENTS.wf, { agentType: "Explore" }, 10);
  fs.writeFileSync(path.join(wf, "journal.jsonl"), jsonl([{ type: "step" }]));
  agentFile(sub, AGENTS.quiet, null, 600);
  agentFile(sub, AGENTS.failed, { agentType: "general-purpose", description: "Server half" }, 300);
  agentFile(path.join(proj, IDS.goneCwd, "subagents"), AGENTS.gone, { agentType: "Plan" }, 30);
  agentFile(sub, AGENTS.fg, { agentType: "Explore", toolUseId: "toolu_fg", requestShape: "sync" }, 900);
  agentFile(sub, AGENTS.bg, { agentType: "general-purpose", toolUseId: "toolu_bg", requestShape: "background" }, 900);

  // Ordering: titled newest, the rest older.
  const now = nowMs / 1000;
  const ages = {
    titled: 0, goneCwd: 600, badLine: 1200, big: 1800, long: 2400, compacted: 2700, metaOnly: 3000,
    successor: 3200, movedB: 3300, movedA: 3400, cycleA: 3500, cycleB: 3600, dangling: 3700,
  };
  for (const [k, age] of Object.entries(ages)) fs.utimesSync(files[k], now - age, now - age);

  return { base, projects, work, gone, files };
}
