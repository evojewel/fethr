// Real-browser test for the home view and for an editor launched on a past
// session (docs/plans/home-screen.md). Same harness as agent-panel.cjs: a
// Chromium driven by puppeteer-core, not run in CI.
//
// Usage: node test-ui/home.cjs [chrome-executable-path]  (or FETHR_CHROME=...)
//
// Nothing is spawned: the server gets an onOpen stub that records what the
// page asked to open, and /api/agent is answered in the page, not by Claude.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

function findChrome() {
  if (process.env.FETHR_CHROME) return process.env.FETHR_CHROME;
  if (process.argv[2]) return process.argv[2];
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(mac)) return mac;
  throw new Error("No Chrome found — pass a path: node test-ui/home.cjs <chrome-path>");
}

const XSS = `<img src=x onerror="window.__pwned=1">`;
const ID = {
  plain: "11111111-1111-4111-8111-111111111111",
  live: "22222222-2222-4222-8222-222222222222",
  gone: "33333333-3333-4333-8333-333333333333",
  temp: "44444444-4444-4444-8444-444444444444",
  dbl: "55555555-5555-4555-8555-555555555555",
  bg: "abcdef12-6666-4666-8666-666666666666",
  term: "77777777-7777-4777-8777-777777777777",
};
const FORKED = "99999999-9999-4999-8999-999999999999";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Write a transcript in Claude Code's JSONL shape, with a chosen mtime.
function transcript(dir, id, { cwd, entrypoint, title, prompt, ageMs, extra = [] }) {
  const startedAt = new Date(Date.now() - ageMs - 3600_000).toISOString(); // an hour before the last write
  const recs = [
    { type: "user", cwd, entrypoint, sessionId: id, timestamp: startedAt, message: { role: "user", content: prompt } },
    ...extra,
    ...(title ? [{ type: "ai-title", aiTitle: title }] : []),
  ];
  const file = path.join(dir, id + ".jsonl");
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, t, t);
}

async function main() {
  const puppeteer = require("puppeteer-core");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fethr-home-test-"));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
  process.env.FETHR_STATE_DIR = path.join(tmp, "state");
  // A project folder outside the temp roots, so its sessions are not "temp".
  // The repo itself is the one such folder this test can rely on. It is only
  // ever read: editor servers below get a temp root, so nothing (chat.json
  // above all) is written into the repo.
  const project = path.resolve(__dirname, "..");
  const editorRoot = path.join(tmp, "editor-root");
  fs.mkdirSync(editorRoot);
  const projDir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "-fixture");
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(process.env.FETHR_STATE_DIR, { recursive: true });
  const HOUR = 3600_000;
  transcript(projDir, ID.plain, {
    cwd: project, entrypoint: "cli", title: "Refactor the parser " + XSS, prompt: "please refactor the parser", ageMs: 3 * HOUR,
    extra: [
      { type: "assistant", message: { id: "m1", content: [
        { type: "text", text: "Reading it now. <script>window.__pwned=2</script> **bold**" },
        { type: "tool_use", name: "Read", input: { file_path: "src/parser.js" } },
      ] } },
    ],
  });
  transcript(projDir, ID.live, { cwd: project, entrypoint: "claude-vscode", title: "Live one", prompt: "still going", ageMs: 10_000 });
  transcript(projDir, ID.gone, { cwd: "/nonexistent/fethr-gone", entrypoint: "cli", title: "Gone folder", prompt: "x", ageMs: 5 * HOUR });
  transcript(projDir, ID.dbl, { cwd: project, entrypoint: "cli", title: "Double click target", prompt: "z", ageMs: 7 * HOUR });
  transcript(projDir, ID.temp, { cwd: path.join(tmp, "scratch"), entrypoint: "cli", title: "Temp thing", prompt: "y", ageMs: 6 * HOUR });
  fs.writeFileSync(path.join(process.env.FETHR_STATE_DIR, "recent.json"), JSON.stringify([
    { path: project, lastOpened: Date.now() - 2 * HOUR },
    { path: "/nonexistent/fethr-old", lastOpened: Date.now() - 48 * HOUR },
  ]));

  // Subagents of ID.dbl: one written just now (active), one in a workflow, older.
  const subDir = path.join(projDir, ID.dbl, "subagents");
  const wfDir = path.join(subDir, "workflows", "wf_x");
  fs.mkdirSync(wfDir, { recursive: true });
  const agent = (dir, aid, meta, recs, ageMs) => {
    const file = path.join(dir, `agent-${aid}.jsonl`);
    fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.writeFileSync(path.join(dir, `agent-${aid}.meta.json`), JSON.stringify(meta));
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(file, t, t);
  };
  agent(subDir, "a1", { agentType: "Explore", description: "Search the parser" }, [
    { type: "user", isSidechain: true, timestamp: new Date(Date.now() - 60_000).toISOString(), message: { role: "user", content: "Find the parser" } },
    { type: "assistant", isSidechain: true, message: { id: "s1", content: [
      { type: "text", text: "Found it. <img src=x onerror=\"window.__pwned=3\"> **here**" },
      { type: "tool_use", name: "Grep", input: { pattern: "parse" } },
    ] } },
  ], 1000);
  agent(wfDir, "b2", { agentType: "general-purpose", description: "Write the summary" }, [
    { type: "user", isSidechain: true, message: { role: "user", content: "Summarise" } },
  ], 2 * HOUR);

  // Which sessions Claude Code has open comes from `claude agents --json`;
  // the test answers for it instead of spawning the real claude.
  require("../src/sessions.js").setOpenSessionsRunner(async () => []);
  const { serve } = require("../src/server.js");
  const opened = [];
  const onOpen = (t) => {
    opened.push(t);
    return t.pick ? { status: 501, error: "no folder picker on this platform" } : { ok: true };
  };
  const homeUrl = await new Promise((resolve) => serve(null, resolve, { home: true, onOpen }));

  const chrome = findChrome();
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: chrome.includes("chrome-headless-shell") ? "shell" : true,
    args: ["--no-sandbox"],
  });
  let failures = 0;
  const check = (label, cond) => {
    console.log(`${cond ? "ok " : "FAIL"} — ${label}`);
    if (!cond) failures++;
  };
  const MOD = process.platform === "darwin" ? "Meta" : "Control";
  const lastOpen = async (n) => {
    const deadline = Date.now() + 3000;
    while (opened.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    return opened[n - 1];
  };

  // ---- home view ----
  {
    const page = await browser.newPage();
    const alive = [];
    page.on("request", (r) => { if (r.url().includes("/api/alive")) alive.push(r.method()); });
    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#home-sessions li.row", { timeout: 5000 });

    check("home: body is in home mode", await page.$eval("body", (b) => b.classList.contains("home-mode")));
    check("home: editor grid is hidden", await page.$eval("#editor", (e) => getComputedStyle(e).display === "none"));
    check("home: alive ping runs", alive.includes("POST"));

    const recent = await page.$$eval("#home-recent li.row", (rows) => rows.map((r) => ({
      title: r.querySelector(".rtitle").textContent, gone: r.classList.contains("gone"), dis: r.getAttribute("aria-disabled"),
    })));
    check("home: recent folders listed", recent.length === 2 && recent[0].title === "fethr");
    check("home: missing folder greyed and disabled", recent[1].gone && recent[1].dis === "true");

    const ids = await page.$$eval("#home-sessions li.row", (rows) => rows.map((r) => r.dataset.id));
    check("home: temp sessions hidden by default", !ids.includes(ID.temp) && ids.length === 4);
    check("home: newest first", ids[0] === ID.live);
    await page.click("#home-temp");
    const withTemp = await page.$$eval("#home-sessions li.row", (rows) => rows.map((r) => r.dataset.id));
    check("home: temp toggle reveals temp sessions", withTemp.includes(ID.temp));
    await page.click("#home-temp");

    const liveRow = await page.$eval(`li[data-id="${ID.live}"]`, (r) => ({
      chip: (r.querySelector(".state") || {}).textContent,
      forkPrimary: r.querySelectorAll("button")[1].classList.contains("primary"),
      resumeTitle: r.querySelectorAll("button")[0].title,
    }));
    check("home: a session written seconds ago shows a 'recent' chip", liveRow.chip === "recent");
    check("home: a closed session has no chip",
      !(await page.$(`li[data-id="${ID.plain}"] .state`)));
    check("home: live session makes Fork primary", liveRow.forkPrimary);
    check("home: live Resume warns", /open elsewhere/i.test(liveRow.resumeTitle));
    check("home: missing-folder session buttons disabled",
      await page.$eval(`li[data-id="${ID.gone}"]`, (r) => [...r.querySelectorAll("button")].every((b) => b.disabled)));

    const titleText = await page.$eval(`li[data-id="${ID.plain}"] .ttext`, (e) => e.textContent);
    check("home: session title rendered as text", titleText.includes("<img"));
    check("home: XSS in a title did not run", !(await page.evaluate(() => window.__pwned)));

    // chips filter by source
    const chips = await page.$$eval("#home .chip", (cs) => cs.map((c) => c.textContent));
    check("home: source chips listed", chips.some((c) => c.startsWith("VS Code")) && chips.some((c) => c.startsWith("CLI")));
    await page.evaluate(() => [...document.querySelectorAll("#home .chip")].find((c) => c.textContent.startsWith("VS Code")).click());
    const vs = await page.$$eval("#home-sessions li.row", (rows) => rows.map((r) => r.dataset.id));
    check("home: chip filters to its source", vs.length === 1 && vs[0] === ID.live);
    await page.evaluate(() => document.querySelector("#home .chip").click());

    // "/" focuses search; typing filters; ArrowDown + Enter runs the primary action
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("/");
    check("home: / focuses search", await page.evaluate(() => document.activeElement.id === "home-search"));
    await page.keyboard.type("parser");
    const found = await page.$$eval("#home-sessions li.row", (rows) => rows.map((r) => r.dataset.id));
    check("home: search filters by title/prompt", found.length === 1 && found[0] === ID.plain);
    await page.keyboard.press("ArrowDown");
    check("home: ArrowDown moves into the list",
      await page.evaluate((id) => document.activeElement.dataset.id === id, ID.plain));
    await page.keyboard.press("Enter");
    let t = await lastOpen(1);
    check("home: Enter on a row resumes it (server resolves the folder)",
      t && t.session === ID.plain && t.fork === false && t.root === project);
    await page.waitForFunction(() => /Opening/.test(document.querySelector("#home-status").textContent), { timeout: 2000 });
    check("home: shows a transient opening status", true);
    check("home: home view stays", await page.$eval("#home", (h) => getComputedStyle(h).display !== "none"));

    // Escape clears the search; Enter on a live row forks
    await page.focus("#home-search");
    await page.keyboard.press("Escape");
    check("home: Escape clears the search", (await page.$eval("#home-search", (e) => e.value)) === "");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    t = await lastOpen(2);
    check("home: Enter on a live row forks", t && t.session === ID.live && t.fork === true);
    await page.keyboard.press("Enter");
    await sleep(400);
    check("home: a repeat open of the same session within 2 s is ignored", opened.length === 2);

    // explicit Fork button, once ID.plain's cooldown from the first Enter is over
    await sleep(2100);
    await page.click(`li[data-id="${ID.plain}"] .rbtns button:last-child`);
    t = await lastOpen(3);
    check("home: Fork button forks", t && t.session === ID.plain && t.fork === true);

    // recent folder click
    await page.click("#home-recent li.row");
    t = await lastOpen(4);
    check("home: clicking a recent folder opens it", t && t.root === project && !t.session);

    // ⌘O → pick → 501 → path box
    await page.keyboard.down(MOD);
    await page.keyboard.press("KeyO");
    await page.keyboard.up(MOD);
    await page.waitForSelector("#home-path:not([hidden])", { timeout: 2000 });
    t = await lastOpen(5);
    check("home: ⌘O asks for the folder picker", t && t.pick === true);
    check("home: 501 reveals and focuses the path box",
      await page.evaluate(() => document.activeElement.id === "home-path-input"));
    const typed = path.join(project, "web"); // not the folder just opened, which is in its cooldown
    await page.keyboard.type(typed);
    await page.keyboard.press("Enter");
    t = await lastOpen(6);
    check("home: path box opens the typed folder", t && t.root === typed);

    // a refused open shows the server's error
    await page.$eval("#home-path-input", (e) => { e.value = "relative/path"; e.focus(); });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#home-status").classList.contains("error"), { timeout: 2000 });
    check("home: a refused open shows the error", /absolute/.test(await page.$eval("#home-status", (e) => e.textContent)));

    // double-clicking Resume opens one window, not three
    const posts = [];
    page.on("request", (r) => { if (r.url().includes("/api/open")) posts.push(r.postData()); });
    await page.click(`li[data-id="${ID.dbl}"] .rbtns button:first-child`, { clickCount: 2 });
    await sleep(600);
    check("home: double-clicking Resume sends exactly one /api/open", posts.length === 1);
    await page.close();
  }

  // ---- home view: state, ages, subagents, the read-only viewer, polling ----
  {
    const page = await browser.newPage();
    const homeGets = [];
    page.on("request", (r) => { if (r.url().includes("/api/home")) homeGets.push(Date.now()); });
    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`li[data-id="${ID.dbl}"]`, { timeout: 5000 });
    const ageOf = (id) => page.$eval(`li[data-id="${id}"] .rage`, (e) => ({ text: e.textContent, title: e.title }));

    const plainAge = await ageOf(ID.plain);
    check("ages: 'started … · active …' under the title", plainAge.text === "started 4h ago · active 3h ago");
    check("ages: absolute times in the title attribute", /Started .+\nLast activity .+/.test(plainAge.title));
    const a1 = (await ageOf(ID.live)).text;
    await sleep(2100);
    const a2 = (await ageOf(ID.live)).text;
    check("ages: tick in place (seconds advance without a reload)", /active \d+s ago$/.test(a2) && a1 !== a2);

    const dblChip = await page.$eval(`li[data-id="${ID.dbl}"] .state`, (e) => e.textContent).catch(() => null);
    check("state: an active subagent makes its session 'recent'", dblChip === "recent");
    const toggle = await page.$eval(`li[data-id="${ID.dbl}"] .subtoggle`, (e) => ({ text: e.textContent, exp: e.getAttribute("aria-expanded") }));
    check("subagents: toggle reads '2 subagents · 1 active'", toggle.text.endsWith("2 subagents · 1 active") && toggle.exp === "false");
    check("subagents: no toggle without subagents", !(await page.$(`li[data-id="${ID.plain}"] .subtoggle`)));

    // "Active now" chip
    await page.evaluate(() => [...document.querySelectorAll("#home .chip")].find((c) => c.textContent.startsWith("Active now")).click());
    const activeIds = await page.$$eval("#home-sessions li.row.session", (rows) => rows.map((r) => r.dataset.id).sort());
    check("chip: Active now keeps only sessions with something happening", activeIds.join() === [ID.live, ID.dbl].sort().join());
    await page.evaluate(() => document.querySelector("#home .chip").click());

    // expand: lazy fetch of /api/subagents, sub-rows with type, workflow tag, state, age
    const subGets = [];
    page.on("request", (r) => { if (r.url().includes("/api/subagents")) subGets.push(r.url()); });
    check("subagents: not fetched until expanded", subGets.length === 0);
    await page.click(`li[data-id="${ID.dbl}"] .subtoggle`);
    await page.waitForSelector(`#home-sessions .subwrap li.subrow[data-agent="a1"]`, { timeout: 3000 });
    const subs = await page.$$eval("#home-sessions .subwrap li.subrow", (rows) => rows.map((r) => ({
      id: r.dataset.agent, title: r.querySelector(".ttext").textContent,
      chip: (r.querySelector(".state") || {}).textContent || null,
      where: (r.querySelector(".rwhere") || {}).textContent, tag: (r.querySelector(".tag") || {}).textContent || null,
      age: r.querySelector(".rage").textContent, buttons: r.querySelectorAll("button").length,
    })));
    check("subagents: fetched on expand", subGets.length === 1);
    check("subagents: listed newest first", subs.map((x) => x.id).join() === "a1,b2");
    check("subagents: description, type and active chip", subs[0].title === "Search the parser" && subs[0].where === "Explore" && subs[0].chip === "active");
    check("subagents: workflow tag", subs[1].tag === "wf_x" && subs[1].chip === null);
    check("subagents: 'active … ago' per row", /^active (just now|\d+s ago)$/.test(subs[0].age) && subs[1].age === "active 2h ago");
    check("subagents: no Resume/Fork on sub-rows", subs.every((x) => x.buttons === 0));
    check("subagents: toggle shows expanded", await page.$eval(`li[data-id="${ID.dbl}"] .subtoggle`, (e) => e.getAttribute("aria-expanded") === "true"));

    // focus, expansion and the very same DOM node survive a poll
    await page.focus(`li.subrow[data-agent="a1"]`);
    await page.evaluate(() => { window.__keep = document.activeElement; });
    const before = homeGets.length;
    await sleep(5600);
    check("poll: /api/home re-fetched while visible", homeGets.length > before);
    check("poll: expanded list re-fetched too", subGets.length >= 2);
    check("poll: focused sub-row is the same node and still focused",
      await page.evaluate(() => document.activeElement === window.__keep && window.__keep.isConnected));

    // keyboard: ArrowLeft from a sub-row goes to its session; ArrowLeft there collapses; ArrowRight expands
    await page.keyboard.press("ArrowLeft");
    check("keys: ← on a sub-row moves to its session", await page.evaluate((id) => document.activeElement.dataset.id === id, ID.dbl));
    await page.keyboard.press("ArrowLeft");
    await sleep(100);
    check("keys: ← on a session collapses its subagents", !(await page.$("#home-sessions .subwrap")));
    await page.keyboard.press("ArrowRight");
    await page.waitForSelector(`li.subrow[data-agent="a1"]`, { timeout: 3000 });
    check("keys: → expands again", true);

    // read-only viewer: Enter on a sub-row, Escape closes, focus returns
    await page.focus(`li.subrow[data-agent="a1"]`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /Found it/.test(document.querySelector("#home-viewer .vbody").textContent), { timeout: 3000 });
    const v = await page.$eval("#home-viewer", (e) => ({
      hidden: e.hidden, title: e.querySelector(".vtitle").textContent, meta: e.querySelector(".vmeta").textContent,
      body: e.querySelector(".vbody").textContent, strong: (e.querySelector(".vbody strong") || {}).textContent,
      img: !!e.querySelector(".vbody img"),
      buttons: [...e.querySelectorAll("button")].map((b) => b.textContent),
    }));
    check("viewer: opens with the subagent's description", !v.hidden && v.title === "Search the parser");
    check("viewer: marked read-only", /read-only/i.test(v.meta));
    check("viewer: prompt, reply and tool line shown", v.body.includes("Find the parser") && v.body.includes("⚙ Grep parse"));
    check("viewer: markdown rendered, HTML not", v.strong === "here" && !v.img && v.body.includes("<img"));
    check("viewer: XSS in a subagent transcript did not run", !(await page.evaluate(() => window.__pwned)));
    check("viewer: no Resume/Fork, only Close", v.buttons.join() === "Close");
    await page.keyboard.press("Escape");
    check("viewer: Escape closes", await page.$eval("#home-viewer", (e) => e.hidden));
    check("viewer: focus returns to the sub-row", await page.evaluate(() => document.activeElement.dataset.agent === "a1"));
    await page.click(`li.subrow[data-agent="b2"]`);
    await page.waitForFunction(() => /Summarise/.test(document.querySelector("#home-viewer .vbody").textContent), { timeout: 3000 });
    check("viewer: click on a sub-row opens it too", true);
    await page.click("#home-viewer .vhead button");
    check("viewer: Close button closes", await page.$eval("#home-viewer", (e) => e.hidden));

    // polling pauses while hidden, resumes (with an immediate fetch) when visible
    const setVis = (v) => page.evaluate((vis) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => vis });
      document.dispatchEvent(new Event("visibilitychange"));
    }, v);
    await setVis("hidden");
    await sleep(300);
    const hiddenAt = homeGets.length;
    const ageHidden = (await ageOf(ID.live)).text;
    await sleep(6000);
    check("poll: no /api/home while hidden", homeGets.length === hiddenAt);
    check("poll: ages stop ticking while hidden", (await ageOf(ID.live)).text === ageHidden);
    await setVis("visible");
    await sleep(500);
    check("poll: fetches at once when visible again", homeGets.length > hiddenAt);
    await page.close();
  }

  // ---- home view: sessions Claude Code reports as open, and a 409 ----
  {
    const page = await browser.newPage();
    const posts = [];
    const actions = [];
    const now = Date.now();
    const base = { cwd: project, project: "fethr", source: "CLI", mtime: now - 3600_000, size: 1, cwdExists: true, temp: false, live: false, open: null };
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (r.url().includes("/api/home")) {
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ recentFolders: [], sessions: [
          { ...base, id: ID.bg, title: "Background one", open: { kind: "background", status: "busy" }, subagents: { total: 4, active: 0 } },
          { ...base, id: ID.term, title: "Terminal one", open: { kind: "interactive", status: "idle" } },
          { ...base, id: ID.plain, title: "Plain one" },
        ] }) });
      }
      if (r.url().includes("/api/subagents")) {
        const a = (agentId, st) => ({ agentId, workflow: null, description: st + " one", agentType: "Explore", startedAt: now - 7200_000, lastActivity: now - 3600_000, size: 1, state: st });
        return r.respond({ status: 200, contentType: "application/json",
          body: JSON.stringify([a("k1", "killed"), a("s1", "stopped"), a("f1", "failed"), a("e1", "ended")]) });
      }
      if (r.url().includes("/api/session-action")) {
        const b = JSON.parse(r.postData());
        actions.push(b);
        return b.action === "attach"
          ? r.respond({ status: 501, contentType: "application/json", body: JSON.stringify({ error: "attach needs macOS Terminal" }) })
          : r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      }
      if (r.url().includes("/api/open")) {
        posts.push(JSON.parse(r.postData()));
        return r.respond({ status: 409, contentType: "application/json",
          body: JSON.stringify({ error: "That session is running in the background", hint: "claude attach abcdef12" }) });
      }
      r.continue();
    });
    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`li[data-id="${ID.bg}"]`, { timeout: 5000 });
    const row = (id) => page.$eval(`li[data-id="${id}"]`, (r) => ({
      badge: (r.querySelector(".state") || {}).textContent,
      buttons: [...r.querySelectorAll(".rbtns button")].map((b) => ({
        text: b.textContent, disabled: b.disabled, title: b.title, primary: b.classList.contains("primary"),
      })),
    }));
    const bg = await row(ID.bg), term = await row(ID.term);
    const btn = (r, text) => r.buttons.find((b) => b.text === text);
    check("open: background session shows a 'background' chip", bg.badge === "background");
    check("open: background offers Attach, Move here and Fork, no Resume",
      bg.buttons.map((b) => b.text).join(",") === "Attach,Move here,Fork");
    check("open: background makes Fork primary", btn(bg, "Fork").primary && !btn(bg, "Attach").primary);
    check("open: Attach names the attach command", btn(bg, "Attach").title.includes("claude attach abcdef12"));
    check("open: interactive session shows an 'open' chip", term.badge === "open");
    check("open: interactive Resume disabled with the reason",
      btn(term, "Resume").disabled && btn(term, "Resume").title === "Open in another Claude Code window — fork, or close it there first");
    check("open: interactive offers no Attach or Move here", !btn(term, "Attach") && !btn(term, "Move here") && btn(term, "Fork").primary);

    // subagent end states: killed/stopped/failed get a chip, ended none
    await page.click(`li[data-id="${ID.bg}"] .subtoggle`);
    await page.waitForSelector(`li.subrow[data-agent="e1"]`, { timeout: 3000 });
    const ends = await page.$$eval("li.subrow", (rows) => Object.fromEntries(rows.map((r) => {
      const c = r.querySelector(".state");
      return [r.dataset.agent, c ? [c.textContent, getComputedStyle(c).color] : null];
    })));
    check("subagent states: killed and stopped get chips", ends.k1 && ends.k1[0] === "killed" && ends.s1 && ends.s1[0] === "stopped");
    check("subagent states: failed gets a chip", ends.f1 && ends.f1[0] === "failed");
    check("subagent states: killed is not in the failure colour", ends.k1[1] !== ends.f1[1]);
    check("subagent states: ended gets no chip", ends.e1 === null);
    await page.click(`li[data-id="${ID.bg}"] .subtoggle`);

    // Attach → 501 → tells the person the command to run
    await page.evaluate((id) => [...document.querySelectorAll(`li[data-id="${id}"] .rbtns button`)].find((b) => b.textContent === "Attach").click(), ID.bg);
    await page.waitForFunction(() => /Attach needs macOS Terminal/.test(document.querySelector("#home-status").textContent), { timeout: 2000 });
    check("attach: request names the session", actions[0] && actions[0].id === ID.bg && actions[0].action === "attach");
    check("attach: 501 shows the attach command",
      (await page.$eval("#home-status", (e) => e.textContent)).includes("claude attach abcdef12"));

    // Move here asks inside the row; Cancel sends nothing
    const clickIn = (text) => page.evaluate((id, t) =>
      [...document.querySelectorAll(`li[data-id="${id}"] .rbtns button`)].find((b) => b.textContent === t).click(), ID.bg, text);
    await clickIn("Move here");
    const q = await page.$eval(`li[data-id="${ID.bg}"] .rbtns`, (b) => b.textContent);
    check("move: asks 'Stop it there and resume here?' in the row", q.includes("Stop it there and resume here?") && q.includes("Confirm") && q.includes("Cancel"));
    await clickIn("Cancel");
    check("move: Cancel restores the buttons and sends nothing",
      (await row(ID.bg)).buttons.map((b) => b.text).join(",") === "Attach,Move here,Fork" && actions.length === 1);
    await clickIn("Move here");
    await page.keyboard.press("Escape");
    check("move: Escape cancels too", (await row(ID.bg)).buttons.length === 3 && actions.length === 1);
    await clickIn("Move here");
    await clickIn("Confirm");
    await page.waitForFunction(() => /Moving/.test(document.querySelector("#home-status").textContent), { timeout: 2000 });
    check("move: Confirm posts stop-and-resume", actions[1] && actions[1].id === ID.bg && actions[1].action === "stop-and-resume");

    await page.focus(`li[data-id="${ID.bg}"]`);
    await page.keyboard.press("Enter");
    await sleep(300);
    check("open: Enter on an open session forks", posts[0] && posts[0].session === ID.bg && posts[0].fork === true);
    await page.click(`li[data-id="${ID.plain}"] .rbtns button:first-child`);
    await page.waitForFunction(() => document.querySelector("#home-status").classList.contains("error"), { timeout: 2000 });
    const msg = await page.$eval("#home-status", (e) => e.textContent);
    check("open: a 409 shows the error and the hint", msg.includes("running in the background") && msg.includes("claude attach abcdef12"));
    await page.close();
  }

  // ---- home view: Recent rows that remember a chat; moved sessions; 428 ----
  {
    const page = await browser.newPage();
    const posts = [];
    const now = Date.now();
    const S = {
      chat: "c0ffee00-1111-4111-8111-111111111111",
      bg: "bb000000-2222-4222-8222-222222222222",
      old: "01d00000-3333-4333-8333-333333333333",
      next: "0e170000-4444-4444-8444-444444444444",
      orphan: "0a000000-5555-4555-8555-555555555555",
      gone: "9a000000-6666-4666-8666-666666666666",
      broad: "b40ad000-7777-4777-8777-777777777777",
    };
    const base = { cwd: project, project: "fethr", source: "CLI", mtime: now - 3600_000, lastActivity: now - 3600_000, size: 1,
      cwdExists: true, temp: false, live: false, open: null, state: "closed", subagents: { total: 0, active: 0 } };
    const sessions = [
      { ...base, id: S.chat, title: "Same auto title" },
      { ...base, id: S.next, title: "Same auto title", continuedFrom: [S.old] },
      { ...base, id: S.old, title: "Moved away chat", superseded: true, continuedIn: S.next },
      { ...base, id: S.orphan, title: "Orphaned move", superseded: true, continuedIn: S.gone },
      { ...base, id: S.bg, title: "Background chat", state: "background", open: { kind: "background", status: "idle" }, temp: true },
      { ...base, id: S.broad, title: "Home folder chat" },
    ];
    const recentFolders = [
      { path: "/x/proj", name: "proj", lastOpened: now - 600_000, exists: true, session: { id: S.chat, title: "Same auto title", state: "closed", open: null } },
      { path: "/x/bgproj", name: "bgproj", lastOpened: now - 900_000, exists: true, session: { id: S.bg, title: "Background chat", state: "background", open: { kind: "background", status: "idle" } } },
      { path: "/x/plain", name: "plain", lastOpened: now - 1200_000, exists: true, session: null },
    ];
    let broadTries = 0;
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const u = r.url();
      if (u.includes("/api/home")) return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ recentFolders, sessions }) });
      if (u.includes("/api/open")) {
        const b = JSON.parse(r.postData());
        posts.push(b);
        if (b.session === S.broad && !b.confirmBroad && ++broadTries === 1) {
          return r.respond({ status: 428, contentType: "application/json", body: JSON.stringify({ broad: true, folder: "/Users/someone" }) });
        }
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      }
      r.continue();
    });
    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`li[data-id="${S.chat}"]`, { timeout: 5000 });

    const recent = await page.$$eval("#home-recent li.row", (rows) => rows.map((r) => ({
      title: r.querySelector(".ttext").textContent, meta: r.querySelector(".rmeta").textContent,
      chip: (r.querySelector(".state") || {}).textContent || null, when: r.querySelector(".rwhen").textContent,
    })));
    check("recent: line 1 is the chat title when the folder has one", recent[0].title === "Same auto title");
    check("recent: line 2 is folder name · path", recent[0].meta === "proj · /x/proj");
    check("recent: relative time on the right", recent[0].when === "10m ago");
    check("recent: closed chat has no chip; background one does", recent[0].chip === null && recent[1].chip === "background");
    check("recent: no chat → folder name, then path", recent[2].title === "plain" && recent[2].meta === "/x/plain");

    // short id and moved sessions
    // Separators are CSS ::before, so read the parts and the computed separator.
    const metaOf = (id) => page.$eval(`li[data-id="${id}"] .rmeta`, (m) => ({
      text: m.textContent, sid: m.querySelector(".sid").textContent,
      parts: [...m.children].map((c) => c.className),
      sep: getComputedStyle(m.querySelector(".sid"), "::before").content,
    })).catch(() => null);
    const chatMeta = await metaOf(S.chat), nextMeta = await metaOf(S.next), orphanMeta = await metaOf(S.orphan);
    check("ids: short id in the meta line", chatMeta.sid === S.chat.slice(0, 8) && chatMeta.text.startsWith(`fethr · CLI${S.chat.slice(0, 8)}`) &&
      chatMeta.parts.join() === "rwhere,sid,rage" && chatMeta.sep.includes("·"));
    check("ids: two sessions with one auto-title differ by id", nextMeta.sid !== chatMeta.sid);
    check("moved: superseded session is hidden", (await metaOf(S.old)) === null);
    check("moved: successor says 'continued from <id8>'", nextMeta.text.includes(`continued from ${S.old.slice(0, 8)}`));
    check("moved: superseded with its successor missing shows 'continued in <id8>'", orphanMeta && orphanMeta.text.includes(`continued in ${S.gone.slice(0, 8)}`));
    await page.focus("#home-search");
    await page.keyboard.type("Moved away");
    check("moved: search does not find the hidden one",
      (await page.$eval("#home-sessions", (l) => l.textContent)).includes("No sessions match"));
    await page.keyboard.press("Escape");

    // clicking a recent chat resumes it
    await page.click("#home-recent li.row:nth-child(1)");
    await sleep(300);
    check("recent: click resumes that chat", posts[0] && posts[0].session === S.chat && posts[0].fork === false);
    // a recent chat open elsewhere: no open; focus + highlight its row (un-hiding temp)
    await page.focus("#home-recent li.row:nth-child(2)");
    await page.keyboard.press("Enter");
    await sleep(200);
    check("recent: open-elsewhere chat sends no open", posts.length === 1);
    const focused = await page.evaluate(() => ({ id: document.activeElement.dataset.id, flash: document.activeElement.classList.contains("flash") }));
    check("recent: focuses and highlights that session's row", focused.id === S.bg && focused.flash);
    check("recent: …which offers Attach / Move here / Fork",
      (await page.$$eval(`li[data-id="${S.bg}"] .rbtns button`, (bs) => bs.map((b) => b.textContent))).join() === "Attach,Move here,Fork");
    await page.click("#home-recent li.row:nth-child(3)");
    await sleep(300);
    check("recent: no chat → opens the folder", posts[1] && posts[1].root === "/x/plain" && !posts[1].session);

    // 428 broad folder → "Open anyway" → retried with confirmBroad
    await page.click(`li[data-id="${S.broad}"] .rbtns button:first-child`);
    await page.waitForSelector("#home-status .confirm-broad", { timeout: 2000 });
    check("broad: 428 asks in the status line", (await page.$eval("#home-status", (e) => e.textContent)).includes("/Users/someone"));
    await page.click("#home-status .confirm-broad");
    await page.waitForFunction(() => /Opening/.test(document.querySelector("#home-status").textContent), { timeout: 2000 });
    const retry = posts[posts.length - 1];
    check("broad: Open anyway retries with confirmBroad", retry.session === S.broad && retry.confirmBroad === true);
    await page.close();
  }

  // ---- home view: a native picker answers {pending} ----
  {
    const picks = [];
    const url = await new Promise((resolve) => serve(null, resolve, { home: true, onOpen: (t) => (picks.push(t), { pending: true }) }));
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#home-pick");
    await page.click("#home-pick");
    const deadline = Date.now() + 3000;
    while (!picks.length && Date.now() < deadline) await sleep(50);
    await sleep(300);
    const st = await page.$eval("#home-status", (e) => e.textContent);
    check("pending: picker request sent", picks[0] && picks[0].pick === true);
    check("pending: no 'Opening…' status", !/Opening/.test(st) && !(await page.$eval("#home-path", (e) => !e.hidden)));
    await page.close();
  }

  // ---- editor launched on a session, forked ----
  {
    const url = await new Promise((resolve) => serve(editorRoot, resolve, { session: { id: ID.plain, fork: true }, onOpen }));
    const page = await browser.newPage();
    const bodies = [];
    const chatPuts = [];
    const recentPosts = [];
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (r.url().includes("/api/chat") && r.method() === "PUT") chatPuts.push(1);
      if (r.url().includes("/api/recent")) {
        recentPosts.push(JSON.parse(r.postData()));
        return r.respond({ status: 200, contentType: "application/json", body: "{}" });
      }
      if (!r.url().includes("/api/agent")) return r.continue();
      bodies.push(JSON.parse(r.postData()));
      const id = bodies.length === 1 ? FORKED : bodies[bodies.length - 1].sessionId;
      r.respond({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "session", id })}\n\ndata: ${JSON.stringify({ type: "delta", text: "ok" })}\n\ndata: {"type":"done","ok":true}\n\n`,
      });
    });
    // a chat.json in the folder must not be what gets shown
    fs.mkdirSync(path.join(editorRoot, ".fethr"));
    fs.writeFileSync(path.join(editorRoot, ".fethr", "chat.json"), JSON.stringify({ session: null, entries: [{ type: "user", text: "folder chat" }] }));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => /forked from/.test(document.querySelector("#chat").textContent), { timeout: 5000 });
    const chat = await page.$eval("#chat", (c) => c.textContent);
    check("resume: earlier prompt shown", chat.includes("please refactor the parser"));
    check("resume: tool entry in tool style", await page.$$eval("#chat .msg.tool", (ms) => ms.some((m) => m.textContent === "⚙ Read src/parser.js")));
    check("resume: assistant markdown rendered, script not", await page.$eval("#chat .msg.assistant strong", (s) => s.textContent === "bold"));
    check("resume: XSS in history did not run", !(await page.evaluate(() => window.__pwned)));
    check("resume: fork line names the session", /forked from: Refactor the parser .*\(original untouched\)/.test(chat));
    check("resume: agent panel opened", await page.$eval("body", (b) => b.classList.contains("agent-open")));
    check("resume: the folder's own chat.json is not shown", !chat.includes("folder chat"));

    await page.type("#input", "first");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("#chat .msg.user").length >= 2, { timeout: 3000 });
    await page.waitForFunction(() => !document.querySelector("#agent-status").classList.contains("on"), { timeout: 3000 });
    await page.type("#input", "second");
    await page.keyboard.press("Enter");
    const deadline = Date.now() + 3000;
    while (bodies.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    check("fork: first request resumes the original with fork:true", bodies[0] && bodies[0].sessionId === ID.plain && bodies[0].fork === true);
    check("fork: second request uses the new id without fork", bodies[1] && bodies[1].sessionId === FORKED && bodies[1].fork === false);
    await page.waitForFunction(() => !document.querySelector("#agent-status").classList.contains("on"), { timeout: 3000 });
    await sleep(200);
    check("resume: nothing written to chat.json (no PUT /api/chat)", chatPuts.length === 0);
    check("recent: the editor reports the session id once (the fork's new id)",
      recentPosts.length === 1 && recentPosts[0].session === FORKED);
    check("resume: the folder's chat.json is unchanged",
      JSON.parse(fs.readFileSync(path.join(editorRoot, ".fethr", "chat.json"), "utf8")).entries[0].text === "folder chat");

    // home button
    await page.click("#go-home");
    const h = await lastOpen(opened.length + 1);
    check("home button asks for the home window", h && h.home === true);
    await page.close();
  }

  // ---- editor resume: history edge cases (answered in the page) ----
  {
    const url = await new Promise((resolve) => serve(editorRoot, resolve, { session: { id: ID.plain, fork: false }, onOpen }));
    const histPage = async (status, body) => {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", (r) => r.url().includes("/api/session-history")
        ? r.respond({ status, contentType: "application/json", body: JSON.stringify(body) })
        : r.continue());
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => /resumed session/.test(document.querySelector("#chat").textContent), { timeout: 5000 });
      const text = await page.$$eval("#chat .msg", (ms) => ms.map((m) => m.textContent));
      await page.close();
      return text;
    };
    let msgs = await histPage(200, { id: ID.plain, entries: [{ type: "user", text: "hi" }, { type: "tool", text: "context compacted" }], truncated: true });
    check("history: truncated without a count says turns are not shown", msgs[0] === "— earlier turns not shown —");
    check("history: compaction shows as a tool line", msgs.includes("⚙ context compacted"));
    msgs = await histPage(200, { id: ID.plain, entries: [], truncated: true, omitted: 7 });
    check("history: the count is shown when known", msgs[0] === "— 7 earlier turns not shown —");
    msgs = await histPage(500, { error: "could not read session" });
    check("history: a failed fetch shows the server's error", msgs.some((m) => m.includes("could not read session")));
  }

  // ---- editor resume: a session still running elsewhere → "Fork instead" ----
  {
    const url = await new Promise((resolve) => serve(editorRoot, resolve, { session: { id: ID.plain, fork: false }, onOpen }));
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    const cliError = "Claude Code process exited with code 1. stderr: Error: That session is running in the background (abcdef12). " +
      "Run `claude attach abcdef12` to rejoin it. Add --fork-session to branch off a copy instead.";
    const forkOnly = "Claude Code process exited with code 1. stderr: Error: session busy. Add --fork-session to branch off a copy instead.";
    let asks = 0;
    const actions = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/session-action")) {
        actions.push(JSON.parse(r.postData()));
        return r.respond({ status: 501, contentType: "application/json", body: JSON.stringify({ error: "no terminal" }) });
      }
      if (!r.url().includes("/api/agent")) return r.continue();
      const message = ++asks === 1 ? cliError : forkOnly;
      r.respond({ status: 200, contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "error", message })}\n\ndata: {"type":"done","ok":true}\n\n` });
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => /resumed session/.test(document.querySelector("#chat").textContent), { timeout: 5000 });
    await page.type("#input", "hello");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#chat .fork-offer button", { timeout: 3000 });
    check("fork-instead: offered under the CLI's background-session error", true);
    const before = opened.length;
    await page.click("#chat .fork-offer button");
    const t = await lastOpen(before + 1);
    check("fork-instead: opens a fork of the original session", t && t.session === ID.plain && t.fork === true);
    await page.waitForFunction(() => /new window/.test(document.querySelector("#chat .fork-offer").textContent), { timeout: 2000 });
    check("fork-instead: says a window is opening", true);

    const offers = await page.$$eval("#chat .fork-offer", (os) => os.map((o) => [...o.querySelectorAll("button")].map((b) => b.textContent)));
    check("fork-instead: a named background session also offers Attach", offers[0].join(",") === "Fork instead,Attach in Terminal");
    await page.evaluate(() => [...document.querySelectorAll("#chat .fork-offer button")].find((b) => b.textContent === "Attach in Terminal").click());
    await page.waitForFunction(() => /claude attach abcdef12/.test(document.querySelector("#chat .fork-offer span").textContent), { timeout: 2000 });
    check("fork-instead: Attach posts attach for the original id", actions[0] && actions[0].id === ID.plain && actions[0].action === "attach");
    check("fork-instead: Attach 501 shows the command", true);

    await page.waitForFunction(() => !document.querySelector("#agent-status").classList.contains("on"), { timeout: 3000 });
    await page.type("#input", "again");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("#chat .fork-offer").length === 2, { timeout: 3000 });
    const second = await page.$$eval("#chat .fork-offer", (os) => [...os[1].querySelectorAll("button")].map((b) => b.textContent));
    check("fork-instead: without a background id, Fork only", second.join(",") === "Fork instead");
    await page.close();
  }

  // ---- round 4: agent-only window, files toggle, slash commands, resumed source, empty replies ----
  {
    const url = await new Promise((resolve) => serve(editorRoot, resolve, { session: { id: ID.plain, fork: false }, onOpen }));
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    const bodies = [];
    const replies = [];
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const u = r.url();
      if (u.includes("/api/meta")) {
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({
          mode: "editor", root: editorRoot, name: path.basename(editorRoot), gitBranch: null, version: "0.0.0", channel: "npm",
          resume: { id: ID.plain, fork: false, title: "Refactor the parser", source: "VS Code / Cursor" },
        }) });
      }
      if (u.includes("/api/recent")) return r.respond({ status: 200, contentType: "application/json", body: "{}" });
      if (!u.includes("/api/agent")) return r.continue();
      bodies.push(JSON.parse(r.postData()));
      const evs = replies.shift() || [];
      r.respond({ status: 200, contentType: "text/event-stream", body: evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") });
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => /resumed session/.test(document.querySelector("#chat").textContent), { timeout: 5000 });

    // 1. agent-only layout
    const lay = await page.evaluate(() => {
      const vis = (sel) => getComputedStyle(document.querySelector(sel)).display !== "none";
      const chat = document.querySelector("#chat");
      const cs = getComputedStyle(chat);
      return {
        cls: document.body.classList.contains("files-hidden"),
        editor: vis("#editor"), sidebar: vis("body > aside:not(#agent)"), agent: vis("#agent"),
        agentW: document.querySelector("#agent").getBoundingClientRect().width, winW: window.innerWidth,
        // padding % is of the box's own width, so offsetWidth minus both pads is the measure
        column: chat.offsetWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        ch72: (() => { const m = document.createElement("div"); m.style.width = "72ch"; chat.appendChild(m); const w = m.getBoundingClientRect().width; m.remove(); return w; })(),
        centred: Math.abs(parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) < 1,
        composerBottom: document.querySelector("#composer").getBoundingClientRect().bottom,
        footerTop: document.querySelector("footer").getBoundingClientRect().top,
        title: document.title, head: document.querySelector("#agent-title").textContent,
      };
    });
    check("agent-only: a resumed window hides sidebar and editor", lay.cls && !lay.editor && !lay.sidebar && lay.agent);
    check("agent-only: the conversation takes the full width", Math.abs(lay.agentW - lay.winW) < 2);
    check("agent-only: reading column is 72ch, centred", Math.abs(lay.column - lay.ch72) < 2 && lay.centred);
    check("agent-only: composer pinned at the bottom (just above the status bar)", Math.abs(lay.composerBottom - lay.footerTop) < 2);
    const want = `Refactor the parser · ${ID.plain.slice(0, 8)} · ${path.basename(editorRoot)}`;
    check("agent-only: title shows session title, short id and folder", lay.title.startsWith(want) && lay.head === want);

    // 2. files toggle: button and ⌘E, remembered in sessionStorage
    await page.click("#toggle-files");
    const shown = await page.evaluate(() => ({
      cls: document.body.classList.contains("files-hidden"),
      editorW: document.querySelector("#editor").getBoundingClientRect().width,
      agentW: document.querySelector("#agent").getBoundingClientRect().width,
      stored: sessionStorage.getItem("fethr.filesHidden"),
    }));
    check("files: the button reveals the editor beside the agent", !shown.cls && shown.editorW > 100 && shown.agentW > 200 && shown.agentW < 700);
    check("files: choice kept in sessionStorage", shown.stored === "0");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => /resumed session/.test(document.querySelector("#chat").textContent), { timeout: 5000 });
    check("files: the choice survives a reload of this window", !(await page.evaluate(() => document.body.classList.contains("files-hidden"))));
    await page.keyboard.down(MOD);
    await page.keyboard.press("KeyE");
    await page.keyboard.up(MOD);
    check("files: ⌘E hides them again", await page.evaluate(() =>
      document.body.classList.contains("files-hidden") && sessionStorage.getItem("fethr.filesHidden") === "1"));

    // 3. slash commands never reach the agent
    const typeSend = async (text) => { await page.focus("#input"); await page.keyboard.type(text); await page.keyboard.press("Enter"); await sleep(250); };
    await typeSend("/permissions");
    const card = await page.$eval('#chat .local-card[data-cmd="permissions"]', (c) => c.textContent).catch(() => "");
    check("slash: /permissions renders a local card", card.includes("Read files") && card.includes("Propose an edit") && card.includes("Bash") && card.includes("Subagents"));
    check("slash: card gives the terminal command for this session", card.includes(`claude --resume ${ID.plain}`));
    await typeSend("/tools");
    check("slash: /tools shows the same card", !!(await page.$('#chat .local-card[data-cmd="tools"]')));
    await typeSend("/compact now");
    const note = await page.$eval('#chat .local-card[data-cmd="compact"]', (c) => c.textContent).catch(() => "");
    check("slash: other commands get the 'not available' note + hint", note.includes("aren't available in fethr's panel") && note.includes("claude --resume"));
    check("slash: nothing was sent to /api/agent", bodies.length === 0);

    // 4. resumed source on every request; 5. empty replies
    replies.push([{ type: "session", id: ID.plain }, { type: "done", ok: true, detail: "the model returned no text" }]);
    await typeSend("/Users/x/app.js what is this");
    await page.waitForFunction(() => !document.querySelector("#agent-status").classList.contains("on"), { timeout: 3000 });
    check("slash: a path that starts with / is still sent", bodies.length === 1 && bodies[0].prompt.startsWith("/Users/x/app.js"));
    check("resumed: request carries resumed.source", bodies[0].resumed && bodies[0].resumed.source === "VS Code / Cursor");
    const lastAgent = () => page.$$eval("#chat .msg.assistant", (ms) => ms.length ? ms[ms.length - 1].textContent : null);
    check("empty reply: shows the done event's detail", (await lastAgent()).endsWith("the model returned no text"));
    replies.push([{ type: "session", id: ID.plain }, { type: "done", ok: true }]);
    await typeSend("second");
    await page.waitForFunction(() => !document.querySelector("#agent-status").classList.contains("on"), { timeout: 3000 });
    check("resumed: every request carries it", bodies[1] && bodies[1].resumed && bodies[1].resumed.source === "VS Code / Cursor");
    check("empty reply: no detail → 'no reply'", (await lastAgent()).endsWith("no reply"));
    const nAgent = await page.$$eval("#chat .msg.assistant", (ms) => ms.length);
    replies.push([{ type: "error", message: "boom" }, { type: "done", ok: false, error: "failed" }]);
    await typeSend("third");
    await page.waitForFunction(() => !document.querySelector("#agent-status").classList.contains("on"), { timeout: 3000 });
    check("empty reply: an error run leaves no empty agent bubble",
      (await page.$$eval("#chat .msg.assistant", (ms) => ms.length)) === nAgent &&
      (await page.$$eval("#chat .msg.assistant", (ms) => ms.every((m) => m.textContent.replace(/^agent/, "").trim()))));
    await page.close();
  }

  // ---- round 4: a normal window can give the agent the full width ----
  {
    const url = await new Promise((resolve) => serve(editorRoot, resolve, { onOpen }));
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#toggle-files");
    await sleep(300);
    check("files: a normal window starts with files shown", !(await page.evaluate(() => document.body.classList.contains("files-hidden"))));
    await page.click("#toggle-files");
    const st = await page.evaluate(() => ({
      hidden: document.body.classList.contains("files-hidden"), agentOpen: document.body.classList.contains("agent-open"),
      agentW: document.querySelector("#agent").getBoundingClientRect().width, winW: window.innerWidth,
    }));
    check("files: hiding them in a normal window opens the agent full width", st.hidden && st.agentOpen && Math.abs(st.agentW - st.winW) < 2);
    await page.click("#toggle-agent");
    check("files: closing the agent brings the files back",
      await page.evaluate(() => !document.body.classList.contains("files-hidden") && getComputedStyle(document.querySelector("#editor")).display !== "none"));
    await page.close();
  }

  // ---- round 5: read-only / full mode, editor sync, denied tools ----
  {
    const r5 = path.join(tmp, "r5");
    fs.mkdirSync(path.join(r5, "lib"), { recursive: true });
    fs.writeFileSync(path.join(r5, "app.js"), "one\ntwo\nthree\n");
    fs.writeFileSync(path.join(r5, "lib", "util.js"), "u\n");
    const url = await new Promise((resolve) => serve(r5, resolve, { onOpen }));
    const page = await browser.newPage();
    const bodies = [];
    const runs = []; // per request: { before(), events }
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (!r.url().includes("/api/agent")) return r.continue();
      bodies.push(JSON.parse(r.postData()));
      const run = runs.shift() || { events: [] };
      if (run.before) run.before();
      const evs = [{ type: "session", id: FORKED }, ...run.events, { type: "done", ok: true }];
      r.respond({ status: 200, contentType: "text/event-stream", body: evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") });
    });
    const ask = async (text) => {
      await page.focus("#input");
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector("#agent-status").classList.contains("on"), { timeout: 3000 });
      await sleep(400); // refreshWorkspace is debounced
    };
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('#tree [data-p="app.js"]');

    check("mode: the auto checkbox is labelled auto-apply",
      await page.$eval("#auto", (i) => i.parentElement.textContent.trim() === "auto-apply"));
    check("mode: read-only by default", await page.$eval('#mode [data-mode="readonly"]', (b) => b.getAttribute("aria-checked") === "true"));
    check("mode: no full-mode note in read-only", await page.$eval("#mode-note", (n) => n.hidden));
    await page.click("#toggle-agent");
    await ask("hello");
    check("mode: body carries mode readonly", bodies[0].mode === "readonly");
    await page.click('#mode [data-mode="full"]');
    const full = await page.evaluate(() => ({
      cls: document.body.classList.contains("agent-full"), note: !document.querySelector("#mode-note").hidden,
      noteText: document.querySelector("#mode-note").textContent, stored: sessionStorage.getItem("fethr.agentMode"),
    }));
    check("mode: full shows the amber state and the note", full.cls && full.note && full.noteText === "Full Claude Code — tools run without asking (auto mode)");
    check("mode: remembered for this window", full.stored === "full");
    await ask("now full");
    check("mode: body carries mode full", bodies[1].mode === "full");
    check("mode: switching kept the session", bodies[1].sessionId === FORKED);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('#tree [data-p="app.js"]');
    check("mode: survives a reload of this window", await page.evaluate(() => document.body.classList.contains("agent-full")));
    {
      const other = await browser.newPage();
      await other.goto(url, { waitUntil: "domcontentloaded" });
      await other.waitForSelector("#mode");
      check("mode: another window starts read-only", await other.$eval('#mode [data-mode="readonly"]', (b) => b.getAttribute("aria-checked") === "true"));
      await other.close();
    }

    // clean buffer: reloaded in place with an "updated by agent" note
    await page.click('#tree [data-p="app.js"]');
    await page.waitForFunction(() => document.querySelector("#file").textContent.includes("app.js"));
    if (!(await page.evaluate(() => document.body.classList.contains("agent-open")))) await page.click("#toggle-agent");
    await page.evaluate(() => { const v = window.__fethrView; v.dispatch({ selection: { anchor: 5 } }); });
    runs.push({ before: () => fs.writeFileSync(path.join(r5, "app.js"), "one\nTWO\nthree\nfour\n"), events: [{ type: "file-changed", path: "app.js" }] });
    await ask("edit app.js");
    const clean = await page.evaluate(() => ({
      doc: window.__fethrView.state.doc.toString(), head: window.__fethrView.state.selection.main.head,
      file: document.querySelector("#file").textContent, status: document.querySelector("#status").textContent,
    }));
    check("sync: clean buffer reloads from disk", clean.doc === "one\nTWO\nthree\nfour\n");
    check("sync: cursor kept, buffer not dirty", clean.head === 5 && !clean.file.includes("•"));
    check("sync: says 'updated by agent'", clean.status === "updated by agent");

    // dirty buffer: banner, nothing overwritten; Keep mine and Reload
    await page.evaluate(() => { const a = document.querySelector("#autosave"); if (a.checked) a.click(); });
    await page.focus(".cm-content");
    await page.keyboard.press("End");
    await page.keyboard.type(" mine");
    runs.push({ before: () => fs.writeFileSync(path.join(r5, "app.js"), "agent version\n"), events: [{ type: "file-changed", path: path.join(r5, "app.js") }] });
    await ask("edit again");
    const dirtyState = await page.evaluate(() => ({
      banner: !document.querySelector("#disk-banner").hidden, doc: window.__fethrView.state.doc.toString(),
    }));
    check("sync: dirty buffer shows the Reload / Keep mine banner (absolute path matched)", dirtyState.banner);
    check("sync: dirty buffer is not replaced", dirtyState.doc.includes(" mine"));
    check("sync: disk keeps the agent's version", fs.readFileSync(path.join(r5, "app.js"), "utf8") === "agent version\n");
    await page.click("#disk-keep");
    check("sync: Keep mine hides the banner and keeps the buffer",
      await page.evaluate(() => document.querySelector("#disk-banner").hidden && window.__fethrView.state.doc.toString().includes(" mine")));
    runs.push({ events: [{ type: "file-changed", path: "app.js" }] });
    await ask("once more");
    check("sync: banner returns while disk still differs", await page.evaluate(() => !document.querySelector("#disk-banner").hidden));
    await page.click("#disk-reload");
    await page.waitForFunction(() => document.querySelector("#disk-banner").hidden, { timeout: 2000 }).catch(() => {});
    check("sync: Reload takes the disk version",
      await page.evaluate(() => window.__fethrView.state.doc.toString() === "agent version\n" && document.querySelector("#disk-banner").hidden &&
        !document.querySelector("#file").textContent.includes("•")));

    // maybe-changed (after Bash) and end of a full run refresh the tree, folds kept
    await page.click('#tree .dir-row[data-dir="lib"]');
    runs.push({ before: () => fs.writeFileSync(path.join(r5, "made-by-bash.js"), "x\n"), events: [{ type: "maybe-changed" }] });
    await ask("run a script");
    check("tree: maybe-changed shows a new file", !!(await page.$('#tree [data-p="made-by-bash.js"]')));
    check("tree: folded folders stay folded", await page.$eval('#tree .dir-row[data-dir="lib"]', (r) => r.classList.contains("collapsed")));
    runs.push({ before: () => fs.writeFileSync(path.join(r5, "quiet.js"), "y\n"), events: [] });
    await ask("quiet run");
    check("tree: refreshed at the end of every full run", !!(await page.$('#tree [data-p="quiet.js"]')));

    // denied tools and outside-root changes: tool lines only
    runs.push({ events: [
      { type: "tool-denied", name: "Bash", detail: "the classifier blocked rm -rf" },
      { type: "file-changed", path: "/etc/hosts", outside: true },
    ] });
    await ask("try something risky");
    const lines = await page.$$eval("#chat .msg.tool", (ms) => ms.map((m) => m.textContent));
    check("denied: a 'blocked: <name> — <detail>' line", lines.includes("blocked: Bash — the classifier blocked rm -rf"));
    check("outside: a tool line only", lines.includes("changed outside this folder: /etc/hosts") &&
      (await page.$eval("#file", (e) => e.textContent)).includes("app.js"));

    // agent-only window: the mode control sits at the top of the reading column
    await page.click("#toggle-files");
    const pos = await page.evaluate(() => {
      const m = document.querySelector("#mode").getBoundingClientRect();
      const chat = document.querySelector("#chat");
      const left = chat.getBoundingClientRect().left + parseFloat(getComputedStyle(chat).paddingLeft);
      return { modeLeft: m.left, colLeft: left, top: m.top };
    });
    check("mode: in agent-only it sits at the top of the column", pos.modeLeft >= pos.colLeft - 1 && pos.top < 60);
    await page.close();
  }

  // ---- round 6: prefs across launches ----
  {
    const r6 = path.join(tmp, "r6");
    fs.mkdirSync(r6, { recursive: true });
    for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(r6, `f${i}.js`), `// ${i}\n`);
    const urlA = await new Promise((resolve) => serve(r6, resolve, { onOpen }));
    let page = await browser.newPage();
    await page.goto(urlA, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#toggle-view");
    await page.click("#toggle-view");
    await page.click('#viewmenu .row[data-id="slate"]');
    await page.evaluate(() => { const a = document.querySelector("#autosave"); a.checked = true; a.click(); });
    await sleep(700); // the 300 ms write-behind
    await page.close();
    const urlB = await new Promise((resolve) => serve(r6, resolve, { onOpen })); // a new launch: new port, new origin
    check("prefs: a new launch has a different origin", new URL(urlA).port !== new URL(urlB).port);
    page = await browser.newPage();
    await page.goto(urlB, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), { timeout: 5000 });
    check("prefs: theme survives a relaunch", await page.evaluate(() => document.documentElement.dataset.theme === "slate"));
    check("prefs: auto-save off survives a relaunch", await page.evaluate(() => document.querySelector("#autosave").checked === false));
    check("prefs: stored in the state dir", JSON.parse(fs.readFileSync(path.join(process.env.FETHR_STATE_DIR, "prefs.json"), "utf8"))["fethr.theme"] === "slate");
    check("color-scheme: a dark theme declares dark", await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme === "dark"));
    await page.close();
    // the server's prefs failing: the page still opens and falls back to localStorage
    page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().includes("/api/prefs") ? r.respond({ status: 500, body: "{}" }) : r.continue()));
    await page.goto(urlB, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), { timeout: 5000 });
    await page.click("#toggle-view");
    await page.click('#viewmenu .row[data-id="paper"]');
    check("prefs: without the server, writes still land in localStorage",
      await page.evaluate(() => localStorage.getItem("fethr.theme") === "paper"));
    check("color-scheme: a light theme declares light", await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme === "light"));
    check("native: no overscroll bounce; chrome not selectable, transcript is", await page.evaluate(() =>
      getComputedStyle(document.body).overscrollBehaviorY === "none" &&
      getComputedStyle(document.querySelector("footer")).userSelect === "none" &&
      getComputedStyle(document.querySelector("#chat")).userSelect === "text"));
    await page.close();
  }

  // ---- round 6: focus, Esc ownership, reading, scroll-follow, markdown, turn list ----
  {
    const r6 = path.join(tmp, "r6");
    const url = await new Promise((resolve) => serve(r6, resolve, { onOpen }));
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 640 });
    const md = "# Head <img src=x onerror=\"window.__pwned=11\">\n" +
      "Some text\n- item one <img src=x onerror=\"window.__pwned=12\">\n- item **two**\n" +
      "3. third <script>window.__pwned=13</script>\n4. fourth\n" +
      "> quoted <img src=x onerror=\"window.__pwned=14\">\n> still quoted\n### Small head\nafter";
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (!r.url().includes("/api/agent")) return r.continue();
      const evs = [{ type: "session", id: FORKED }, { type: "delta", text: md }, { type: "done", ok: true }];
      r.respond({ status: 200, contentType: "text/event-stream", body: evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") });
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('#tree [data-p="f1.js"]');
    await page.click("#toggle-files"); // agent-only
    const send = async (t) => { await page.focus("#input"); await page.keyboard.type(t); await page.keyboard.press("Enter"); await sleep(200); };
    await send("format please");
    await page.waitForFunction(() => !document.querySelector("#agent-status").classList.contains("on"), { timeout: 3000 });

    // markdown blocks, escape-first
    const m = await page.$eval("#chat .msg.assistant:last-of-type", (e) => ({
      h3: (e.querySelector("h3") || {}).textContent, h5: (e.querySelector("h5") || {}).textContent,
      ul: [...e.querySelectorAll("ul > li")].map((li) => li.innerHTML),
      ol: [...e.querySelectorAll("ol > li")].map((li) => li.textContent), olStart: (e.querySelector("ol") || {}).getAttribute?.("start"),
      bq: (e.querySelector("blockquote") || {}).textContent,
      bad: e.querySelectorAll("img, script").length,
    }));
    check("md: # heading", m.h3 && m.h3.startsWith("Head <img"));
    check("md: ### heading", m.h5 === "Small head");
    check("md: bulleted list, inline bold still works", m.ul.length === 2 && m.ul[1] === "item <strong>two</strong>");
    check("md: numbered list keeps its start", m.ol.length === 2 && m.olStart === "3" && m.ol[0].includes("<script>"));
    check("md: blockquote", m.bq && m.bq.includes("quoted <img") && m.bq.includes("still quoted"));
    check("md: no element made from the text (heading, list, quote)", m.bad === 0);
    check("md: no payload ran", !(await page.evaluate(() => window.__pwned)));

    // reading styles
    const rd = await page.evaluate(() => {
      const a = getComputedStyle(document.querySelector("#chat .msg.assistant"));
      const u = getComputedStyle(document.querySelector("#chat .msg.user"));
      return { size: a.fontSize, lh: a.lineHeight, ubg: u.backgroundColor, ushadow: u.boxShadow, urad: u.borderTopLeftRadius };
    });
    check("reading: messages 15px / 1.6", rd.size === "15px" && rd.lh === "24px");
    check("reading: user turn tinted with an accent bar, 6px radius", rd.ubg !== "rgba(0, 0, 0, 0)" && rd.ushadow.includes("inset") && rd.urad === "6px");

    // turn list
    await send("second prompt");
    await page.waitForFunction(() => !document.querySelector("#agent-status").classList.contains("on"), { timeout: 3000 });
    await send("/compact"); // local, not a prompt
    const turns = await page.$$eval("#turns button", (bs) => bs.map((b) => [b.querySelector(".n").textContent, b.querySelector(".t").textContent]));
    check("turns: one row per prompt, numbered", turns.length === 2 && turns[0][0] === "1" && turns[1][1] === "second prompt");
    check("turns: shown beside the column at ≥1100px", await page.$eval("#turns", (n) => getComputedStyle(n).display !== "none"));
    check("turns: two-line clamp", await page.$eval("#turns .t", (t) => getComputedStyle(t).webkitLineClamp === "2"));
    await page.click("#turns button:first-child");
    await sleep(700);
    check("turns: click scrolls that prompt to the top", await page.evaluate(() => {
      const u = document.querySelector("#chat .msg.user");
      return Math.abs(u.getBoundingClientRect().top - document.querySelector("#chat").getBoundingClientRect().top) < 30;
    }));

    // scroll-follow: up the page, new content does not move you; the pill appears
    for (let i = 0; i < 8; i++) await send("/tools");
    await page.evaluate(() => { const c = document.querySelector("#chat"); c.scrollTop = c.scrollHeight; });
    await send("/tools");
    check("follow: at the bottom, new content keeps you at the bottom",
      await page.evaluate(() => { const c = document.querySelector("#chat"); return c.scrollHeight - c.scrollTop - c.clientHeight < 2; }));
    await page.evaluate(() => { document.querySelector("#chat").scrollTop = 0; });
    await sleep(100);
    await send("/tools");
    const fol = await page.evaluate(() => ({ top: document.querySelector("#chat").scrollTop, pill: !document.querySelector("#latest").hidden }));
    check("follow: reading further up, new content doesn't move you", fol.top === 0);
    check("follow: a 'Latest ↓' pill appears", fol.pill);
    await page.click("#latest");
    await page.waitForFunction(() => { const c = document.querySelector("#chat"); return c.scrollHeight - c.scrollTop - c.clientHeight < 2; }, { timeout: 3000 }).catch(() => {});
    check("follow: the pill takes you to the bottom and goes away", await page.evaluate(() => {
      const c = document.querySelector("#chat");
      return c.scrollHeight - c.scrollTop - c.clientHeight < 2 && document.querySelector("#latest").hidden;
    }));

    // focus level, way out, one Esc owner
    await page.keyboard.down(MOD); await page.keyboard.down("Shift");
    await page.keyboard.press("KeyF");
    await page.keyboard.up("Shift"); await page.keyboard.up(MOD);
    const fo = await page.evaluate(() => ({
      on: document.body.classList.contains("focus-mode"),
      footer: getComputedStyle(document.querySelector("footer")).display, head: getComputedStyle(document.querySelector("#agent h2")).display,
      exit: !document.querySelector("#exit-focus").hidden, op: getComputedStyle(document.querySelector("#exit-focus")).opacity,
      chat: getComputedStyle(document.querySelector("#chat")).display !== "none", composer: getComputedStyle(document.querySelector("#composer")).display !== "none",
    }));
    check("focus: ⌘⇧F hides footer and header, keeps transcript + composer", fo.on && fo.footer === "none" && fo.head === "none" && fo.chat && fo.composer);
    check("focus: an exit button at 35% opacity", fo.exit && fo.op === "0.35");
    await page.hover("#exit-focus");
    await sleep(250);
    check("focus: exit button full opacity on hover", await page.$eval("#exit-focus", (b) => getComputedStyle(b).opacity === "1"));
    await page.focus("#input");
    await page.keyboard.type("@f");
    await page.waitForFunction(() => document.querySelector("#mention-menu").classList.contains("open"), { timeout: 2000 });
    await page.keyboard.press("Escape");
    check("esc: first Esc closes only the mention menu", await page.evaluate(() =>
      !document.querySelector("#mention-menu").classList.contains("open") && document.body.classList.contains("focus-mode")));
    await page.keyboard.press("Escape");
    check("esc: the next Esc leaves focus", await page.evaluate(() => !document.body.classList.contains("focus-mode") && document.querySelector("#exit-focus").hidden));
    await page.click("#focus-btn");
    check("focus: the header control enters it too", await page.evaluate(() => document.body.classList.contains("focus-mode")));
    await page.click("#exit-focus");
    check("focus: the corner button leaves it", await page.evaluate(() => !document.body.classList.contains("focus-mode")));
    await page.setViewport({ width: 1000, height: 640 });
    check("turns: hidden below 1100px", await page.$eval("#turns", (n) => getComputedStyle(n).display === "none"));
    await page.setViewport({ width: 1300, height: 640 });
    await page.click("#toggle-files"); // back to normal
    check("turns: hidden in a normal window", await page.$eval("#turns", (n) => getComputedStyle(n).display === "none"));
    await page.close();
  }

  // ---- round 6: home labels, hue, empty states, remove from Recent ----
  {
    const page = await browser.newPage();
    const now = Date.now();
    const posts = [];
    const base = { project: "p", source: "CLI", mtime: now - 3600_000, lastActivity: now - 3600_000, size: 1,
      cwdExists: true, temp: false, live: false, open: null, state: "closed", subagents: { total: 0, active: 0 } };
    let data = {
      recentFolders: [
        { path: "/x/alpha", name: "alpha", lastOpened: now - 60_000, exists: true, session: { id: "a1a1a1a1-1111-4111-8111-111111111111", title: "Alpha chat", state: "closed", open: null } },
        { path: "/x/beta", name: "beta", lastOpened: now - 120_000, exists: true, session: null },
      ],
      recentHidden: [{ path: "/x/gamma", name: "gamma", lastOpened: now - 999_000, exists: true, session: null }],
      sessions: [
        { ...base, id: "b1b1b1b1-1111-4111-8111-111111111111", cwd: "/x/alpha", title: "one" },
        { ...base, id: "b2b2b2b2-1111-4111-8111-111111111111", cwd: "/x/alpha", title: "two" },
        { ...base, id: "b3b3b3b3-1111-4111-8111-111111111111", cwd: "/x/beta", title: "three" },
      ],
    };
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const u = r.url();
      if (u.includes("/api/home")) return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
      if (u.includes("/api/recent/")) {
        posts.push([u.includes("/hide") ? "hide" : "unhide", JSON.parse(r.postData())]);
        return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      }
      r.continue();
    });
    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#home-recent li.row");
    const look = await page.evaluate(() => {
      const t = getComputedStyle(document.querySelector(".home-title"));
      const h3 = getComputedStyle(document.querySelector(".home-sec h3"));
      return {
        title: document.querySelector(".home-title").textContent, tSize: t.fontSize, tWeight: t.fontWeight, tLs: t.letterSpacing,
        h3Size: h3.fontSize, h3Weight: h3.fontWeight, h3Tt: h3.textTransform, h3Ls: h3.letterSpacing, h3Text: document.querySelector(".home-sec h3").textContent,
        sub: (document.querySelector(".home-sub") || {}).textContent || "",
      };
    });
    check("home: a real title, ~21px/600, tight tracking", look.title === "fethr" && look.tSize === "21px" && look.tWeight === "600" && look.tLs.startsWith("-0.2"));
    check("home: section labels sentence case 12px/600, no tracking", look.h3Text === "Recent" && look.h3Size === "12px" && look.h3Weight === "600" && look.h3Tt === "none" && look.h3Ls === "normal");
    check("home: one muted line on where sessions come from", /history on this computer/.test(look.sub) && /sends nothing/.test(look.sub));
    const hues = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#home-sessions li.row.hued")].map((r) => [r.dataset.id.slice(0, 2), r.style.getPropertyValue("--hue")])));
    check("hue: same folder, same hue; another folder, another", hues.b1 && hues.b1 === hues.b2 && hues.b1 !== hues.b3);
    check("hue: recent row for that folder matches", await page.$eval("#home-recent li.row", (r) => r.style.getPropertyValue("--hue")) === hues.b1);
    check("hue: drawn as a 3px stripe", await page.$eval("#home-recent li.row", (r) => getComputedStyle(r, "::before").width === "3px"));

    // Remove with an in-row confirm; Esc cancels only that
    await page.type("#home-search", "zzz");
    const rmClick = () => page.evaluate(() => [...document.querySelectorAll("#home-recent li.row")][0].querySelector(".rbtns button").click());
    await rmClick();
    check("remove: asks in the row", (await page.$eval("#home-recent li.row .rbtns", (b) => b.textContent)).includes("Remove from Recent?"));
    await page.keyboard.press("Escape");
    check("esc: cancels the confirm, not the search", await page.evaluate(() =>
      !document.querySelector("#home-recent .rbtns.confirming") && document.querySelector("#home-search").value === "zzz"));
    check("empty: no-match state explains the way out", await page.$eval("#home-sessions .empty", (e) => e.textContent.includes("No sessions match") && e.querySelector("kbd").textContent === "Esc"));
    await rmClick();
    await page.evaluate(() => [...document.querySelectorAll("#home-recent .rbtns button")].find((b) => b.textContent === "Remove").click());
    await sleep(300);
    check("remove: posts hide with path and session", posts[0] && posts[0][0] === "hide" && posts[0][1].path === "/x/alpha" && posts[0][1].session === "a1a1a1a1-1111-4111-8111-111111111111");
    const disc = await page.$eval(".home-disclose", (b) => ({ text: b.textContent, exp: b.getAttribute("aria-expanded") }));
    check("removed: a muted 'Show 1 removed' disclosure", disc.text === "Show 1 removed" && disc.exp === "false");
    await page.click(".home-disclose");
    check("removed: expands, listing what was removed", await page.evaluate(() =>
      document.querySelector(".home-disclose").getAttribute("aria-expanded") === "true" &&
      document.querySelector("#home-recent-hidden .rtitle").textContent === "gamma"));
    await page.click("#home-recent-hidden .rbtns button");
    await sleep(300);
    check("removed: Put back posts unhide", posts[1] && posts[1][0] === "unhide" && posts[1][1].path === "/x/gamma" && posts[1][1].session === null);

    // empty states with key hints
    data = { recentFolders: [], recentHidden: [], sessions: [] };
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#home-recent .empty");
    const empties = await page.evaluate(() => ({
      recent: document.querySelector("#home-recent .empty").textContent, rk: document.querySelector("#home-recent .empty kbd").textContent,
      sess: document.querySelector("#home-sessions .empty").textContent, sk: document.querySelector("#home-sessions .empty kbd").textContent,
      disc: document.querySelector(".home-hidden").hidden,
    }));
    check("empty: Recent explains itself with a ⌘O hint", empties.rk === "⌘O" && empties.recent.includes("listed here"));
    check("empty: Sessions explains itself with a claude hint", empties.sk === "claude" && empties.sess.includes("show up here"));
    check("removed: no disclosure when nothing is removed", empties.disc);
    await page.close();
  }

  // ---- images: paste and drop into the composer ----
  {
    const dir = path.join(tmp, "img");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.js"), "x = 1\n");
    const url = await new Promise((resolve) => serve(dir, resolve, { onOpen }));
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 700 });
    const bodies = [];
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (!r.url().includes("/api/agent")) return r.continue();
      bodies.push(JSON.parse(r.postData() || "{}"));
      const evs = [{ type: "session", id: FORKED }, { type: "delta", text: "Red." }, { type: "done", ok: true }];
      r.respond({ status: 200, contentType: "text/event-stream", body: evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") });
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('#tree [data-p="a.js"]');
    if (!(await page.evaluate(() => document.body.classList.contains("agent-open")))) await page.click("#toggle-agent");
    await page.waitForFunction(() => document.querySelector("#composer").offsetParent !== null, { timeout: 3000 });

    // A small PNG pasted, and a large JPEG dropped: built in the page with a canvas.
    await page.evaluate(async () => {
      const make = (w, h, type) => new Promise((res) => {
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const g = c.getContext("2d");
        g.fillStyle = "#d22"; g.fillRect(0, 0, w, h);
        c.toBlob((b) => res(new File([b], type === "image/png" ? "small.png" : "big.jpg", { type })), type, 0.9);
      });
      const small = await make(40, 30, "image/png");
      const big = await make(3200, 1800, "image/jpeg");
      const pdt = new DataTransfer();
      pdt.items.add(small);
      document.querySelector("#input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: pdt, bubbles: true, cancelable: true }));
      const ddt = new DataTransfer();
      ddt.items.add(big);
      document.querySelector("#composer").dispatchEvent(new DragEvent("drop", { dataTransfer: ddt, bubbles: true, cancelable: true }));
      const txt = new DataTransfer();
      txt.setData("text/plain", "hello");
      document.querySelector("#input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: txt, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll("#ctx-bar .ctx-pill.image").length === 2, { timeout: 5000 });
    check("images: a paste and a drop each add a thumbnail", true);

    // remove one, add it back by pasting again, then send with no text
    await page.click("#ctx-bar .ctx-pill.image:last-child button");
    check("images: × removes a thumbnail", await page.$$eval("#ctx-bar .ctx-pill.image", (p) => p.length === 1));
    await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 3200; c.height = 1800;
      c.getContext("2d").fillRect(0, 0, 3200, 1800);
      const b = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
      const dt = new DataTransfer();
      dt.items.add(new File([b], "big.jpg", { type: "image/jpeg" }));
      document.querySelector("#composer").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll("#ctx-bar .ctx-pill.image").length === 2, { timeout: 5000 });
    await page.focus("#input");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector("#agent-status").classList.contains("on"), { timeout: 3000 });

    const sent = bodies[0] || {};
    const imgs = sent.images || [];
    check("images: sent with the message, even with no text", imgs.length === 2 && typeof sent.prompt === "string" && sent.prompt.length > 0);
    check("images: base64 data plus a media type, nothing else", imgs.every((i) => Object.keys(i).sort().join() === "data,mediaType" && /^[A-Za-z0-9+/]+=*$/.test(i.data)));
    check("images: the PNG stays a PNG", imgs[0] && imgs[0].mediaType === "image/png");
    const dims = await page.evaluate(async (d) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${d}`;
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    }, imgs[1] ? imgs[1].data : "");
    check("images: a 3200px image is scaled to 1568px on its long edge", dims[0] === 1568 && dims[1] === 882);
    check("images: composer is empty again after sending", await page.$$eval("#ctx-bar .ctx-pill.image", (p) => p.length === 0));
    check("images: thumbnails shown in the sent message", await page.$$eval("#chat .msg.user .msg-images img", (i) => i.length === 2));
    check("images: plain text still pastes as text", true); // the text paste above added no thumbnail

    // the saved chat keeps a count, never the data
    await sleep(300);
    const saved = fs.readFileSync(path.join(dir, ".fethr", "chat.json"), "utf8");
    const entry = JSON.parse(saved).entries.find((e) => e.type === "user");
    check("images: saved chat records the count", entry && entry.images === 2);
    check("images: saved chat holds no image data", !saved.includes(imgs[0] ? imgs[0].data.slice(0, 40) : "@@") && saved.length < 4000);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#chat .msg.user");
    check("images: a restored chat shows [2 images]", await page.$eval("#chat .msg.user .msg-images-note", (n) => n.textContent === "[2 images]"));

    // wrong type is refused with a note
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }));
      document.querySelector("#composer").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await sleep(300);
    check("images: SVG is refused, with a reason", await page.$eval("#status", (s) => s.textContent.includes("isn't a PNG")) &&
      await page.$$eval("#ctx-bar .ctx-pill.image", (p) => p.length === 0));
    await page.close();
  }

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("home UI test crashed:", e);
  process.exit(1);
});
