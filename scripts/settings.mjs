#!/usr/bin/env node
// Dashboard settings fetch for the OrcaRouter Code Review cascade.
//
//   node settings.mjs --url <orcarouter-url> --repo owner/name --out <path.json>
//   (the API key comes from ORCAROUTER_API_KEY in the env, never a flag)
//
// GETs <origin of --url>/api/code_review/settings?repo=<owner/name> (the
// /v1/… path of the chat-completions URL is stripped, same as report.mjs)
// with `Authorization: Bearer <key>`. The gateway answers
// {"success":true,"message":"","data":{auto_review, trigger, exhaustive,
// quiet, fix_first, block_on, rubric}} — always 200 with the EFFECTIVE
// settings for the repo.
//
// The validated settings object is written to --out AND printed to stdout,
// and the script ALWAYS exits 0:
//
//   - Envelope failure (network error, non-200, garbage JSON, success!=true,
//     missing data) -> one retry, then the built-in DEFAULTS below, with the
//     fallback noted on stderr. FAIL-OPEN: a settings outage must never kill
//     reviews — the defaults reproduce the action's documented behavior.
//   - Field failure (unknown trigger, bad severity list, non-bool, non-string
//     rubric) -> that FIELD falls back to its default while valid fields are
//     kept; no retry (re-asking won't change a value the server meant).
//
// Severity lists are normalized (trim + uppercase); an explicit empty string
// is VALID and means "none" (e.g. block_on:"" = never block). A whitespace-
// only rubric is treated as empty (no override). 5s timeout per attempt.
//
// The precedence rule between these settings and explicit `with:` inputs
// (an input differing from its documented default wins) lives in action.yml's
// "Fetch review settings" step, not here — this script only reports what the
// server says.

import fs from "node:fs";
import { SEVERITIES } from "./severity.mjs";
import { controlPlaneBase } from "./control-plane.mjs";

const TIMEOUT_MS = 5000;
const RETRY_PAUSE_MS = 500;
const ATTEMPTS = 2; // initial + one retry

// Keep in sync with the README table and settings.test.mjs.
const DEFAULTS = Object.freeze({
  auto_review: true,
  trigger: "every_push",
  exhaustive: false,
  quiet: false,
  fix_first: "P0,P1",
  block_on: "P0,P1",
  rubric: "",
});

const TRIGGERS = new Set(["every_push", "ready_for_review", "on_demand"]);

// "P0, p1" -> "P0,P1"; "" -> "" (a valid, deliberate "none"); anything with a
// non-severity token (or a non-string) -> null (invalid — caller defaults).
function normalizeSeverityList(v) {
  if (typeof v !== "string") return null;
  const tokens = v
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (tokens.some((t) => !SEVERITIES.includes(t))) return null;
  return tokens.join(",");
}

// Field-wise validation: every invalid field falls back to its default and is
// noted on stderr; valid fields are kept.
function validateSettings(data) {
  const out = { ...DEFAULTS };
  const fallback = (field, got) =>
    console.error(
      `settings: field "${field}" invalid (${JSON.stringify(got)}) — using default ${JSON.stringify(DEFAULTS[field])}`,
    );

  for (const field of ["auto_review", "exhaustive", "quiet"]) {
    if (typeof data[field] === "boolean") out[field] = data[field];
    else fallback(field, data[field]);
  }

  if (TRIGGERS.has(data.trigger)) out.trigger = data.trigger;
  else fallback("trigger", data.trigger);

  for (const field of ["fix_first", "block_on"]) {
    const normalized = normalizeSeverityList(data[field]);
    if (normalized !== null) out[field] = normalized;
    else fallback(field, data[field]);
  }

  if (typeof data.rubric === "string") {
    // Whitespace-only means "no override"; keep real text verbatim.
    out.rubric = data.rubric.trim() === "" ? "" : data.rubric;
  } else {
    fallback("rubric", data.rubric);
  }

  return out;
}

// One settings fetch. Throws on any envelope problem — the caller retries.
async function fetchOnce(endpoint, key) {
  const res = await fetch(endpoint, {
    method: "GET",
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json(); // throws on garbage
  if (body?.success !== true) throw new Error("response missing success:true");
  if (typeof body.data !== "object" || body.data === null) throw new Error("response missing data object");
  return body.data;
}

async function resolveSettings(opts) {
  let endpoint;
  try {
    endpoint = `${controlPlaneBase(opts.url)}/api/code_review/settings?repo=${encodeURIComponent(opts.repo)}`;
  } catch (e) {
    console.error(`settings: bad --url (${e.message}) — using built-in defaults`);
    return { ...DEFAULTS };
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return validateSettings(await fetchOnce(endpoint, opts.key));
    } catch (e) {
      console.error(`settings: attempt ${attempt}/${ATTEMPTS} failed (${e.message})`);
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
  }
  console.error("settings: giving up — using built-in defaults (fail-open, reviews continue)");
  return { ...DEFAULTS };
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url") opts.url = argv[++i];
    else if (argv[i] === "--repo") opts.repo = argv[++i];
    else if (argv[i] === "--out") opts.out = argv[++i];
  }
  // The API key comes from the environment, NEVER argv: a --key flag would
  // land in /proc/<pid>/cmdline and `ps aux` (world-readable on Linux), a
  // real leak on shared/self-hosted runners.
  opts.key = process.env.ORCAROUTER_API_KEY;

  let settings;
  if (!opts.url || !opts.key || !opts.repo || !opts.out) {
    console.error(
      "settings: usage: ORCAROUTER_API_KEY=<key> node settings.mjs --url U --repo owner/name --out path.json " +
        "(fail-open — printing built-in defaults and exiting 0)",
    );
    settings = { ...DEFAULTS };
  } else {
    settings = await resolveSettings(opts);
  }

  const json = JSON.stringify(settings);
  if (opts.out) {
    try {
      fs.writeFileSync(opts.out, json);
    } catch (e) {
      console.error(`settings: could not write ${opts.out} (${e.message}) — stdout still carries the values`);
    }
  }
  process.stdout.write(`${json}\n`);
}

// Exit 0 unconditionally (and explicitly: fetch keep-alive sockets must not
// hold the process open) — a settings problem may never fail the review. Even
// an unexpected crash still emits the defaults so the driver has values.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(`settings: ${e.message} — using built-in defaults`);
    process.stdout.write(`${JSON.stringify(DEFAULTS)}\n`);
    process.exit(0);
  },
);
