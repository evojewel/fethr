#!/usr/bin/env node

// fethr — a featherweight code editor with first-class agent integration.
// This is a name-reservation shell; the editor is under construction.

import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json");

const banner = `
  fethr ${version}

  A featherweight code editor with first-class agent integration.
  Under construction — nothing to run yet.

  Watch: https://fethr.dev · https://github.com/evojewel/fethr
`;

const arg = process.argv[2];

if (arg === "--version" || arg === "-v") {
  console.log(`fethr ${version}`);
} else {
  console.log(banner);
}
