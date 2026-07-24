#!/usr/bin/env node
// Layer-1 deterministic post-filter prototype for OCR review output.
//
//   node postfilter.mjs <result.json> <repo> <commit> [--out <filtered.json>]
//
// Uses each finding's `existing_code` (the exact source the model quoted) as a
// ground-truth locator: git-grep it in the reviewed commit's tree.
//   - snippet found IN the claimed path            -> keep (correctly filed)
//   - snippet found in exactly ONE other file      -> RE-HOME path to that file
//   - snippet found nowhere & path is a non-code    -> DROP (misfiled code onto
//     a locale/generated/etc. file)
//   - otherwise                                     -> keep (unverified/ambiguous)
// Then dedupe by normalized content (same root cause reported on many files).
// Prints an action report to stderr and the cleaned JSON to --out.

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const [file, repo, commit, ...rest] = process.argv.slice(2);
let out = null;
for (let i = 0; i < rest.length; i += 1) if (rest[i] === "--out") out = rest[++i];
if (!file || !repo || !commit) {
  console.error("usage: node postfilter.mjs <result.json> <repo> <commit> [--out f]");
  process.exit(2);
}

// Only drop findings whose snippet did NOT match anywhere in the tree when
// the claimed path is a KNOWN non-code file (locale JSON / doc markdown /
// changelogs / lockfiles). Extensionless code files (Dockerfile, Makefile,
// scripts with no extension) previously fell through the "not code-ext"
// branch and got dropped as if they were locale files — reverse the polarity
// so only clearly-non-code paths incur the drop.
const KNOWN_NON_CODE = /\.(json|ya?ml|md|txt|lock|log|csv|tsv|po|pot|properties)$/i;

// Returns an array of { file, line } — each match of `pattern` at the given
// commit, with the line NUMBER as reported by git-grep -n so a rehome can
// point at the actual snippet's line rather than reusing the reviewer's
// (now-wrong) original line.
function grepFiles(pattern) {
  if (!pattern || pattern.length < 12) return [];
  try {
    const o = execFileSync("git", ["-C", repo, "grep", "-F", "-I", "-n", "-e", pattern, commit], {
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    // Output shape: "<commit>:<file>:<line>:<text>". Strip the commit prefix
    // once (present because we asked for a specific commit), then parse.
    const seen = new Map(); // file -> first line seen (dedup multi-hit files)
    for (const raw of o.split("\n")) {
      if (!raw) continue;
      const afterCommit = raw.slice(raw.indexOf(":") + 1); // "<file>:<line>:<text>"
      const firstColon = afterCommit.indexOf(":");
      if (firstColon < 0) continue;
      const file = afterCommit.slice(0, firstColon);
      const rest = afterCommit.slice(firstColon + 1);
      const secondColon = rest.indexOf(":");
      const line = secondColon >= 0 ? Number(rest.slice(0, secondColon)) : null;
      if (!seen.has(file)) seen.set(file, Number.isFinite(line) ? line : null);
    }
    return [...seen.entries()].map(([file, line]) => ({ file, line }));
  } catch {
    return []; // grep exit 1 = no match
  }
}

function candidateLines(code) {
  return (code || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length >= 12)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
}

const data = JSON.parse(fs.readFileSync(file, "utf8"));
const comments = Array.isArray(data.comments) ? data.comments : [];
const report = [];
const kept = [];

for (const c of comments) {
  let hits = []; // [{file, line}]
  for (const ln of candidateLines(c.existing_code)) {
    const f = grepFiles(ln);
    if (f.length) { hits = f; break; }
  }
  let path = c.path;
  let start_line = c.start_line;
  let end_line = c.end_line;
  let action = "keep";
  const files = hits.map((h) => h.file);
  if (hits.length) {
    if (files.includes(c.path)) action = "keep (correct)";
    else if (hits.length === 1) {
      // REHOME: the finding is really about `hits[0].file`, not the claimed
      // path — update BOTH path and lines so the posted comment lands on
      // the actual snippet, not the reviewer's original (unrelated) line.
      const hit = hits[0];
      path = hit.file;
      if (Number.isFinite(hit.line)) { start_line = hit.line; end_line = hit.line; }
      action = `REHOME ${c.path} -> ${path}${Number.isFinite(hit.line) ? ":" + hit.line : ""}`;
    }
    else action = `keep (ambiguous: ${hits.length} files)`;
  } else if (KNOWN_NON_CODE.test(c.path)) {
    action = "DROP (code snippet, filed on known-non-code file, not found)";
  } else {
    action = "keep (snippet unverified)";
  }
  report.push({ sev: (c.content || "").match(/\[(P[0-3])\]/)?.[1] || "?", from: c.path, action });
  if (action.startsWith("DROP")) continue;
  kept.push({ ...c, path, start_line, end_line });
}

const norm = (s) =>
  (s || "").replace(/^\s*\[P[0-3]\]\s*/, "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
const seen = new Map();
const deduped = [];
for (const c of kept) {
  const k = norm(c.content);
  if (seen.has(k)) { report.push({ sev: "-", from: c.path, action: `DROP (dup of ${seen.get(k)})` }); continue; }
  seen.set(k, c.path);
  deduped.push(c);
}

if (out) fs.writeFileSync(out, JSON.stringify({ ...data, comments: deduped }, null, 1));
console.error(`in=${comments.length}  out=${deduped.length}`);
for (const r of report) if (!r.action.startsWith("keep (correct)") && r.action !== "keep")
  console.error(`  [${r.sev}] ${r.action}`);
