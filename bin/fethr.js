#!/usr/bin/env node

// fethr — a featherweight code editor with first-class agent integration.
// This is a name-reservation shell; the editor is under construction.

import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json");

const arg = process.argv[2];

if (arg === "--version" || arg === "-v") {
  console.log(`fethr ${version}`);
} else if (arg === "--help" || arg === "-h") {
  console.log(`
  fethr ${version} — a featherweight code editor

  USAGE
    fethr [dir]     open dir (default: current directory) in the editor
    fethr --version

  https://fethr.dev · https://github.com/evojewel/fethr
`);
} else {
  const args = process.argv.slice(2);
  const app = args.includes("--app");
  const sidecar = args.includes("--sidecar");
  const dir = args.find((a) => !a.startsWith("--"));
  const { serve } = await import("../src/server.js");
  if (sidecar) {
    // Spawned by the native app shell (src-tauri) as a child process. No
    // banner, no browser-opening — just start the server and print a single
    // machine-parseable line so the Rust side can read the bound port.
    serve(dir || process.cwd(), (url) => console.log(`FETHR_URL=${url}`));
  } else {
    serve(dir || process.cwd(), undefined, { app });
  }
}
