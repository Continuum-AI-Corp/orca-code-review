// Contract tests for report.mjs — the best-effort run report to the
// OrcaRouter control plane.
//
// Contract: POST {repo, pr_number, head_sha, tier, p0, p1, p2, gate_result,
// engine_version} to <origin of --url>/api/code_review/report with
// `Authorization: Bearer <key>`. Counts come from the SAME parsing gate.mjs
// uses (shared severity.mjs: leading tag + untagged->P1 fail-safe).
//
// STRICTLY best-effort: any failure — bad file, refused connection, HTTP 5xx —
// logs to stderr and still exits 0 (the child exit status is asserted below);
// one retry, 5s timeout. The "report: false" disable switch is NOT in this script:
// it is the `inputs.report == 'true'` guard on the two report steps in
// action.yml — the last test pins that guard so it can't be dropped.

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const REPORT = join(SCRIPTS, "report.mjs");
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "report-test-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// Control-plane double: records every request, answers with `status`.
async function startControlPlane(status = 200) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const port = await listen(server);
  return { port, seen, close: () => new Promise((r) => server.close(r)) };
}

function writeResult(contents) {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ comments: contents.map((content) => ({ content })) }));
  return file;
}

// Async spawn (NOT spawnSync): the mock control plane runs in THIS process,
// so the test's event loop must stay live to answer the child's request.
function runReport(args) {
  return new Promise((resolve) => {
    const child = spawn("node", [REPORT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// Findings fixture -> p0:1, p1:2 (one tagged + one untagged fail-safe), p2:2.
const FIXTURE = ["[P0] sql injection", "[P1] null deref", "[p2] use const", "[P2] dead code", "untagged bug"];

const baseArgs = (file, port, extra = []) => [
  file,
  "--repo", "acme/widgets",
  "--pr", "42",
  "--sha", "deadbeef123",
  "--tier", "cheap",
  "--gate", "blocked",
  "--url", `http://127.0.0.1:${port}/v1/chat/completions`,
  "--key", "test-key-123",
  ...extra,
];

describe("payload assembly", () => {
  test("POSTs the exact body to <origin>/api/code_review/report with Bearer auth", async () => {
    const cp = await startControlPlane(200);
    try {
      const r = await runReport(baseArgs(writeResult(FIXTURE), cp.port, ["--engine-version", "1.3.13"]));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(cp.seen.length, 1);
      const req = cp.seen[0];
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/code_review/report", "the /v1/... path must be stripped to the origin");
      assert.equal(req.headers.authorization, "Bearer test-key-123");
      assert.match(req.headers["content-type"], /application\/json/);
      assert.deepEqual(JSON.parse(req.body), {
        repo: "acme/widgets",
        pr_number: 42, // a NUMBER, not a string
        head_sha: "deadbeef123",
        tier: "cheap",
        p0: 1,
        p1: 2, // [P1] + the untagged fail-safe
        p2: 2,
        gate_result: "blocked",
        engine_version: "1.3.13",
      });
    } finally {
      await cp.close();
    }
  });

  test("omits engine_version when the flag is not given", async () => {
    const cp = await startControlPlane(200);
    try {
      const r = await runReport(baseArgs(writeResult(["[P2] nit"]), cp.port));
      assert.equal(r.status, 0, r.stderr);
      const body = JSON.parse(cp.seen[0].body);
      assert.equal("engine_version" in body, false);
      assert.deepEqual([body.p0, body.p1, body.p2], [0, 0, 1]);
    } finally {
      await cp.close();
    }
  });
});

describe("best-effort (must never fail the job)", () => {
  test("server 500 -> one retry, then exit 0", async () => {
    const cp = await startControlPlane(500);
    try {
      const r = await runReport(baseArgs(writeResult(FIXTURE), cp.port));
      assert.equal(r.status, 0, "a control-plane 5xx must not fail the job");
      assert.equal(cp.seen.length, 2, "exactly one retry");
      assert.match(r.stderr, /500/);
    } finally {
      await cp.close();
    }
  });

  test("connection refused -> exit 0", async () => {
    // Grab a port that is guaranteed closed: listen once, then free it.
    const dead = http.createServer();
    const deadPort = await listen(dead);
    await new Promise((r) => dead.close(r));

    const r = await runReport(baseArgs(writeResult(FIXTURE), deadPort));
    assert.equal(r.status, 0, "an unreachable control plane must not fail the job");
    assert.match(r.stderr, /report:/);
  });

  test("unreadable result.json -> exit 0 and nothing is sent", async () => {
    const cp = await startControlPlane(200);
    try {
      const r = await runReport(baseArgs(join(dir, "does-not-exist.json"), cp.port));
      assert.equal(r.status, 0);
      assert.equal(cp.seen.length, 0, "no data -> no report");
      assert.match(r.stderr, /report:/);
    } finally {
      await cp.close();
    }
  });

  test("missing required flags -> exit 0 (logs usage, never fails the job)", async () => {
    const r = await runReport([writeResult(FIXTURE), "--repo", "acme/widgets"]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /usage/i);
  });
});

describe("disable switch (report: \"false\")", () => {
  test("action.yml guards both per-tier report steps on the `report` input", () => {
    // The off switch lives at the STEP level, not in this script: when the
    // consumer sets `report: "false"`, the steps are skipped entirely and
    // report.mjs is never invoked. Pin the guard so a refactor can't drop it.
    const actionYml = readFileSync(join(SCRIPTS, "..", "action.yml"), "utf8");
    const guards = actionYml.match(/inputs\.report == 'true'/g) || [];
    assert.ok(
      guards.length >= 2,
      "both report steps (cheap + strong) must carry an `inputs.report == 'true'` if-guard",
    );
  });
});
