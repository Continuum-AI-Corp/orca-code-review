// Contract tests for settings.mjs — the dashboard settings fetch — and for
// quiet-filter.mjs, the quiet-mode P2 filter those settings drive.
//
// settings.mjs contract: GET <origin of --url>/api/code_review/settings?repo=…
// with `Authorization: Bearer <key>`; write the validated settings object to
// --out AND print it to stdout; ALWAYS exit 0. Any envelope failure — network
// error, non-200, garbage JSON, missing success — falls back to the built-in
// defaults (fail-open: a settings outage must never kill reviews); an invalid
// FIELD value falls back field-wise while valid fields are kept. One retry,
// 5s timeout per attempt.
//
// quiet-filter.mjs contract: `node quiet-filter.mjs <result.json> --drop P2
// --out <filtered.json>` drops exactly the comments whose severity (shared
// severity.mjs: leading tag + untagged->P1 fail-safe) is in --drop, preserves
// order and every other key of the engine result, and prints
// {"kept":n,"dropped":m}. The gate and the run report keep reading the
// UNfiltered result — quiet mode only mutes what gets POSTED.

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const SETTINGS = join(SCRIPTS, "settings.mjs");
const QUIET_FILTER = join(SCRIPTS, "quiet-filter.mjs");
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "settings-test-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Keep in sync with DEFAULTS in settings.mjs (and the README table).
const DEFAULTS = {
  auto_review: true,
  trigger: "every_push",
  exhaustive: false,
  quiet: false,
  fix_first: "P0,P1",
  block_on: "P0,P1",
  rubric: "",
};

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// Gateway double: answers request i with responses[i] (the last one repeats),
// recording what it saw. `body` may be an object (JSON-encoded) or a string.
async function startGateway(responses) {
  const seen = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}));
  });
  const port = await listen(server);
  return { port, seen, close: () => new Promise((r) => server.close(r)) };
}

const envelope = (data) => ({ success: true, message: "", data });

// Async spawn (NOT spawnSync): the mock gateway runs in THIS process, so the
// test's event loop must stay live to answer the child's request.
function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn("node", [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function outPath() {
  return join(dir, `${Math.random().toString(36).slice(2)}-settings.json`);
}

const baseArgs = (port, out) => [
  "--url", `http://127.0.0.1:${port}/v1/chat/completions`,
  "--key", "test-key-123",
  "--repo", "acme/widgets",
  "--out", out,
];

describe("settings: happy fetch", () => {
  test("GETs <origin>/api/code_review/settings?repo=… with Bearer auth; writes AND prints the data", async () => {
    const data = {
      auto_review: false,
      trigger: "ready_for_review",
      exhaustive: true,
      quiet: true,
      fix_first: "P0",
      block_on: "P0,P1,P2",
      rubric: "Custom rubric: tag every comment [P0]/[P1]/[P2].",
    };
    const gw = await startGateway([{ status: 200, body: envelope(data) }]);
    const out = outPath();
    try {
      const r = await run(SETTINGS, baseArgs(gw.port, out));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(gw.seen.length, 1);
      const req = gw.seen[0];
      assert.equal(req.method, "GET");
      assert.equal(
        req.url,
        "/api/code_review/settings?repo=acme%2Fwidgets",
        "the /v1/… path must be stripped to the origin; repo must be URL-encoded",
      );
      assert.equal(req.headers.authorization, "Bearer test-key-123");
      assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), data);
      assert.deepEqual(JSON.parse(r.stdout), data);
    } finally {
      await gw.close();
    }
  });

  test("severity lists are normalized (trim, uppercase); empty string is a VALID 'none' list", async () => {
    const gw = await startGateway([
      { status: 200, body: envelope({ ...DEFAULTS, fix_first: " p0 , p2 ", block_on: "" }) },
    ]);
    const out = outPath();
    try {
      const r = await run(SETTINGS, baseArgs(gw.port, out));
      assert.equal(r.status, 0, r.stderr);
      const got = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(got.fix_first, "P0,P2");
      assert.equal(got.block_on, "", "an explicit empty list means 'block on nothing', not a fallback");
    } finally {
      await gw.close();
    }
  });
});

describe("settings: fail-open to defaults (must never kill reviews)", () => {
  test("HTTP 500 on both attempts -> defaults, exit 0, exactly one retry", async () => {
    const gw = await startGateway([{ status: 500, body: "oops" }]);
    const out = outPath();
    try {
      const r = await run(SETTINGS, baseArgs(gw.port, out));
      assert.equal(r.status, 0, "a settings outage must not fail the job");
      assert.equal(gw.seen.length, 2, "exactly one retry");
      assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), DEFAULTS);
      assert.deepEqual(JSON.parse(r.stdout), DEFAULTS);
      assert.match(r.stderr, /default/i, "the fallback must be noted on stderr");
    } finally {
      await gw.close();
    }
  });

  test("connection refused -> defaults, exit 0", async () => {
    // Grab a port that is guaranteed closed: listen once, then free it.
    const dead = http.createServer();
    const deadPort = await listen(dead);
    await new Promise((r) => dead.close(r));

    const out = outPath();
    const r = await run(SETTINGS, baseArgs(deadPort, out));
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), DEFAULTS);
    assert.match(r.stderr, /default/i);
  });

  test("200 with a garbage (non-JSON) body -> defaults, exit 0", async () => {
    const gw = await startGateway([{ status: 200, body: "<!doctype html>not json" }]);
    const out = outPath();
    try {
      const r = await run(SETTINGS, baseArgs(gw.port, out));
      assert.equal(r.status, 0);
      assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), DEFAULTS);
    } finally {
      await gw.close();
    }
  });

  test("success:false (or missing) -> defaults, exit 0", async () => {
    const gw = await startGateway([{ status: 200, body: { success: false, message: "nope" } }]);
    const out = outPath();
    try {
      const r = await run(SETTINGS, baseArgs(gw.port, out));
      assert.equal(r.status, 0);
      assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), DEFAULTS);
    } finally {
      await gw.close();
    }
  });

  test("missing required flags -> defaults printed to stdout, exit 0", async () => {
    const r = await run(SETTINGS, ["--url", "http://127.0.0.1:1/v1"]);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), DEFAULTS);
    assert.match(r.stderr, /usage/i);
  });

  test("bad --url -> defaults, exit 0 (still written to --out)", async () => {
    const out = outPath();
    const r = await run(SETTINGS, [
      "--url", "not a url", "--key", "k", "--repo", "a/b", "--out", out,
    ]);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), DEFAULTS);
  });
});

describe("settings: field-wise fallback on invalid values", () => {
  test("bad trigger / severity strings / non-bools default individually; valid fields are kept", async () => {
    const gw = await startGateway([
      {
        status: 200,
        body: envelope({
          auto_review: false, // valid — kept
          trigger: "weekly", // invalid -> default
          exhaustive: true, // valid — kept
          quiet: "yes", // not a bool -> default
          fix_first: "P0,P9", // P9 is not a severity -> default
          block_on: 42, // not a string -> default
          rubric: 123, // not a string -> default
        }),
      },
    ]);
    const out = outPath();
    try {
      const r = await run(SETTINGS, baseArgs(gw.port, out));
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), {
        auto_review: false,
        trigger: "every_push",
        exhaustive: true,
        quiet: false,
        fix_first: "P0,P1",
        block_on: "P0,P1",
        rubric: "",
      });
      assert.match(r.stderr, /trigger/, "field fallbacks must be noted on stderr");
      assert.equal(gw.seen.length, 1, "field-level problems are server values — no retry");
    } finally {
      await gw.close();
    }
  });

  test("a whitespace-only rubric is treated as empty (no override)", async () => {
    const gw = await startGateway([
      { status: 200, body: envelope({ ...DEFAULTS, rubric: "  \n\t " }) },
    ]);
    const out = outPath();
    try {
      await run(SETTINGS, baseArgs(gw.port, out));
      assert.equal(JSON.parse(readFileSync(out, "utf8")).rubric, "");
    } finally {
      await gw.close();
    }
  });
});

describe("settings: retry-once behavior", () => {
  test("500 then 200 -> the fetched values win (not the defaults)", async () => {
    const gw = await startGateway([
      { status: 500, body: "flake" },
      { status: 200, body: envelope({ ...DEFAULTS, quiet: true, trigger: "on_demand" }) },
    ]);
    const out = outPath();
    try {
      const r = await run(SETTINGS, baseArgs(gw.port, out));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(gw.seen.length, 2);
      const got = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(got.quiet, true);
      assert.equal(got.trigger, "on_demand");
    } finally {
      await gw.close();
    }
  });
});

// ---------------------------------------------------------------- quiet-filter

// Engine-shaped result fixture with positions, so the filter must carry every
// per-comment field through untouched.
const RESULT_FIXTURE = {
  comments: [
    { path: "a.js", start_line: 1, end_line: 2, content: "[P0] sql injection" },
    { path: "b.js", start_line: 3, end_line: 3, content: "[P2] use const" },
    { path: "c.js", start_line: 5, end_line: 6, content: "[P1] null deref" },
    { path: "d.js", start_line: 7, end_line: 7, content: "[p2] lowercase tag nit" },
    { path: "e.js", start_line: 9, end_line: 9, content: "untagged real bug" },
  ],
  warnings: [],
};

function runQuietFilter(result, flags) {
  const id = Math.random().toString(36).slice(2);
  const input = join(dir, `${id}-result.json`);
  const out = join(dir, `${id}-filtered.json`);
  if (result !== undefined) writeFileSync(input, typeof result === "string" ? result : JSON.stringify(result));
  return run(QUIET_FILTER, [input, ...(flags ?? ["--drop", "P2", "--out", out])]).then((r) => ({
    ...r,
    out,
    read: () => JSON.parse(readFileSync(out, "utf8")),
  }));
}

describe("quiet-filter: drops exactly the --drop severities", () => {
  test("drops only P2 (case-insensitive tags), preserves order, keeps untagged (P1 fail-safe)", async () => {
    const r = await runQuietFilter(RESULT_FIXTURE);
    assert.equal(r.status, 0, r.stderr);
    const filtered = r.read();
    assert.deepEqual(
      filtered.comments.map((c) => c.path),
      ["a.js", "c.js", "e.js"],
      "P0, P1 and the untagged (->P1) finding survive, in the original order",
    );
    assert.deepEqual(JSON.parse(r.stdout), { kept: 3, dropped: 2 });
  });

  test("writes valid engine-shaped JSON: non-comment keys and per-comment fields survive", async () => {
    const r = await runQuietFilter(RESULT_FIXTURE);
    const filtered = r.read();
    assert.deepEqual(filtered.warnings, [], "sibling top-level keys must be preserved");
    assert.deepEqual(filtered.comments[0], RESULT_FIXTURE.comments[0], "comment objects pass through untouched");
  });

  test("--drop accepts a CSV set (P1,P2)", async () => {
    const id = Math.random().toString(36).slice(2);
    const input = join(dir, `${id}.json`);
    const out = join(dir, `${id}-out.json`);
    writeFileSync(input, JSON.stringify(RESULT_FIXTURE));
    const r = await run(QUIET_FILTER, [input, "--drop", "p1,p2", "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    const filtered = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(filtered.comments.map((c) => c.path), ["a.js"]);
    assert.deepEqual(JSON.parse(r.stdout), { kept: 1, dropped: 4 });
  });
});

describe("quiet-filter: robustness", () => {
  test("unreadable/missing input still writes an empty engine-shaped result, exit 0", async () => {
    const r = await runQuietFilter(undefined); // input file never written
    assert.equal(r.status, 0);
    assert.deepEqual(r.read(), { comments: [] });
    assert.deepEqual(JSON.parse(r.stdout), { kept: 0, dropped: 0 });
  });

  test("bad usage (missing --out / --drop, unknown severity) exits 2 — a wiring bug must be loud", async () => {
    const input = join(dir, "wiring.json");
    writeFileSync(input, JSON.stringify(RESULT_FIXTURE));
    for (const args of [
      [],
      [input, "--drop", "P2"], // no --out
      [input, "--out", join(dir, "w-out.json")], // no --drop
      [input, "--drop", "P5", "--out", join(dir, "w-out2.json")], // bad severity
    ]) {
      const r = await run(QUIET_FILTER, args);
      assert.equal(r.status, 2, `args ${JSON.stringify(args)} must exit 2`);
    }
  });
});

describe("action.yml wiring (settings, quiet mode)", () => {
  const actionYml = () => readFileSync(join(SCRIPTS, "..", "action.yml"), "utf8");

  test("the settings-skip comment has its own marker", () => {
    assert.ok(
      actionYml().includes("<!-- orca-code-review-disabled -->"),
      "the settings skip path must upsert by its own marker",
    );
  });

  test("only the POST step reads the quiet-filtered result; gate + report keep the true counts", () => {
    const yml = actionYml();
    const post = yml.slice(yml.indexOf("- name: Post review comments"), yml.indexOf("- name: Summary comment"));
    assert.match(post, /result-posted\.json/, "posting must read the quiet-filtered file");
    const gate = yml.slice(yml.indexOf("- name: Enforce severity gate"), yml.indexOf("- name: Report run (cheap tier)"));
    assert.match(gate, /\/result\.json/, "the gate must read the unfiltered result");
    assert.doesNotMatch(gate, /result-posted\.json/, "the gate must NOT read the filtered result");
  });

  test("the summary step passes the EFFECTIVE block-on set to summary-comment.mjs", () => {
    const yml = actionYml();
    const summary = yml.slice(yml.indexOf("- name: Summary comment"), yml.indexOf("- name: Enforce severity gate"));
    assert.match(summary, /--block-on/, "the ❌ count must follow the configured block-on set, not a hardcoded P0+P1");
    assert.match(summary, /steps\.settings\.outputs\.block_on/, "and it must be the settings-aware effective value");
  });

  test("a `settings` input (default \"true\") can disable the dashboard fetch — workflow file authoritative", () => {
    const yml = actionYml();
    const inputs = yml.slice(yml.indexOf("inputs:"), yml.indexOf("runs:"));
    assert.match(inputs, /\n {2}settings:\n/, "the settings input must be declared");
    assert.match(yml, /SETTINGS_ENABLED/, "the fetch step must consume the input");
    const fetch = yml.slice(yml.indexOf("- name: Fetch review settings"), yml.indexOf("- name: Skip review (settings)"));
    assert.match(fetch, /"\$SETTINGS_ENABLED" = "false"/, "settings=false must short-circuit the fetch");
    assert.match(fetch, /decision=review/, "the short-circuit must still emit decision=review");
  });

  test("dashboard gating applies to any pull_request* event, not just pull_request_target", () => {
    const fetch = actionYml().slice(
      actionYml().indexOf("- name: Fetch review settings"),
      actionYml().indexOf("- name: Skip review (settings)"),
    );
    assert.match(fetch, /pull_request\*\)/, "a plain pull_request workflow must honor auto_review/trigger too");
  });

  test("a resumed review retires the stale settings-skip and oversized-skip notices", () => {
    const yml = actionYml();
    const summary = yml.slice(yml.indexOf("- name: Summary comment"), yml.indexOf("- name: Enforce severity gate"));
    assert.match(summary, /orca-code-review-disabled/, "the 'auto review off' notice must be cleaned up");
    assert.match(summary, /orca-code-review-skip/, "the 'diff too large' notice must be cleaned up");
    assert.match(summary, /deleteComment/, "cleanup means deleting the stale comment");
  });
});
