#!/usr/bin/env node
// Edit-in-place PR summary comment for the OrcaRouter Code Review cascade.
//
//   node summary-comment.mjs <result.json> --tier cheap|strong --push <n>
//     --gate pass|blocked [--prev <file with the previous comment body>]
//     [--passes <n>] [--quiet]
//
// Prints the comment MARKDOWN to stdout. The driver (action.yml) UPSERTS it:
// it finds the existing PR comment via the marker line, updates it in place,
// else creates it — ONE summary comment per PR, edited on every push, so the
// timeline is never spammed.
//
// Structure (locked by summary-comment.test.mjs; the wording is deliberately
// stable — downstream tooling greps it):
//   line 1  <!-- orca-code-review-summary -->   upsert marker; keep in sync
//                                               with the action.yml step
//   line 2  <!-- orca-cr-state: {"p0":…,"p1":…,"p2":…,"push":…} -->
//           machine state: the NEXT run feeds this body back via --prev for
//           the Δ column, and reads .push to number itself
//   then    "## OrcaRouter Code Review — push N", the severity table (the
//           "Δ vs previous push" column appears only when --prev carries a
//           parseable state line), a tier-state line, and a gate line.
//
// Mode notes: `--passes <n>` (default 1) adds "exhaustive: N passes" after
// the tier line when N > 1 — the exhaustive loop made extra engine passes for
// this result; `--quiet` adds "quiet mode: P2 shown in summary only" — the
// driver muted inline P2 comments, so this table is where P2s live. Neither
// note touches the machine-state line.
//
// Severity counts use the shared severity.mjs (leading tag, untagged->P1
// fail-safe) — the same numbers the gate and the run report see. The gate
// line's blocking COUNT assumes the default block-on set (P0+P1); the
// pass/blocked verdict itself always comes from --gate, which the driver
// computes with the real configuration.

import fs from "node:fs";
import { SEVERITIES, countSeverities } from "./severity.mjs";

const MARKER = "<!-- orca-code-review-summary -->";
const STATE_RE = /<!-- orca-cr-state: (\{.*?\}) -->/;

const usage = () => {
  console.error(
    "usage: node summary-comment.mjs <result.json> --tier cheap|strong --push <n> " +
      "--gate pass|blocked [--prev <file>] [--passes <n>] [--quiet]",
  );
  process.exit(2);
};

const [file, ...rest] = process.argv.slice(2);
const opts = { passes: "1" };
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === "--tier") opts.tier = rest[++i];
  else if (rest[i] === "--push") opts.push = rest[++i];
  else if (rest[i] === "--gate") opts.gate = rest[++i];
  else if (rest[i] === "--prev") opts.prev = rest[++i];
  else if (rest[i] === "--passes") opts.passes = rest[++i];
  else if (rest[i] === "--quiet") opts.quiet = true;
}
const push = Number(opts.push);
const passes = Number(opts.passes);
if (
  !file ||
  !["cheap", "strong"].includes(opts.tier) ||
  !["pass", "blocked"].includes(opts.gate) ||
  !Number.isInteger(push) ||
  push < 1 ||
  !Number.isInteger(passes) ||
  passes < 1
) {
  usage();
}

// Counts render as zeros when the result is unreadable: this comment reports
// state; the gate step (not this script) owns failing the run.
let comments = [];
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(parsed.comments)) comments = parsed.comments;
} catch (e) {
  console.error(`summary-comment: could not read findings from ${file} (${e.message}) — rendering zero counts`);
}
const counts = countSeverities(comments);

// Previous push's state, for the Δ column. Absent/garbled state (first push,
// hand-edited comment) just omits the column — never an error.
let prev = null;
if (opts.prev) {
  try {
    const m = fs.readFileSync(opts.prev, "utf8").match(STATE_RE);
    const s = m ? JSON.parse(m[1]) : null;
    if (s && ["p0", "p1", "p2"].every((k) => Number.isFinite(s[k]))) prev = s;
  } catch {
    prev = null;
  }
}

const delta = (d) => (d > 0 ? `+${d}` : String(d));
const state = { p0: counts.P0, p1: counts.P1, p2: counts.P2, push };

const lines = [MARKER, `<!-- orca-cr-state: ${JSON.stringify(state)} -->`, ""];
lines.push(`## OrcaRouter Code Review — push ${push}`, "");
if (prev) {
  lines.push("| Severity | Count | Δ vs previous push |", "|---|---|---|");
  for (const s of SEVERITIES) {
    lines.push(`| ${s} | ${counts[s]} | ${delta(counts[s] - prev[s.toLowerCase()])} |`);
  }
} else {
  lines.push("| Severity | Count |", "|---|---|");
  for (const s of SEVERITIES) lines.push(`| ${s} | ${counts[s]} |`);
}
lines.push("");

if (opts.tier === "strong") {
  lines.push(`Tier: STRONG (final pass) — ${opts.gate === "blocked" ? "blocked" : "pass"}`);
} else if (opts.gate === "blocked") {
  lines.push("Tier: CHEAP — held (fix P0/P1 first; the strong review runs once they're cleared)");
} else {
  lines.push("Tier: escalating to STRONG this run");
}
// Mode notes ride in the same status block as the tier line.
if (passes > 1) lines.push(`exhaustive: ${passes} passes`);
if (opts.quiet) lines.push("quiet mode: P2 shown in summary only");
lines.push("");

const blocking = counts.P0 + counts.P1;
lines.push(
  opts.gate === "blocked"
    ? `❌ ${blocking} finding${blocking === 1 ? "" : "s"} block${blocking === 1 ? "s" : ""} merge`
    : "✅ no blocking findings",
);

process.stdout.write(`${lines.join("\n")}\n`);
