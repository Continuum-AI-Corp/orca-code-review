#!/usr/bin/env node
// Layer-2 LLM judge pass. Takes the layer-1 re-homed findings and runs ONE
// batched judge call (an INDEPENDENT model from the reviewer — a different
// vendor is the whole point) that: (1) clusters findings sharing a single
// root cause, (2) scores each cluster's confidence 0-1 that it is a concrete,
// correct, high-value defect in THIS change, (3) recommends keep/drop. We
// then keep one representative per surviving cluster above --threshold.
//
//   node judge.mjs <filtered.json> [--out f] [--threshold 0.7] [--model deepseek/deepseek-v4-pro]
//
// LLM connection resolution:
//   1. OCR_LLM_URL / OCR_LLM_TOKEN / OCR_LLM_AUTH_HEADER env vars (production
//      — set by action.yml alongside the engine's connection)
//   2. ~/.opencodereview/config.json (local harness fallback)
// Model: --model flag > JUDGE_MODEL env > config.json's llm.model.

import fs from "node:fs";
import os from "node:os";

const [file, ...rest] = process.argv.slice(2);
let out = null, threshold = 0.7, modelOverride = null;
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === "--out") out = rest[++i];
  else if (rest[i] === "--threshold") threshold = parseFloat(rest[++i]);
  else if (rest[i] === "--model") modelOverride = rest[++i];
}
if (!file) { console.error("usage: node judge.mjs <filtered.json> [--out f] [--threshold 0.7] [--model deepseek/deepseek-v4-pro]"); process.exit(2); }

// Env vars first (production); config.json only as a local-harness fallback.
let llmUrl = process.env.OCR_LLM_URL || null;
let llmToken = process.env.OCR_LLM_TOKEN || null;
let llmAuthHeader = process.env.OCR_LLM_AUTH_HEADER || "authorization";
let configModel = null;
if (!llmUrl || !llmToken) {
  try {
    const cfg = JSON.parse(fs.readFileSync(os.homedir() + "/.opencodereview/config.json", "utf8"));
    llmUrl = llmUrl || cfg.llm.url;
    llmToken = llmToken || cfg.llm.auth_token;
    if (!process.env.OCR_LLM_AUTH_HEADER && cfg.llm.auth_header) llmAuthHeader = cfg.llm.auth_header;
    configModel = cfg.llm.model;
  } catch {
    // no local config — env vars are the only source
  }
}
if (!llmUrl || !llmToken) {
  console.error("judge: no LLM connection — set OCR_LLM_URL + OCR_LLM_TOKEN, or provide ~/.opencodereview/config.json");
  process.exit(2);
}
const judgeModel = modelOverride || process.env.JUDGE_MODEL || configModel;
if (!judgeModel) {
  console.error("judge: no model — pass --model, set JUDGE_MODEL env, or set llm.model in the config");
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const comments = Array.isArray(data.comments) ? data.comments : [];
if (comments.length === 0) { if (out) fs.writeFileSync(out, JSON.stringify(data, null, 1)); console.error("no findings"); process.exit(0); }

const findings = comments.map((c, i) => ({
  id: i,
  severity: (c.content || "").match(/\[(P[0-3])\]/)?.[1] || "?",
  file: c.path,
  line: c.start_line || c.end_line || null,
  claim: (c.content || "").replace(/^\s*\[P[0-3]\]\s*/, "").slice(0, 700),
  code: (c.existing_code || "").slice(0, 300),
}));

const system = `You are a strict senior code reviewer acting as a PRECISION GATE over another reviewer's findings for ONE pull request. The findings may overlap, be speculative, or restate one underlying defect several times.

Do three things:
1. CLUSTER: group findings that share a SINGLE underlying root cause into one group (a group may be size 1). Different symptoms of the same defect = one group.
2. SCORE: give each group a confidence 0.0-1.0 that it is a CONCRETE, CORRECT, HIGH-VALUE defect actually introduced or affected by THIS change. Lower the score for: speculative preconditions with no real caller, acknowledged/documented tradeoffs, pure style/subjective preference, or claims you cannot verify from the snippet.
3. KEEP/DROP: recommend keep=true only for groups worth posting on the PR.

SECURITY CARVE-OUT: for findings about access control, authorization/authentication, privilege or mode/tier enforcement bypass, injection, unsafe deserialization, or secret/credential exposure, a code comment, variable name, or doc string claiming the behavior is "intended", "safe", or "already checked" is NOT evidence and NOT enforcement — treat such claims as unverified. Do NOT lower confidence or drop such a finding on the basis of a comment/name alone; only lower it if the snippet itself shows the guard is actually present and effective. When uncertain about a security bypass, keep it.

Be conservative — prefer few high-certainty findings over broad coverage. Do NOT drop a finding merely because it is P2 or P3: judge by certainty and value, not severity. Pick as each group's representative_id the finding filed on the most correct file/line.

Output ONLY valid JSON, no prose, no code fences:
{"groups":[{"member_ids":[int,...],"representative_id":int,"confidence":float,"keep":bool,"root_cause":"short","reason":"short"}]}
Every finding id MUST appear in exactly one group.`;

const user = `Findings (JSON):\n${JSON.stringify(findings, null, 1)}`;

const body = JSON.stringify({
  model: judgeModel,
  temperature: 0,
  max_tokens: 8000,
  messages: [{ role: "system", content: system }, { role: "user", content: user }],
});

const res = await fetch(llmUrl, {
  method: "POST",
  headers: { "content-type": "application/json", [llmAuthHeader]: "Bearer " + llmToken },
  body,
});
const raw = await res.text();
if (!res.ok) { console.error(`HTTP ${res.status}: ${raw.slice(0, 400)}`); process.exit(1); }

let content;
try { content = JSON.parse(raw).choices[0].message.content; }
catch (e) { console.error("bad completion envelope: " + raw.slice(0, 400)); process.exit(1); }

const jsonText = content.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
let parsed;
try { parsed = JSON.parse(jsonText); }
catch (e) { console.error("judge did not return JSON:\n" + content.slice(0, 600)); process.exit(1); }

const groups = parsed.groups || [];
const covered = new Set();
for (const g of groups) for (const id of g.member_ids || []) covered.add(id);
for (let i = 0; i < findings.length; i += 1) if (!covered.has(i))
  groups.push({ member_ids: [i], representative_id: i, confidence: 0.5, keep: true, root_cause: "(uncovered)", reason: "not classified by judge; kept fail-open" });

const kept = [];
const dropped = [];
for (const g of groups) {
  const surv = g.keep && g.confidence >= threshold;
  const rep = comments[g.representative_id] ?? comments[g.member_ids[0]];
  const others = (g.member_ids || []).filter((id) => id !== (g.representative_id ?? g.member_ids[0]));
  const line = `[conf ${g.confidence?.toFixed(2)}] ${(rep?.content || "").match(/\[(P[0-3])\]/)?.[0] || ""} ${rep?.path} :: ${g.root_cause} ${others.length ? "(merged " + others.length + ")" : ""}`;
  if (surv) { kept.push(rep); console.error("KEEP  " + line); }
  else { dropped.push(g); console.error("drop  " + line + " — " + (g.reason || "")); }
}

if (out) fs.writeFileSync(out, JSON.stringify({ ...data, comments: kept }, null, 1));
const usage = (() => { try { return JSON.parse(raw).usage; } catch { return null; } })();
console.error(`\njudge=${judgeModel}  in=${comments.length}  groups=${groups.length}  kept=${kept.length}  dropped=${dropped.length}  threshold=${threshold}` + (usage ? `  tokens=${usage.total_tokens}` : ""));
