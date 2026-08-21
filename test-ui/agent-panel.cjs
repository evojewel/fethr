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
