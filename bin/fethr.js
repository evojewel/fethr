#!/usr/bin/env node

// fethr — a featherweight code editor with first-class agent integration.
// This is a name-reservation shell; the editor is under construction.

const banner = `
  fethr ${"0.0.1"}

  A featherweight code editor with first-class agent integration.
  Under construction — nothing to run yet.

  Watch: https://github.com/evojewel/fethr
`;

const arg = process.argv[2];

if (arg === "--version" || arg === "-v") {
  console.log("fethr 0.0.1");
} else {
  console.log(banner);
}
