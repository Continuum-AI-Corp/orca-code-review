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

const CODE_EXT = /\.(go|js|jsx|ts|tsx|mjs|cjs|py|java|rb|rs|c|h|cc|cpp|sql|sh)$/i;

function grepFiles(pattern) {
  if (!pattern || pattern.length < 12) return [];
  try {
    const o = execFileSync("git", ["-C", repo, "grep", "-F", "-I", "-l", "-e", pattern, commit], {
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    return [...new Set(o.split("\n").filter(Boolean).map((l) => l.slice(l.indexOf(":") + 1)))];
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
  let trueFiles = [];
  for (const ln of candidateLines(c.existing_code)) {
    const f = grepFiles(ln);
    if (f.length) { trueFiles = f; break; }
  }
  let path = c.path;
  let action = "keep";
  if (trueFiles.length) {
    if (trueFiles.includes(c.path)) action = "keep (correct)";
    else if (trueFiles.length === 1) { path = trueFiles[0]; action = `REHOME ${c.path} -> ${path}`; }
    else action = `keep (ambiguous: ${trueFiles.length} files)`;
  } else if (!CODE_EXT.test(c.path)) {
    action = "DROP (code snippet, filed on non-code file, not found)";
  } else {
    action = "keep (snippet unverified)";
  }
  report.push({ sev: (c.content || "").match(/\[(P[0-3])\]/)?.[1] || "?", from: c.path, action });
  if (action.startsWith("DROP")) continue;
  kept.push({ ...c, path });
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
