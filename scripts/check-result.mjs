#!/usr/bin/env node
// Availability check for the OrcaRouter Code Review cascade.
//
//   node check-result.mjs <result.json> <exit-code>
//     exit 0 -> the engine produced a complete, usable review
//     exit 1 -> review unavailable or partial; the caller must FAIL CLOSED
//
// A nonzero engine exit, unparseable output, a missing `comments` array, or any
// non-empty `warnings` (a partial review where some files failed/were skipped)
// all mean we do NOT have a trustworthy result. Converting those into a clean
// "no issues found" pass would let a bad key, gateway outage, or CLI crash
// silently clear a PR — so we surface them as an unavailable review instead.

import fs from "node:fs";

const [file, rcRaw] = process.argv.slice(2);
const rc = Number(rcRaw || "0");

if (rc !== 0) {
  console.error(`review unavailable: engine exited ${rc}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
  console.error(`review unavailable: no parseable result in ${file} (${e.message})`);
  process.exit(1);
}

if (!Array.isArray(parsed.comments)) {
  console.error("review unavailable: result has no `comments` array");
  process.exit(1);
}

const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
if (warnings.length > 0) {
  console.error(`review partial: ${warnings.length} warning(s) — ${warnings.join("; ")}`);
  process.exit(1);
}

console.error(`review available: ${parsed.comments.length} finding(s)`);
process.exit(0);
