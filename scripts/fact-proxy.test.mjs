// Contract tests for fact-proxy.mjs — the in-job loopback proxy that stamps
// cascade facts onto OCR's requests and forwards them to the OrcaRouter
// gateway.
//
// Retry contract (A3): 429/502/503/504 and connection errors are retried up to
// 3 more attempts with 1s/2s/4s backoff; a numeric Retry-After header (seconds)
// wins, capped at 30s. The request body is fully buffered BEFORE the first
// attempt so every retry replays identical bytes. Any other status — crucially
// every other 4xx — is relayed immediately, and a final failure relays the
// upstream status/body unchanged. Every response carries x-cr-retry-count.
//
// The proxy exposes an injectable `sleep` (test seam only); its CLI contract —
// env-driven config, `PROXY_URL=…` printed on listen — is unchanged and is
// exercised by the last test.

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createProxyServer } from "./fact-proxy.mjs";

const PROXY_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "fact-proxy.mjs");
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "fact-proxy-test-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// Upstream double: answers request k with plan[k] (the last entry repeats),
// recording every request (headers + body) it saw.
async function startUpstream(plan) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const step = plan[Math.min(seen.length - 1, plan.length - 1)];
      res.writeHead(step.status, step.headers || {});
      res.end(step.body ?? "");
    });
  });
  const port = await listen(server);
  return { port, seen, close: () => new Promise((r) => server.close(r)) };
}

// Injectable sleep double: records requested delays, never actually waits.
function fakeSleep() {
  const calls = [];
  return {
    calls,
    fn: (ms) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

async function startProxy(opts) {
  const server = createProxyServer(opts);
  const port = await listen(server);
  return { port, close: () => new Promise((r) => server.close(r)) };
}

function request(port, { path = "/v1/chat/completions", body = "", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("retry / backoff", () => {
  test("503 twice then 200 -> 1s/2s backoff; facts and buffered body replayed on every attempt", async () => {
    const factsFile = join(dir, "facts-retry.json");
    writeFileSync(factsFile, JSON.stringify({ "x-cr-prev-tier": "cheap", "not-a-fact": "evil" }));
    const upstream = await startUpstream([
      { status: 503, body: "busy" },
      { status: 503, body: "busy" },
      { status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' },
    ]);
    const sleep = fakeSleep();
    const proxy = await startProxy({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
      factsFile,
      sleep: sleep.fn,
    });
    try {
      const payload = JSON.stringify({ model: "orcarouter/code-review", messages: [{ role: "user", content: "hi" }] });
      const res = await request(proxy.port, { body: payload });
      assert.equal(res.status, 200);
      assert.equal(res.body, '{"ok":true}');
      assert.equal(res.headers["x-cr-retry-count"], "2");
      assert.deepEqual(sleep.calls, [1000, 2000]);
      assert.equal(upstream.seen.length, 3);
      for (const attempt of upstream.seen) {
        assert.equal(attempt.body, payload, "buffered body must be replayed byte-identical");
        assert.equal(attempt.headers["x-cr-prev-tier"], "cheap", "facts stamped on every attempt");
        assert.equal(attempt.headers["not-a-fact"], undefined, "non x-cr-* keys never injected");
      }
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("numeric Retry-After (seconds) wins over backoff and is capped at 30s", async () => {
    const upstream = await startUpstream([
      { status: 429, headers: { "retry-after": "7" }, body: "slow down" },
      { status: 429, headers: { "retry-after": "999" }, body: "slow down" },
      { status: 200, body: "ok" },
    ]);
    const sleep = fakeSleep();
    const proxy = await startProxy({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
      sleep: sleep.fn,
    });
    try {
      const res = await request(proxy.port, { body: "{}" });
      assert.equal(res.status, 200);
      assert.deepEqual(sleep.calls, [7000, 30000]);
      assert.equal(res.headers["x-cr-retry-count"], "2");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("non-numeric Retry-After falls back to the backoff schedule", async () => {
    const upstream = await startUpstream([
      { status: 429, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, body: "later" },
      { status: 200, body: "ok" },
    ]);
    const sleep = fakeSleep();
    const proxy = await startProxy({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
      sleep: sleep.fn,
    });
    try {
      const res = await request(proxy.port, { body: "{}" });
      assert.equal(res.status, 200);
      assert.deepEqual(sleep.calls, [1000]);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("still failing after 3 retries -> upstream status/body relayed unchanged, retry count 3", async () => {
    const upstream = await startUpstream([
      { status: 503, headers: { "content-type": "text/plain" }, body: "gateway busy" },
    ]);
    const sleep = fakeSleep();
    const proxy = await startProxy({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
      sleep: sleep.fn,
    });
    try {
      const res = await request(proxy.port, { body: "{}" });
      assert.equal(res.status, 503);
      assert.equal(res.body, "gateway busy");
      assert.equal(res.headers["content-type"], "text/plain");
      assert.equal(res.headers["x-cr-retry-count"], "3");
      assert.equal(upstream.seen.length, 4, "1 initial attempt + 3 retries");
      assert.deepEqual(sleep.calls, [1000, 2000, 4000]);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("connection errors are retried, then surfaced as 502", async () => {
    // Grab a port that is guaranteed closed: listen once, then free it.
    const dead = http.createServer();
    const deadPort = await listen(dead);
    await new Promise((r) => dead.close(r));

    const sleep = fakeSleep();
    const proxy = await startProxy({
      upstreamUrl: `http://127.0.0.1:${deadPort}/v1/chat/completions`,
      sleep: sleep.fn,
    });
    try {
      const res = await request(proxy.port, { body: "{}" });
      assert.equal(res.status, 502);
      assert.equal(res.headers["x-cr-retry-count"], "3");
      assert.deepEqual(sleep.calls, [1000, 2000, 4000]);
    } finally {
      await proxy.close();
    }
  });
});

describe("non-retryable statuses", () => {
  test("400 is NOT retried and passes straight through", async () => {
    const upstream = await startUpstream([{ status: 400, body: "bad request" }]);
    const sleep = fakeSleep();
    const proxy = await startProxy({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
      sleep: sleep.fn,
    });
    try {
      const res = await request(proxy.port, { body: "{}" });
      assert.equal(res.status, 400);
      assert.equal(res.body, "bad request");
      assert.equal(res.headers["x-cr-retry-count"], "0");
      assert.equal(upstream.seen.length, 1, "a 400 must hit upstream exactly once");
      assert.deepEqual(sleep.calls, []);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("guardrail 400 still records the policy-block file (and is not retried)", async () => {
    const blockFile = join(dir, "policy-block.json");
    const guardrailBody = JSON.stringify({
      error: {
        code: "guardrail_blocked",
        message:
          'request blocked by guardrail "pii-shield": regex(matched pattern "a+") (request id: req-42)',
      },
    });
    const upstream = await startUpstream([
      { status: 400, headers: { "content-type": "application/json" }, body: guardrailBody },
    ]);
    const sleep = fakeSleep();
    const proxy = await startProxy({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
      policyBlockFile: blockFile,
      sleep: sleep.fn,
    });
    try {
      const res = await request(proxy.port, { body: "{}" });
      assert.equal(res.status, 400);
      assert.equal(res.body, guardrailBody, "identical bytes must be relayed to OCR");
      assert.equal(res.headers["x-cr-retry-count"], "0");
      assert.equal(upstream.seen.length, 1);
      assert.deepEqual(sleep.calls, []);
      const block = JSON.parse(readFileSync(blockFile, "utf8"));
      assert.equal(block.kind, "guardrail");
      assert.equal(block.policyName, "pii-shield");
      assert.equal(block.requestId, "req-42");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

describe("CLI contract (unchanged by the retry refactor)", () => {
  test("`node fact-proxy.mjs` reads env vars, prints PROXY_URL=…, and proxies", async () => {
    const upstream = await startUpstream([
      { status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' },
    ]);
    const factsFile = join(dir, "facts-cli.json");
    writeFileSync(factsFile, JSON.stringify({ "x-cr-prev-tier": "strong" }));

    const child = spawn(process.execPath, [PROXY_SCRIPT], {
      env: {
        ...process.env,
        ORCAROUTER_URL: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
        CR_FACTS_FILE: factsFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const url = await new Promise((resolve, reject) => {
        let out = "";
        const timer = setTimeout(
          () => reject(new Error(`no PROXY_URL line within 5s; stdout so far: ${JSON.stringify(out)}`)),
          5000,
        );
        child.stdout.on("data", (c) => {
          out += c;
          const m = out.match(/^PROXY_URL=(.+)$/m);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`proxy exited early (code ${code})`));
        });
      });
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/);

      const u = new URL(url);
      const res = await request(Number(u.port), { path: u.pathname, body: '{"model":"m"}' });
      assert.equal(res.status, 200);
      assert.equal(res.body, '{"ok":true}');
      assert.equal(res.headers["x-cr-retry-count"], "0", "success responses carry retry count 0");
      assert.equal(upstream.seen[0].headers["x-cr-prev-tier"], "strong");
    } finally {
      child.kill();
      await upstream.close();
    }
  });
});
