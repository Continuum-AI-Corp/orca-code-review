#!/usr/bin/env node
// Severity gate for the OrcaRouter Code Review cascade.
//
// Reads an `ocr review --format json` result file, extracts the [P0]/[P1]/[P2]
// tag the model prefixes onto each comment, and answers one yes/no question:
// "does any finding carry a severity in the given set?"
//
//   node gate.mjs <result.json> --has P0,P1
//     exit 0 -> at least one finding matches (escalate / block)
//     exit 1 -> none match (converged / pass)
//
// The model is instructed to tag every comment; if one is still untagged we
// default it to P1 (fail-safe) so a missing tag escalates for a second look
// rather than being silently treated as advisory. A summary line is printed to
// stderr for the CI log.

import fs from "node:fs";
import { SEVERITIES, severityOf } from "./severity.mjs";

const [file, flag, listRaw] = process.argv.slice(2);

if (!file || flag !== "--has") {
  console.error("usage: node gate.mjs <result.json> --has P0,P1");
  process.exit(2);
}

const wanted = new Set(
  (listRaw || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);

let comments = [];
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  comments = Array.isArray(parsed.comments) ? parsed.comments : [];
} catch (e) {
  // No parseable output (engine error / empty) — nothing to gate on.
  console.error(`gate: could not read findings from ${file} (${e.message})`);
  process.exit(1);
}

// Severity comes from the shared severity.mjs (leading-tag-only parsing plus
// the untagged->P1 fail-safe) so the gate, the control-plane run report
// (report.mjs), and the PR summary comment can never drift apart.

const counts = {};
let matched = false;
for (const c of comments) {
  const sev = severityOf(c);
  counts[sev] = (counts[sev] || 0) + 1;
  if (wanted.has(sev)) matched = true;
}

const breakdown =
  SEVERITIES
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(", ") || "none";

console.error(
  `gate: ${comments.length} finding(s) [${breakdown}] · match(${[...wanted].join(",") || "-"}) = ${matched}`,
);

process.exit(matched ? 0 : 1);
