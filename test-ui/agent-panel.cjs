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

    await page.close();
  }

  // ---- App-shell mode (window.__TAURI__ present): input must stay usable ----
  {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      window.__TAURI__ = { core: { invoke: async () => ({}) } };
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
    await page.waitForSelector("#toggle-agent", { timeout: 5000 });
    await page.click("#toggle-agent");
    check("app mode: input is NOT disabled", (await page.$eval("#input", (el) => el.disabled)) === false);
    await page.type("#input", "test");
    check("app mode: input accepts keystrokes", (await page.$eval("#input", (el) => el.value)) === "test");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("#chat code").length > 0, { timeout: 3000 });
    check("app mode: Enter shows an actionable CLI-mode notice (not silence)", true);
    await page.close();
  }

  await browser.close();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("agent-panel UI test crashed:", e);
  process.exit(1);
});
