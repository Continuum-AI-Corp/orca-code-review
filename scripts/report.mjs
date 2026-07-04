#!/usr/bin/env node
// Best-effort run report to the OrcaRouter control plane.
//
//   node report.mjs <result.json> --repo <owner/name> --pr <n> --sha <sha>
//     --tier cheap|strong --gate pass|blocked --url <orcarouter-url> --key <api-key>
//     [--engine-version <v>]
//
// POSTs {repo, pr_number, head_sha, tier, p0, p1, p2, gate_result[,
// engine_version]} to <origin of --url>/api/code_review/report (the /v1/…
// path of the chat-completions URL is stripped) with `Authorization: Bearer
// <key>`. Severity counts come from the SAME result JSON gate.mjs reads, via
// the shared severity.mjs (leading tag + untagged->P1 fail-safe) — counts and
// gate result only, never code, diff, or finding text.
//
// STRICTLY best-effort: this must never fail the review job. Any problem —
// unreadable result, bad URL, network error, non-2xx — is logged to stderr and
// the script still exits 0. One retry, 5s timeout per attempt. The
// `report: "false"` off switch lives in action.yml (step-level `if:` guard),
// not here — when disabled this script is never invoked.

import fs from "node:fs";
import { countSeverities } from "./severity.mjs";
import { controlPlaneBase } from "./control-plane.mjs";

const TIMEOUT_MS = 5000;
const RETRY_PAUSE_MS = 500;
const ATTEMPTS = 2; // initial + one retry

async function main() {
  const [file, ...rest] = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--repo") opts.repo = rest[++i];
    else if (rest[i] === "--pr") opts.pr = rest[++i];
    else if (rest[i] === "--sha") opts.sha = rest[++i];
    else if (rest[i] === "--tier") opts.tier = rest[++i];
    else if (rest[i] === "--gate") opts.gate = rest[++i];
    else if (rest[i] === "--url") opts.url = rest[++i];
    else if (rest[i] === "--engine-version") opts.engineVersion = rest[++i];
  }
  // Key from the environment, NEVER argv (a --key flag leaks via
  // /proc/<pid>/cmdline and `ps aux` on shared/self-hosted runners).
  opts.key = process.env.ORCAROUTER_API_KEY;
  if (!file || !opts.repo || !opts.pr || !opts.sha || !opts.tier || !opts.gate || !opts.url || !opts.key) {
    console.error(
      "report: usage: ORCAROUTER_API_KEY=<key> node report.mjs <result.json> --repo X --pr N --sha S " +
        "--tier cheap|strong --gate pass|blocked --url U [--engine-version V] " +
        "(best-effort — exiting 0)",
    );
    return;
  }

  let comments;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    comments = Array.isArray(parsed.comments) ? parsed.comments : [];
  } catch (e) {
    console.error(`report: skipped — could not read findings from ${file} (${e.message})`);
    return; // nothing trustworthy to report
  }
  const counts = countSeverities(comments);

  const payload = {
    repo: opts.repo,
    pr_number: Number(opts.pr),
    head_sha: opts.sha,
    tier: opts.tier,
    p0: counts.P0,
    p1: counts.P1,
    p2: counts.P2,
    gate_result: opts.gate,
  };
  if (opts.engineVersion) payload.engine_version = opts.engineVersion;

  let endpoint;
  try {
    endpoint = `${controlPlaneBase(opts.url)}/api/code_review/report`;
  } catch (e) {
    console.error(`report: skipped — bad --url (${e.message})`);
    return;
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.key}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        console.error(`report: sent ${opts.tier}/${opts.gate} for ${opts.repo}#${opts.pr}`);
        return;
      }
      console.error(`report: attempt ${attempt}/${ATTEMPTS} got HTTP ${res.status}`);
    } catch (e) {
      console.error(`report: attempt ${attempt}/${ATTEMPTS} failed (${e.message})`);
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
  }
  console.error("report: giving up — best-effort, the review job is unaffected");
}

// Exit 0 unconditionally (and explicitly: fetch keep-alive sockets must not
// hold the process open) — a reporting problem may never fail the review.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(`report: ${e.message}`);
    process.exit(0);
  },
);
