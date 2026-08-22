// Real-browser regression test for the agent panel — catches exactly the
// class of bug that shipped in v0.5.0: a disabled/inert input silently
// swallows keystrokes. `bats` and unit tests never exercise the DOM, so
// this drives an actual Chromium with puppeteer-core.
//
// Usage: node test-ui/agent-panel.js [chrome-executable-path]
// Needs `npm install -D puppeteer-core` and a Chrome/Chromium binary —
// not run in CI by default (no Chrome on the bats/shellcheck runner);
// run locally before releases that touch web/editor.js or web/index.html.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

function findChrome() {
  if (process.argv[2]) return process.argv[2];
  const bases = [
    path.join(os.homedir(), ".cache/puppeteer/chrome"),
    path.join(os.homedir(), "Library/Caches/puppeteer/chrome"),
  ];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    const versions = fs.readdirSync(base).sort().reverse();
    for (const v of versions) {
      const candidate = path.join(
        base, v, "chrome-mac-arm64", "Google Chrome for Testing.app",
        "Contents/MacOS/Google Chrome for Testing"
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(mac)) return mac;
  throw new Error("No Chrome found — pass a path: node test-ui/agent-panel.js <chrome-path>");
}

async function main() {
  const puppeteer = require("puppeteer-core");
  const { serve } = require("../src/server.js");

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "fethr-ui-test-"));
  fs.writeFileSync(path.join(fixture, "app.js"), "console.log('hi')\n");
  fs.mkdirSync(path.join(fixture, "lib"));
  fs.writeFileSync(path.join(fixture, "lib", "util.js"), "export const x = 1;\n");

  const url = await new Promise((resolve) => serve(fixture, resolve));
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let failures = 0;
  const check = (label, cond) => {
    console.log(`${cond ? "ok " : "FAIL"} — ${label}`);
    if (!cond) failures++;
  };

  // ---- CLI mode: real typing, real Enter, real render ----
  {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
    await page.waitForSelector("#toggle-agent", { timeout: 5000 });
    await page.click("#toggle-agent");
    await page.waitForSelector("#input:not([disabled])", { timeout: 2000 });
    await page.type("#input", "hello");
    check("CLI mode: input accepts keystrokes", (await page.$eval("#input", (el) => el.value)) === "hello");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("#chat .msg.user").length > 0, { timeout: 5000 });
    check(
      "CLI mode: submitted text renders as a user bubble",
      (await page.$eval("#chat .msg.user", (el) => el.textContent)).includes("hello")
    );

    // Model picker offers fable, auto checkbox exists and persists
    const modelOptions = await page.$$eval("#model option", (opts) => opts.map((o) => o.value));
    check("model picker includes fable", modelOptions.includes("fable"));
    check("auto-apply checkbox exists", (await page.$("#auto")) !== null);
    await page.click("#auto");
    const autoChecked = await page.$eval("#auto", (el) => el.checked);
    check("auto checkbox toggles on click", autoChecked === true);
    const persisted = await page.evaluate(() => localStorage.getItem("fethr.autoApply"));
    check("auto-apply state persists to localStorage", persisted === "1");

    // Collapsible sidebar: toggle, verify CSS var actually shrinks, and ⌘B works
    const widthBefore = await page.$eval("aside", (el) => el.getBoundingClientRect().width);
    await page.click("#toggle-sidebar");
    const widthAfterClick = await page.$eval("aside", (el) => el.getBoundingClientRect().width);
    check("sidebar collapses via button (width shrinks)", widthAfterClick < widthBefore - 100);
    await page.keyboard.down("Meta");
    await page.keyboard.press("KeyB");
    await page.keyboard.up("Meta");
    const widthAfterCmdB = await page.$eval("aside", (el) => el.getBoundingClientRect().width);
    check("⌘B re-expands the sidebar", widthAfterCmdB > widthAfterClick + 100);
    const sidebarPersisted = await page.evaluate(() => localStorage.getItem("fethr.sidebarCollapsed"));
    check("sidebar collapse state persists to localStorage", sidebarPersisted === "0");

    // Folder accordion: a directory row toggles its own children only
    const dirVisible = await page.$eval(
      "#tree .file-row[data-p='lib/util.js']",
      (el) => el.getBoundingClientRect().height > 0
    );
    check("tree: nested file starts visible (expanded by default)", dirVisible);
    await page.click("#tree .dir-row");
    const hiddenAfterCollapse = await page.$eval(
      "#tree .file-row[data-p='lib/util.js']",
      (el) => el.getBoundingClientRect().height === 0
    );
    check("tree: clicking a folder collapses its children", hiddenAfterCollapse);
    const topFileStillVisible = await page.$eval(
      "#tree .file-row[data-p='app.js']",
      (el) => el.getBoundingClientRect().height > 0
    );
    check("tree: collapsing one folder doesn't affect sibling files", topFileStillVisible);
    await page.click("#tree .dir-row");
    const visibleAfterReexpand = await page.$eval(
      "#tree .file-row[data-p='lib/util.js']",
      (el) => el.getBoundingClientRect().height > 0
    );
    check("tree: clicking again re-expands", visibleAfterReexpand);

    // Auto-save: on by default, and typing eventually persists without ⌘S
    check("auto-save checkbox is checked by default", await page.$eval("#autosave", (el) => el.checked));
    await page.click("#tree .file-row[data-p='app.js']");
    await page.waitForFunction(() => document.querySelector("#file").textContent.includes("app.js"));
    await page.click(".cm-content");
    await page.keyboard.type("\n// edited");
    await page.waitForFunction(() => document.querySelector("#status").textContent === "saved", { timeout: 3000 });
    check("auto-save: edit persists to disk without ⌘S", true);
    const onDisk = fs.readFileSync(path.join(fixture, "app.js"), "utf8");
    check("auto-save: file content on disk actually changed", onDisk.includes("// edited"));

    await page.close();
  }

  // ---- Context bar, @-mention attach, mic feature-detect, clickable file:line refs ----
  {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.click("#toggle-agent");

    await page.click("#tree .file-row[data-p='app.js']");
    await page.waitForFunction(() => document.querySelector("#file").textContent.includes("app.js"));
    check("ctx bar shows the current file", (await page.$eval("#ctx-bar", (el) => el.textContent)).includes("app.js"));

    await page.evaluate(() => {
      const v = window.__fethrView;
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.line(1).to } });
    });
    check(
      "ctx bar reflects the live selection",
      /app\.js:1/.test(await page.$eval("#ctx-bar", (el) => el.textContent))
    );

    await page.focus("#input");
    await page.type("#input", "check @util");
    await page.waitForFunction(() => document.querySelector("#mention-menu").classList.contains("open"));
    check(
      "@ shows a filtered mention menu",
      (await page.$eval("#mention-menu", (el) => el.textContent)).includes("lib/util.js")
    );
    await page.keyboard.press("Enter");
    check("picking a mention clears the @query text", (await page.$eval("#input", (el) => el.value)) === "check ");
    check(
      "picked mention becomes a removable context pill",
      (await page.$eval("#ctx-bar", (el) => el.textContent)).includes("lib/util.js")
    );

    check("mic button is present and enabled (SpeechRecognition in Chromium)", (await page.$eval("#mic", (el) => el.disabled)) === false);

    await fetch(url + "api/chat", {
      method: "PUT",
      body: JSON.stringify({ session: null, entries: [{ type: "assistant", text: "see lib/util.js:1 for the export" }] }),
    }).catch(() => {});
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.click("#toggle-agent");
    await page.waitForSelector("a.fileref", { timeout: 3000 });
    check("file:line in a reply renders as a clickable link", (await page.$eval("a.fileref", (el) => el.textContent)) === "lib/util.js:1");
    await page.click("a.fileref");
    await page.waitForFunction(() => document.querySelector("#file").textContent.includes("util.js"), { timeout: 3000 });
    check("clicking a file:line ref opens and jumps to it", true);

    await page.close();
  }

  // ---- Chat history persists across a reload (survives the random-port
  // restart scenario since it reads back through the same running server) ----
  {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.click("#toggle-agent");
    await page.type("#input", "remember this");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("#chat .msg.user").length > 0, { timeout: 5000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.click("#toggle-agent");
    await page.waitForFunction(
      () => [...document.querySelectorAll("#chat .msg.user")].some((e) => e.textContent.includes("remember this")),
      { timeout: 5000 }
    );
    check("chat history: prior prompt restored after reload", true);
    await page.close();
  }

  // ---- Resizable panels: drag the divider between sidebar/editor/agent ----
  {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const width = async (sel) => page.$eval(sel, (el) => el.getBoundingClientRect().width);
    const drag = async (handleSel, dx) => {
      const box = await (await page.$(handleSel)).boundingBox();
      await page.mouse.move(box.x + 2, box.y + 20);
      await page.mouse.down();
      await page.mouse.move(box.x + 2 + dx, box.y + 20, { steps: 5 });
      await page.mouse.up();
    };

    const w0 = await width("aside");
    await drag("#resize-sidebar", 100);
    const w1 = await width("aside");
    check("dragging the sidebar resizer grows it", w1 > w0 + 50);

    await page.reload({ waitUntil: "domcontentloaded" });
    const w2 = await width("aside");
    check("sidebar width persists across reload", Math.abs(w2 - w1) < 5);

    await page.click("#toggle-sidebar");
    check("sidebar collapses to a narrow rail", (await width("aside")) < 50);
    await drag("#resize-sidebar", 60);
    const wAfter = await width("aside");
    check("dragging from collapsed un-collapses without a size jump", wAfter > 150 && wAfter < 400);

    check("agent panel takes zero grid width while closed", (await width("#agent")) === 0);
    await page.click("#toggle-agent");
    const agentOpenW = await width("#agent");
    check("agent panel opens to a real width", agentOpenW > 200);
    await drag("#resize-agent", -80); // agent is on the right — drag left to widen
    const agentAfterDrag = await width("#agent");
    check("dragging the agent resizer changes its width", Math.abs(agentAfterDrag - agentOpenW) > 40);
    await page.click("#toggle-agent");
    check("agent panel returns to zero width when closed", (await width("#agent")) === 0);
    await page.click("#toggle-agent");
    check(
      "reopening restores the dragged width, not a stale default",
      Math.abs((await width("#agent")) - agentAfterDrag) < 5
    );

    await page.close();
  }

  // ---- Git branch: shown when real, never guessed when absent ----
  // Regression coverage for a real bug: the agent once answered a branch
  // question with zero tool calls (see src/server.js's getGitBranch comment)
  // — fethr now checks the real branch itself rather than trusting a guess.
  {
    const { execSync } = require("node:child_process");
    const gitFixture = fs.mkdtempSync(path.join(os.tmpdir(), "fethr-git-test-"));
    execSync("git init -q -b test-branch-xyz", { cwd: gitFixture });
    execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init', { cwd: gitFixture });
    fs.writeFileSync(path.join(gitFixture, "app.js"), "1\n");

    const gitUrl = await new Promise((resolve) => serve(gitFixture, resolve));
    const page = await browser.newPage();
    await page.goto(gitUrl, { waitUntil: "domcontentloaded" });
    check("real branch name shown in the sidebar header", (await page.$eval("#branch", (el) => el.textContent)) === "test-branch-xyz");

    const meta = await (await fetch(gitUrl + "api/meta")).json();
    check("/api/meta reports the real branch", meta.gitBranch === "test-branch-xyz");

    const nonGitUrl = await new Promise((resolve) => serve(fixture, resolve));
    const metaNonGit = await (await fetch(nonGitUrl + "api/meta")).json();
    check("non-git workspace reports null, not an error", metaNonGit.gitBranch === null);

    await page.close();
  }

  await browser.close();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("agent-panel UI test crashed:", e);
  process.exit(1);
});
