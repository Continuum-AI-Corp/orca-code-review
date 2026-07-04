#!/usr/bin/env node
// Oversized-diff guard for the OrcaRouter Code Review cascade.
//
// Reviewing a huge diff is noise: the model truncates context, files get
// skipped, and the severity signal collapses — better to skip loudly and let
// the team split the PR (or raise the limits). This script only DECIDES; the
// driver (action.yml) generates the merge-base diff before the engine runs,
// and on "skip" posts a notice and passes the check WITHOUT starting a review.
//
//   node diff-guard.mjs --diff <unified-diff-file> [--max-kb <n>] [--max-files <m>]
//
// Prints one JSON object to stdout and ALWAYS exits 0 — the decision is data,
// not an error:
//   {"decision":"review"|"skip","reason":"…","size_kb":<n>,"files":<n>}
//
// Defaults: 512 KB / 300 files (surfaced as the action's `max-diff-kb` /
// `max-diff-files` inputs). `files` counts `diff --git` file headers — in a
// unified diff every content line is prefixed (' ', '+', '-'), so a header at
// column 0 is unambiguous. A diff exactly AT a limit is still reviewed; only
// strictly-over skips. Fail-open: a missing/unreadable/empty diff (or a bad
// flag) yields "review" with the reason — a guard glitch must never silently
// disable the review.

import fs from "node:fs";

function positive(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const argv = process.argv.slice(2);
let diffPath = "";
let maxKbRaw;
let maxFilesRaw;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--diff") diffPath = argv[++i] ?? "";
  else if (argv[i] === "--max-kb") maxKbRaw = argv[++i];
  else if (argv[i] === "--max-files") maxFilesRaw = argv[++i];
}
const maxKb = positive(maxKbRaw, 512);
const maxFiles = positive(maxFilesRaw, 300);

function decide() {
  if (!diffPath) {
    return {
      decision: "review",
      reason: "no --diff path given — failing open to review",
      size_kb: 0,
      files: 0,
    };
  }
  let buf;
  try {
    buf = fs.readFileSync(diffPath);
  } catch (e) {
    return {
      decision: "review",
      reason: `could not read diff (${e.message}) — failing open to review`,
      size_kb: 0,
      files: 0,
    };
  }
  if (buf.length === 0) {
    return {
      decision: "review",
      reason: "empty diff — failing open to review",
      size_kb: 0,
      files: 0,
    };
  }
  const sizeKb = Math.round((buf.length / 1024) * 10) / 10;
  const files = buf
    .toString("utf8")
    .split("\n")
    .filter((line) => line.startsWith("diff --git ")).length;
  // Compare raw bytes, not the rounded display value, so "at the limit" is exact.
  if (buf.length > maxKb * 1024) {
    return {
      decision: "skip",
      reason: `diff is ${sizeKb} KB, over the ${maxKb} KB limit`,
      size_kb: sizeKb,
      files,
    };
  }
  if (files > maxFiles) {
    return {
      decision: "skip",
      reason: `diff touches ${files} files, over the ${maxFiles}-file limit`,
      size_kb: sizeKb,
      files,
    };
  }
  return {
    decision: "review",
    reason: `within limits (${sizeKb} KB, ${files} files)`,
    size_kb: sizeKb,
    files,
  };
}

process.stdout.write(`${JSON.stringify(decide())}\n`);
process.exit(0);
