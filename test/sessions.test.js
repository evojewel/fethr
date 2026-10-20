// The Claude session list, session history and recent folders, against a
// synthetic CLAUDE_CONFIG_DIR (test/claude-fixture.js). No real transcripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeFixture, IDS, AGENTS, TITLED_STARTED, MISSING_ID } from "./claude-fixture.js";
import {
  listSessions, findSessionFile, getSession, sessionHistory, recentFolders, upsertRecent, projectsDir,
  openSessions, setOpenSessionsRunner, listSubagents, latestContinuation,
} from "../src/sessions.js";

const fx = claudeFixture();
process.env.CLAUDE_CONFIG_DIR = fx.base;
process.env.FETHR_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fethr-state-"));

test("projects dir follows CLAUDE_CONFIG_DIR", () => {
  assert.equal(projectsDir(), fx.projects);
});

test("lists top-level transcripts newest first, skipping empty, meta-only, nested and foreign files", () => {
  const ids = listSessions().map((s) => s.id);
  assert.deepEqual(ids, [
    IDS.titled, IDS.goneCwd, IDS.badLine, IDS.big, IDS.long, IDS.compacted,
    IDS.successor, IDS.movedB, IDS.movedA, IDS.cycleA, IDS.cycleB, IDS.dangling,
  ]);
});

test("a session's fields: title precedence, first real prompt, source, flags", () => {
  const byId = Object.fromEntries(listSessions().map((s) => [s.id, s]));
  const t = byId[IDS.titled];
  assert.equal(t.title, "My parser session", "custom-title beats ai-title");
  assert.equal(t.firstPrompt, "fix the parser please", "skips <command> echoes and isMeta");
  assert.equal(t.cwd, fx.work);
  assert.equal(t.project, path.basename(fx.work));
  assert.equal(t.source, "CLI");
  assert.equal(t.cwdExists, true);
  assert.equal(t.temp, true, "the fixture folder is under os.tmpdir()");
  assert.equal(t.live, true, "written just now");
  assert.equal(typeof t.mtime, "number");
  assert.equal(t.size, fs.statSync(fx.files.titled).size);

  const g = byId[IDS.goneCwd];
  assert.equal(g.title, "Missing folder");
  assert.equal(g.firstPrompt, "where did that folder go", "a sidechain prompt is not the first prompt");
  assert.equal(g.source, "VS Code / Cursor");
  assert.equal(g.cwdExists, false);
  assert.equal(g.live, false);

  assert.equal(byId[IDS.badLine].title, "survives a torn line", "falls back to the first prompt");
  assert.equal(byId[IDS.badLine].source, "SDK");
  assert.equal(byId[IDS.big].source, "claude-desktop", "unknown entrypoints pass through raw");
});

test("large transcripts are read by head and tail windows", () => {
  assert.ok(fs.statSync(fx.files.big).size > 600 * 1024);
  const s = getSession(IDS.big);
  assert.equal(s.firstPrompt, "the very first prompt");
  assert.equal(s.title, "Tail title");
});

test("the cache notices a changed file", () => {
  assert.equal(getSession(IDS.badLine).title, "survives a torn line");
  fs.appendFileSync(fx.files.badLine, JSON.stringify({ type: "custom-title", customTitle: "Renamed" }) + "\n");
  assert.equal(getSession(IDS.badLine).title, "Renamed");
});

test("ids are validated before any lookup; no client path is ever joined", () => {
  for (const bad of ["../x", "../../etc/passwd", IDS.titled + "/../x", "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF", "", null, 42]) {
    assert.equal(findSessionFile(bad), null, String(bad));
    assert.equal(sessionHistory(bad), null, String(bad));
  }
  assert.equal(findSessionFile(IDS.nested), null, "a subagent transcript is not a session");
  assert.equal(findSessionFile("99999999-9999-4999-8999-999999999999"), null);
  assert.equal(findSessionFile(IDS.titled).file, fx.files.titled);
});

test("history: prompts, merged assistant text, tool calls; no thinking, meta or sidechain", () => {
  const h = sessionHistory(IDS.titled);
  assert.equal(h.id, IDS.titled);
  assert.equal(h.cwd, fx.work);
  assert.equal(h.title, "My parser session");
  assert.equal(h.omitted, 0);
  assert.deepEqual(h.entries, [
    { type: "user", text: "fix the parser please" },
    { type: "assistant", text: "Looking at it." },
    { type: "tool", text: "Read /w/src/parser.js" },
    { type: "assistant", text: "First half,\n\nsecond half." },
  ]);
});

test("history keeps the last 200 entries and counts the rest", () => {
  const h = sessionHistory(IDS.long);
  assert.equal(h.entries.length, 200);
  assert.equal(h.omitted, 300);
  assert.deepEqual(h.entries.at(-1), { type: "assistant", text: "a249" });
  assert.deepEqual(h.entries[0], { type: "user", text: "q150" });
});

test("a compaction summary is never a prompt, a title or a user turn", () => {
  const s = getSession(IDS.compacted);
  assert.equal(s.firstPrompt, "after compaction prompt");
  assert.equal(s.title, "after compaction prompt");
  const h = sessionHistory(IDS.compacted);
  assert.deepEqual(h.entries, [
    { type: "tool", text: "context compacted" },
    { type: "assistant", text: "Picking up where we left off." },
    { type: "user", text: "after compaction prompt" },
  ]);
});

test("history of a transcript bigger than its read window shows the recent turns", () => {
  // 20 MB of zeros (sparse: costs no disk), then real records. Only the last
  // 8 MB is read, so the opening is never seen: truncated, not refused.
  const id = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  const f = path.join(fx.projects, "-Users-someone-work", id + ".jsonl");
  fs.writeFileSync(f, "");
  fs.truncateSync(f, 20 * 1024 * 1024);
  const recs = [];
  for (let i = 0; i < 120; i++) {
    recs.push({ type: "user", cwd: fx.work, message: { content: "late q" + i } });
    recs.push({ type: "assistant", cwd: fx.work, message: { id: "m" + i, content: [{ type: "text", text: "late a" + i }] } });
  }
  recs.push({ type: "ai-title", aiTitle: "Huge session" });
  fs.appendFileSync(f, "\n" + recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  try {
    const h = sessionHistory(id);
    assert.equal(h.truncated, true);
    assert.equal(h.omitted, 40, "240 entries read, the last 200 kept");
    assert.deepEqual(h.entries.at(-1), { type: "assistant", text: "late a119" });
    assert.equal(h.title, "Huge session");
    assert.equal(h.cwd, fx.work);
    assert.equal(sessionHistory(IDS.titled).truncated, false, "a small file is read whole");
  } finally {
    fs.rmSync(f);
  }
});

test("open sessions: parsed from the runner, cached, and unknown on any failure", async () => {
  let calls = 0;
  setOpenSessionsRunner(async () => {
    calls++;
    return [
      { sessionId: IDS.titled, kind: "background", status: "idle", pid: 1, cwd: "/x", name: "n" },
      { sessionId: "../x", kind: "interactive", status: "busy" },
      null,
    ];
  });
  const open = await openSessions();
  assert.deepEqual([...open.keys()], [IDS.titled], "invalid ids dropped");
  await openSessions();
  assert.equal(calls, 1, "cached");
  await openSessions({ fresh: true });
  assert.equal(calls, 2, "fresh skips the cache");
  const byId = Object.fromEntries(listSessions({ open }).map((s) => [s.id, s]));
  assert.deepEqual(byId[IDS.titled].open, { kind: "background", status: "idle" });
  assert.equal(byId[IDS.goneCwd].open, null);
  assert.equal(listSessions()[0].open, null, "no list given: unknown");

  for (const bad of [async () => { throw new Error("ENOENT"); }, async () => ({ not: "an array" }), () => { throw new Error("sync"); }, async () => null]) {
    setOpenSessionsRunner(bad);
    assert.equal(await openSessions(), null);
  }
  setOpenSessionsRunner(null);
});

test("recent folders: upsert moves to the top, dedupes, caps at 30, reports existence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fethr-recent-"));
  for (let i = 0; i < 35; i++) upsertRecent(`/nowhere/f${i}`, { now: 1000 + i });
  upsertRecent(dir, { now: 5000 });
  upsertRecent("/nowhere/f34", { now: 6000 });
  const list = recentFolders();
  assert.equal(list.length, 30);
  assert.deepEqual(list.slice(0, 2).map((e) => e.path), ["/nowhere/f34", dir]);
  assert.equal(list.filter((e) => e.path === "/nowhere/f34").length, 1);
  assert.deepEqual(list[1], { path: dir, name: path.basename(dir), lastOpened: 5000, exists: true, session: null });
  assert.equal(list[0].exists, false);
  assert.ok(!list.some((e) => e.path === "/nowhere/f0"), "oldest dropped past the cap");
});

test("a corrupt recent.json starts over instead of failing", () => {
  fs.writeFileSync(path.join(process.env.FETHR_STATE_DIR, "recent.json"), "{nope");
  assert.deepEqual(recentFolders(), []);
  upsertRecent("/nowhere/again", { now: 1 });
  assert.equal(recentFolders()[0].path, "/nowhere/again");
});

const openMap = (entries) => new Map(entries.map(([id, kind, status, startedAt = null]) => [id, { kind, status, startedAt }]));

test("session state, start time, last activity and subagent counts", () => {
  const now = Date.now();
  let byId = Object.fromEntries(listSessions({ now }).map((s) => [s.id, s]));
  const t = byId[IDS.titled];
  assert.equal(t.startedAt, Date.parse(TITLED_STARTED), "first record timestamp when not open");
  assert.deepEqual(t.subagents, { total: 6, active: 1 }, "journal.jsonl, meta files and a uuid-named file are not agents");
  assert.equal(t.lastActivity, t.mtime, "its own file is the newest write");
  assert.equal(t.state, "recent", "written just now, not in the open list");

  const g = byId[IDS.goneCwd];
  assert.deepEqual(g.subagents, { total: 1, active: 1 });
  assert.ok(g.lastActivity > g.mtime, "a subagent wrote after the session file did");
  assert.equal(g.state, "recent", "recent through its subagent");
  assert.equal(g.live, false, "live still looks at the session file alone");
  assert.equal(byId[IDS.long].state, "closed");
  assert.deepEqual(byId[IDS.long].subagents, { total: 0, active: 0 });

  byId = Object.fromEntries(listSessions({
    now,
    open: openMap([[IDS.titled, "interactive", "busy", 1234], [IDS.goneCwd, "background", "busy"], [IDS.long, "interactive", "idle"]]),
  }).map((s) => [s.id, s]));
  assert.equal(byId[IDS.titled].state, "busy");
  assert.equal(byId[IDS.titled].startedAt, 1234, "the open list's startedAt wins");
  assert.deepEqual(byId[IDS.titled].open, { kind: "interactive", status: "busy" });
  assert.equal(byId[IDS.goneCwd].state, "background");
  assert.equal(byId[IDS.long].state, "open");
});

test("subagents: newest first, with workflow, meta and a state from notices and mtime", () => {
  const list = listSubagents(IDS.titled);
  const order = list.map((a) => a.agentId);
  assert.deepEqual(order.slice(0, 2), [AGENTS.wf, AGENTS.failed], "10 s, then 300 s ago");
  assert.deepEqual(order.slice(2, 4).sort(), [AGENTS.done, AGENTS.quiet].sort(), "both 600 s ago");
  assert.deepEqual(order.slice(4).sort(), [AGENTS.bg, AGENTS.fg].sort(), "both 900 s ago");
  const by = Object.fromEntries(list.map((a) => [a.agentId, a]));
  assert.equal(by[AGENTS.wf].workflow, "wf_abc");
  assert.equal(by[AGENTS.wf].agentType, "Explore");
  assert.equal(by[AGENTS.wf].state, "active", "written 10 s ago, no notice");
  assert.equal(by[AGENTS.done].workflow, null);
  assert.equal(by[AGENTS.done].description, "Web: home view");
  assert.equal(by[AGENTS.done].state, "finished", "the latest notice, completed, is newer than its last write");
  assert.equal(by[AGENTS.done].startedAt, Date.parse("2026-10-01T10:05:00.000Z"));
  assert.equal(typeof by[AGENTS.done].size, "number");
  assert.equal(by[AGENTS.failed].state, "failed");
  assert.equal(by[AGENTS.quiet].description, null, "no meta file");
  assert.equal(by[AGENTS.quiet].state, "unknown", "resumed after its notice, quiet since, open list unknown");
  assert.equal(by[AGENTS.fg].state, "finished", "foreground: its tool call has a result");
  assert.equal(by[AGENTS.bg].state, "unknown", "background: the launch ack proves nothing");

  const stateWith = (open, agentId, now) => listSubagents(IDS.titled, { open, now }).find((a) => a.agentId === agentId).state;
  const parentOpen = openMap([[IDS.titled, "interactive", "idle"]]);
  const parentGone = openMap([[IDS.goneCwd, "interactive", "idle"]]); // known list, parent not in it
  assert.equal(stateWith(parentOpen, AGENTS.quiet), "idle", "parent open: idle");
  assert.equal(stateWith(parentOpen, AGENTS.bg), "idle");
  assert.equal(stateWith(parentGone, AGENTS.quiet), "ended", "parent not running: the agent cannot be");
  assert.equal(stateWith(new Map(), AGENTS.bg), "ended", "an empty known list counts as known");
  assert.equal(stateWith(parentGone, AGENTS.failed), "failed", "a notice beats ended");
  assert.equal(stateWith(parentGone, AGENTS.fg), "finished", "a foreground result beats ended");
  assert.equal(stateWith(parentGone, AGENTS.wf), "active", "written 10 s ago beats ended");
  // An injected clock: ten minutes on, the workflow agent is no longer active.
  assert.equal(stateWith(null, AGENTS.wf, Date.now() + 600_000), "unknown");
  assert.equal(stateWith(parentGone, AGENTS.wf, Date.now() + 600_000), "ended");
  assert.deepEqual(listSubagents(IDS.long), []);
  assert.equal(listSubagents("../x"), null);
});

test("a subagent's history: its own sidechain transcript, found only inside its session", () => {
  const h = sessionHistory(IDS.titled, { agentId: AGENTS.done });
  assert.equal(h.agentId, AGENTS.done);
  assert.equal(h.title, "Web: home view");
  assert.equal(h.truncated, false);
  assert.deepEqual(h.entries, [
    { type: "user", text: "build the home view" },
    { type: "tool", text: "Read /w/web/home.js" },
    { type: "assistant", text: "Done." },
  ]);
  assert.equal(sessionHistory(IDS.titled, { agentId: AGENTS.wf }).agentId, AGENTS.wf, "workflow agents too");
  assert.equal(sessionHistory(IDS.titled, { agentId: AGENTS.quiet }).title, `agent ${AGENTS.quiet}`);
  for (const bad of ["../x", "a/b", "A000", "x".repeat(65), AGENTS.gone, "nope"]) {
    assert.equal(sessionHistory(IDS.titled, { agentId: bad }), null, bad);
  }
});

test("moved sessions: linked both ways, and followed to where they live now", () => {
  const byId = Object.fromEntries(listSessions().map((s) => [s.id, s]));
  assert.equal(byId[IDS.movedA].continuedIn, IDS.movedB);
  assert.equal(byId[IDS.movedA].superseded, true);
  assert.deepEqual(byId[IDS.movedB].continuedFrom, [IDS.movedA]);
  assert.equal(byId[IDS.movedB].superseded, true);
  assert.deepEqual(byId[IDS.successor].continuedFrom, [IDS.movedB]);
  assert.equal(byId[IDS.successor].superseded, false);
  assert.equal(byId[IDS.successor].continuedIn, null);
  assert.equal(byId[IDS.dangling].continuedIn, MISSING_ID);
  assert.equal(byId[IDS.dangling].superseded, false, "its successor is not listed");
  assert.equal(byId[IDS.titled].continuedIn, null);

  assert.equal(latestContinuation(IDS.movedA), IDS.successor, "two hops");
  assert.equal(latestContinuation(IDS.successor), IDS.successor);
  assert.equal(latestContinuation(IDS.dangling), IDS.dangling, "a successor not on this machine is not followed");
  assert.equal(latestContinuation(IDS.cycleA), IDS.cycleB, "a loop stops instead of spinning");
});

test("recent entries can carry a session: deduped on folder + session, resolved per request", () => {
  fs.rmSync(path.join(process.env.FETHR_STATE_DIR, "recent.json"), { force: true });
  // An entry written before sessions existed stays valid.
  fs.writeFileSync(path.join(process.env.FETHR_STATE_DIR, "recent.json"), JSON.stringify([{ path: fx.work, lastOpened: 10 }]));
  upsertRecent(fx.work, { session: IDS.titled, now: 20 });
  upsertRecent(fx.work, { session: IDS.titled, now: 30 });
  upsertRecent(fx.work, { session: MISSING_ID, now: 25 });
  let list = recentFolders();
  assert.deepEqual(list.map((e) => [e.lastOpened, e.session && e.session.id]), [[30, IDS.titled], [25, null], [10, null]],
    "one entry per folder + session; a session that is gone keeps its row with session: null");
  const s = list[0].session;
  assert.equal(s.title, "My parser session");
  assert.equal(s.state, "recent");
  assert.equal(s.open, null);
  assert.deepEqual(recentFolders({ open: new Map([[IDS.titled, { kind: "interactive", status: "busy" }]]) })[0].session.open,
    { kind: "interactive", status: "busy" });

  upsertRecent(fx.work, { session: IDS.successor, dropPlain: true, now: 40 });
  list = recentFolders();
  assert.equal(list.length, 3, "the sessionless entry for that folder is gone");
  assert.ok(list.every((e) => e.session !== null || e.lastOpened === 25));
  assert.equal(list[0].session.id, IDS.successor);
});
