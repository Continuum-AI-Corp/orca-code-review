#!/usr/bin/env node
// Exhaustive-mode merge for the Orca-Code-Review cascade.
//
//   node exhaustive-merge.mjs --base <a.json> --new <b.json> --out <merged.json>
//
// Exhaustive mode ("exhaustive": true in the dashboard settings) re-runs the
// review engine up to 2 extra times per tier: LLM reviews are not exhaustive
// in one pass, so another pass over the same diff surfaces findings the first
// one missed. The loop driver lives in action.yml; this script is the
// deterministic half — merge a fresh pass into the accumulated result:
//
//   - Comments dedupe by (file, effective line, normalized content). The
//     effective line matches the posting rule (end_line >= 1, else
//     start_line, else 0). Content is normalized before comparison:
//     the LEADING severity tag is stripped (a re-run may re-tag the same
//     issue), lowercased, and whitespace collapsed — so "[P2] Null   deref"
//     and "[p1] null deref" on one line are the SAME finding, while a
//     different file/line is genuinely new.
//   - Base order is preserved (its comment objects pass through untouched,
//     tags included), new findings append in their own order, and the base's
//     sibling top-level keys win — the merged file stays engine-shaped, so
//     the existing gate/summary/report pipeline reads it unchanged.
//
// Prints exactly {"new_findings":N} to stdout and exits 0; the driver loops
// only while N > 0 and iterations remain. Fail-open: an unreadable --new
// keeps the base and reports 0 (the loop stops, findings so far survive); an
// unreadable --base adopts the new result. Bad USAGE exits 2 — that is a
// wiring bug in action.yml and must be loud.

import fs from "node:fs";

const usage = () => {
  console.error("usage: node exhaustive-merge.mjs --base <a.json> --new <b.json> --out <merged.json>");
  process.exit(2);
};

const argv = process.argv.slice(2);
const opts = {};
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--base") opts.base = argv[++i];
  else if (argv[i] === "--new") opts.new = argv[++i];
  else if (argv[i] === "--out") opts.out = argv[++i];
}
if (!opts.base || !opts.new || !opts.out) usage();

function readResult(file, label) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed.comments)) return { ...parsed, comments: [] };
    return parsed;
  } catch (e) {
    console.error(`exhaustive-merge: could not read ${label} result ${file} (${e.message}) — treating as empty`);
    return null;
  }
}

// Dedup key: file + effective line + normalized content. Mirrors the posting
// step's line rule and severity.mjs's leading-tag rule so "one finding" means
// the same thing everywhere.
function keyOf(c) {
  const line = c?.end_line >= 1 ? c.end_line : c?.start_line >= 1 ? c.start_line : 0;
  const normalized = String(c?.content || "")
    .replace(/^\s*\[P[012]\]\s*/i, "") // a re-run may re-tag the same issue
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return `${c?.path || ""}\u0000${line}\u0000${normalized}`;
}

const base = readResult(opts.base, "base");
const fresh = readResult(opts.new, "new");

let merged;
let newFindings = 0;
if (!base && !fresh) {
  merged = { comments: [] };
} else if (!base) {
  merged = fresh; // no base to preserve — everything in the fresh pass is new
  newFindings = fresh.comments.length;
} else if (!fresh) {
  merged = base; // fresh pass unusable — keep what we have, stop the loop
} else {
  const seen = new Set(base.comments.map(keyOf));
  const appended = [];
  for (const c of fresh.comments) {
    const key = keyOf(c);
    if (seen.has(key)) continue;
    seen.add(key); // dupes INSIDE the fresh pass collapse too
    appended.push(c);
  }
  newFindings = appended.length;
  merged = { ...base, comments: [...base.comments, ...appended] };
}

fs.writeFileSync(opts.out, JSON.stringify(merged));
console.error(
  `exhaustive-merge: ${newFindings} new finding(s); merged total ${merged.comments.length}`,
);
process.stdout.write(`${JSON.stringify({ new_findings: newFindings })}\n`);
