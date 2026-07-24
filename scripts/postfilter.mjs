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

// Returns a de-duped list of files containing `pattern` at the reviewed
// commit. Uses `-l` (file-list only) so we sidestep the colon-in-filename
// ambiguity of `-n`'s "<commit>:<file>:<line>:<text>" format — with `-l`
// the output is just "<commit>:<file>" and stripping the commit prefix is
// unambiguous.
function grepFiles(pattern) {
  if (!pattern || pattern.length < 12) return [];
  try {
    const o = execFileSync("git", ["-C", repo, "grep", "-F", "-I", "-l", "-e", pattern, commit], {
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    return [...new Set(o.split("\n").filter(Boolean).map((l) => l.slice(l.indexOf(":") + 1)))];
  } catch { return []; }
}

// Returns line numbers where `pattern` matches inside a specific `file` at
// the commit. We pass `file` as an explicit git pathspec after `--`, so
// git-grep's output has an exact `<commit>:<file>:` prefix we can strip
// unambiguously — the colon-in-filename concern from raw `-n` output does
// not apply here because we already know the file.
function grepLinesIn(pattern, file) {
  if (!pattern || pattern.length < 12) return [];
  try {
    const o = execFileSync(
      "git",
      ["-C", repo, "grep", "-F", "-I", "-n", "-e", pattern, commit, "--", file],
      { encoding: "utf8", maxBuffer: 1 << 24 },
    );
    const prefix = `${commit}:${file}:`;
    const lines = [];
    for (const raw of o.split("\n")) {
      if (!raw || !raw.startsWith(prefix)) continue;
      const rest = raw.slice(prefix.length);
      const colon = rest.indexOf(":");
      if (colon < 0) continue;
      const n = Number(rest.slice(0, colon));
      if (Number.isFinite(n)) lines.push(n);
    }
    return lines;
  } catch { return []; }
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
  // Try each candidate line from `existing_code` until one has hits.
  // Remember which candidate matched so we can look up its line numbers
  // in the rehome target with a second targeted grep.
  let files = [];
  let matchedPattern = null;
  for (const ln of candidateLines(c.existing_code)) {
    const f = grepFiles(ln);
    if (f.length) { files = f; matchedPattern = ln; break; }
  }
  let path = c.path;
  let start_line = c.start_line;
  let end_line = c.end_line;
  let action = "keep";
  if (files.length) {
    if (files.includes(c.path)) action = "keep (correct)";
    else if (files.length === 1) {
      // Single file elsewhere. Fetch the actual line NUMBERS in that file
      // to update `start_line`/`end_line` on rehome — but only if the hit
      // is unambiguous (exactly one line). Multiple hits in the same file
      // mean the snippet appears more than once, so we cannot pick a
      // single line to post on — treat as ambiguous and leave the finding
      // on its original path.
      const target = files[0];
      const targetLines = matchedPattern ? grepLinesIn(matchedPattern, target) : [];
      if (targetLines.length === 1) {
        path = target;
        start_line = targetLines[0];
        end_line = targetLines[0];
        action = `REHOME ${c.path} -> ${path}:${targetLines[0]}`;
      } else if (targetLines.length > 1) {
        action = `keep (ambiguous: ${targetLines.length} hits in ${target})`;
      } else {
        // Line lookup returned nothing (rare — `-l` said match exists).
        // Fall back to a path-only rehome without changing the line.
        path = target;
        action = `REHOME ${c.path} -> ${path} (line unresolved)`;
      }
    }
    else action = `keep (ambiguous: ${files.length} files)`;
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
