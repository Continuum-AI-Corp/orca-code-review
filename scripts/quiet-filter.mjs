#!/usr/bin/env node
// Quiet-mode severity filter for the Orca-Code-Review cascade.
//
//   node quiet-filter.mjs <result.json> --drop P2 --out <filtered.json>
//
// Reads an `ocr review --format json` result, drops every comment whose
// severity (shared severity.mjs: leading [P0]/[P1]/[P2] tag, untagged->P1
// fail-safe — so an untagged finding is NEVER silently muted) is in the
// --drop set, and writes the result — same shape, same key order, same
// comment objects, original comment order — to --out. Prints
// {"kept":n,"dropped":m} to stdout.
//
// This exists so quiet mode ("quiet": true in the dashboard settings) can
// mute advisory P2 comments at the POSTING step only: the driver (action.yml)
// feeds the FILTERED file to "Post review comments" while the severity gate,
// the summary comment's counts, and the control-plane run report keep reading
// the UNfiltered result — quiet changes what lands on the PR timeline, never
// what is enforced or measured.
//
// Failure behavior: a missing/unparseable input writes an empty engine-shaped
// result ({"comments":[]}) and exits 0 — exactly what the posting step's own
// try/catch would do with the raw file, so quiet mode adds no new failure
// mode. Bad USAGE (missing flags, an unknown severity in --drop) exits 2:
// that is a wiring bug in action.yml and must be loud, not quietly ignored.

import fs from "node:fs";
import { SEVERITIES, severityOf } from "./severity.mjs";

const usage = () => {
  console.error("usage: node quiet-filter.mjs <result.json> --drop P2[,P1] --out <filtered.json>");
  process.exit(2);
};

const [file, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === "--drop") opts.drop = rest[++i];
  else if (rest[i] === "--out") opts.out = rest[++i];
}
if (!file || !opts.drop || !opts.out) usage();

const drop = new Set(
  opts.drop
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);
if (drop.size === 0 || [...drop].some((t) => !SEVERITIES.includes(t))) usage();

let parsed = { comments: [] };
try {
  parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed.comments)) parsed = { ...parsed, comments: [] };
} catch (e) {
  console.error(`quiet-filter: could not read findings from ${file} (${e.message}) — writing an empty result`);
  parsed = { comments: [] };
}

const kept = parsed.comments.filter((c) => !drop.has(severityOf(c)));
const dropped = parsed.comments.length - kept.length;

fs.writeFileSync(opts.out, JSON.stringify({ ...parsed, comments: kept }));
console.error(`quiet-filter: dropped ${dropped} ${[...drop].join("/")} comment(s), kept ${kept.length}`);
process.stdout.write(`${JSON.stringify({ kept: kept.length, dropped })}\n`);
