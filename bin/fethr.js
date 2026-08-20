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
  const { serve } = await import("../src/server.js");
  serve(arg || process.cwd());
}
