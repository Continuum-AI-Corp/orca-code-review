// Contract tests for fact-proxy.mjs — the in-job loopback proxy that stamps
// cascade facts onto OCR's requests and forwards them to the OrcaRouter
// gateway.
//
// Retry contract (A3): 429/502/503/504 is retried up to 3 more attempts with
// 1s/2s/4s backoff; a numeric Retry-After header (seconds) wins, capped at
// 30s. Connection errors are retried ONLY when they prove the request was
// never processed (ECONNREFUSED/ENOTFOUND/EAI_AGAIN, or an error before the
// body finished flushing) — a post-send reset may already have been billed
// and is surfaced as 502 instead. The request body is fully buffered BEFORE
// the first attempt so every retry replays identical bytes, capped at
// maxBufferBytes (8 MiB default): larger bodies stream straight through with
// retries disabled. Once a response has started relaying, nothing retries —
// a mid-relay failure terminates the client connection fast (no hang, no
// double writeHead). Any other status — crucially every other 4xx — is
// relayed immediately, and a final failure relays the upstream status/body
// unchanged. Every response carries x-cr-retry-count.
//
// The proxy exposes injectable `sleep` and `maxBufferBytes` (test seams
// only); its CLI contract — env-driven config, `PROXY_URL=…` printed on
// listen — is unchanged and is exercised by the last test.

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

// Client that TOLERATES a mid-body failure: always resolves with what it saw
// (never rejects, never hangs past the cap) so tests can assert on truncated
// or terminated responses. `timedOut: true` means the proxy left the
// connection open — the hang the mid-relay handling must prevent.
function requestOutcome(port, { path = "/v1/chat/completions", body = "" } = {}, capMs = 5000) {
  return new Promise((resolve) => {
    const outcome = { status: null, endedCleanly: false, timedOut: false };
    const timer = setTimeout(() => {
      outcome.timedOut = true;
      req.destroy();
      resolve(outcome);
    }, capMs);
    const finish = () => {
      clearTimeout(timer);
      resolve(outcome);
    };
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST" }, (res) => {
      outcome.status = res.statusCode;
      res.on("data", () => {});
      res.on("end", () => {
        outcome.endedCleanly = true;
      });
      res.on("error", () => {});
      res.on("close", finish);
    });
    req.on("error", finish);
    req.end(body);
  });
}

// Upstream double for failure injection: `handler(req, res, hit)` decides per
// request; `hits()` reports how many requests arrived (the retry counter).
async function startRawUpstream(handler) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    const hit = hits;
    req.resume();
    req.on("end", () => handler(req, res, hit));
  });
  const port = await listen(server);
  return { port, hits: () => hits, close: () => new Promise((r) => server.close(r)) };
}

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

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

describe("mid-relay failures (the response already started — never retry)", () => {
  test("SSE stream dies after 200: client terminated fast (no hang), NO retry, proxy survives", async () => {
    const upstream = await startRawUpstream((req, res, hit) => {
      if (hit === 1) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: partial\n\n");
        setTimeout(() => res.socket.resetAndDestroy(), 20);
      } else {
        res.writeHead(200);
        res.end("ok");
      }
    });
    const sleep = fakeSleep();
    const proxy = await startProxy({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
      sleep: sleep.fn,
    });
    try {
      const outcome = await requestOutcome(proxy.port, { body: "{}" });
      assert.equal(outcome.timedOut, false, "a mid-stream failure must terminate the client response, not hang it");
      assert.equal(outcome.status, 200, "the relay had already started when the stream died");
      assert.equal(outcome.endedCleanly, false, "the truncated stream must not end as a clean response");
      await settle(); // give a (buggy) scheduled retry time to fire
      assert.equal(upstream.hits(), 1, "once the response started relaying, the request must never be retried");
      assert.deepEqual(sleep.calls, [], "no backoff may be scheduled after the relay started");
      // The proxy itself must still be alive and serving (the old retry path
      // died here on ERR_HTTP_HEADERS_SENT).
      const again = await request(proxy.port, { body: "{}" });
      assert.equal(again.status, 200);
      assert.equal(again.body, "ok");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("socket reset while draining a retryable 503 body: exactly ONE retry chain, no crash", async () => {
    const upstream = await startRawUpstream((req, res, hit) => {
      if (hit === 1) {
        // Retryable status whose body never completes: the retry is scheduled
        // off the headers, then the drain gets reset mid-flight.
        res.writeHead(503, { "content-length": "1048576" });
        res.write("partial 503 body");
        setTimeout(() => res.socket.resetAndDestroy(), 20);
      } else {
        res.writeHead(200);
        res.end("recovered");
      }
    });
    const sleep = fakeSleep();
    const proxy = await startProxy({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
      sleep: sleep.fn,
    });
    try {
      const res = await request(proxy.port, { body: "{}" });
      assert.equal(res.status, 200);
      assert.equal(res.body, "recovered");
      assert.equal(res.headers["x-cr-retry-count"], "1");
      await settle(); // a duplicate (second) retry chain would land in this window
      assert.equal(upstream.hits(), 2, "the drain-phase reset must not start a second parallel retry chain");
      assert.deepEqual(sleep.calls, [1000], "exactly one backoff for exactly one retry");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

describe("idempotency: only provably-unprocessed connection errors retry", () => {
  test("ECONNRESET after the request was fully sent (no response yet) is NOT retried -> 502", async () => {
    const upstream = await startRawUpstream((req, res) => {
      // Full request consumed, then reset without answering: ambiguous — the
      // gateway may already have processed (and billed) the completion.
      setTimeout(() => req.socket.resetAndDestroy(), 10);
    });
    const sleep = fakeSleep();
    const proxy = await startProxy({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
      sleep: sleep.fn,
    });
    try {
      const res = await request(proxy.port, { body: '{"model":"m"}' });
      assert.equal(res.status, 502);
      assert.equal(res.headers["x-cr-retry-count"], "0", "no retries were performed");
      await settle();
      assert.equal(upstream.hits(), 1, "a post-send reset must reach upstream exactly once");
      assert.deepEqual(sleep.calls, [], "no backoff for a non-retryable error");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("a body over maxBufferBytes streams through: delivered byte-identical, retries disabled even on 503", async () => {
    // Count the body server-side without buffering 8 MiB in the double; a
    // retryable 503 answer proves status retries are off for streamed bodies.
    let seenBytes = 0;
    let hits = 0;
    const counting = http.createServer((req, res) => {
      hits += 1;
      req.on("data", (c) => (seenBytes += c.length));
      req.on("end", () => {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("busy");
      });
    });
    const countingPort = await listen(counting);
    const sleep = fakeSleep();
    const proxy = await startProxy({
      upstreamUrl: `http://127.0.0.1:${countingPort}/v1/chat/completions`,
      sleep: sleep.fn,
    });
    try {
      const body = Buffer.alloc(8 * 1024 * 1024 + 1024, "x"); // just over the 8 MiB default cap
      const res = await request(proxy.port, { body });
      assert.equal(res.status, 503, "the retryable status is relayed as-is — nothing kept to replay");
      assert.equal(res.body, "busy");
      assert.equal(res.headers["x-cr-retry-count"], "0");
      assert.equal(seenBytes, body.length, "the streamed body must arrive complete");
      await settle();
      assert.equal(hits, 1, "a streamed body must hit upstream exactly once");
      assert.deepEqual(sleep.calls, [], "retries are disabled for a streamed (unbuffered) body");
    } finally {
      await proxy.close();
      await new Promise((r) => counting.close(r));
    }
  });
});

describe("upstream timeout (black-hole gateway must fail fast, not hang)", () => {
  test("upstream accepts then never responds -> proxy faults fast (502) instead of hanging", async () => {
    // Accept the connection, consume the body, then go silent forever.
    const held = [];
    const blackhole = http.createServer((req, res) => {
      req.resume();
      held.push(res); // keep a ref so it is never garbage-collected / closed
    });
    const blackholePort = await listen(blackhole);
    const sleep = fakeSleep();
    const proxy = await startProxy({
      upstreamUrl: `http://127.0.0.1:${blackholePort}/v1/chat/completions`,
      sleep: sleep.fn,
      upstreamTimeoutMs: 250, // tiny cap: the fault must land well under capMs
    });
    try {
      // capMs (2s) >> the 250ms upstream timeout: a fixed proxy answers fast;
      // a hanging (unfixed) proxy would trip timedOut here.
      const outcome = await requestOutcome(proxy.port, { body: '{"model":"m"}' }, 2000);
      assert.equal(outcome.timedOut, false, "a black-hole upstream must fault fast, not hang the client");
      assert.equal(outcome.status, 502, "a post-send timeout with no response is surfaced as 502");
    } finally {
      for (const res of held) res.destroy();
      await proxy.close();
      await new Promise((r) => blackhole.close(r));
    }
  });
});

describe("client disconnect (OCR hangs up mid-relay)", () => {
  test("client aborts mid-relay: the in-flight upstream request is cancelled, and the proxy survives to serve the next request", async () => {
    let hits = 0;
    let firstUpstreamCut = false;
    const upstream = http.createServer((sreq, sres) => {
      hits += 1;
      if (hits === 1) {
        // Start relaying, then stall — the client aborts during the stream.
        sres.writeHead(200, { "content-type": "text/event-stream" });
        sres.write("data: partial\n\n");
        // If the proxy cancels the orphaned upstream call, THIS socket is cut
        // before it ever ends — that is the leak the fix must prevent.
        sres.on("close", () => {
          if (!sres.writableEnded) firstUpstreamCut = true;
        });
        // deliberately never end
      } else {
        sres.writeHead(200);
        sres.end("ok");
      }
    });
    const upstreamPort = await listen(upstream);
    const sleep = fakeSleep();
    const proxy = await startProxy({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
      sleep: sleep.fn,
    });
    try {
      // Fire a client request and abort it as soon as the relayed bytes arrive.
      await new Promise((resolve) => {
        const creq = http.request(
          { host: "127.0.0.1", port: proxy.port, path: "/v1/chat/completions", method: "POST" },
          (cres) => {
            cres.on("data", () => {
              creq.destroy(); // OCR hangs up mid-stream
              resolve();
            });
            cres.on("error", () => {});
          },
        );
        creq.on("error", () => {});
        creq.end("{}");
      });
      await settle(200); // let 'close' propagate and cancel the upstream call
      assert.equal(firstUpstreamCut, true, "an OCR disconnect must cancel the still-billing upstream request");
      assert.deepEqual(sleep.calls, [], "a disconnect must not schedule a retry");
      // The proxy itself must still be alive and serving.
      const again = await request(proxy.port, { body: "{}" });
      assert.equal(again.status, 200);
      assert.equal(again.body, "ok");
      assert.equal(hits, 2, "the follow-up request reached upstream as a fresh call");
    } finally {
      await proxy.close();
      await new Promise((r) => upstream.close(r));
    }
  });

  test("the CLI installs a process-level uncaughtException backstop that does not exit", () => {
    const src = readFileSync(PROXY_SCRIPT, "utf8");
    const cli = src.slice(src.indexOf("CLI entry"));
    assert.match(cli, /process\.on\(\s*["']uncaughtException["']/, "the proxy CLI must install an uncaughtException backstop");
    assert.doesNotMatch(cli, /uncaughtException[\s\S]*?process\.exit/, "the backstop must NOT exit — one bad client can't take the proxy down");
  });
});

describe("action.yml wiring (guardrail / firewall block comment)", () => {
  const actionYml = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "action.yml"), "utf8");

  test("the block comment is upserted by its own marker (not a new comment on every push)", () => {
    const yml = actionYml();
    const step = yml.slice(
      yml.indexOf("- name: Surface guardrail / firewall block"),
      yml.indexOf("- name: Promote tier"),
    );
    assert.match(step, /<!-- orca-code-review-block -->/, "the block comment needs an upsert marker");
    assert.match(step, /listComments/, "it must look for an existing block comment");
    assert.match(step, /updateComment/, "and edit it in place instead of piling up new ones");
  });

  test("a resumed clean review retires the stale block comment", () => {
    const yml = actionYml();
    const summary = yml.slice(yml.indexOf("- name: Summary (PR description)"), yml.indexOf("- name: Enforce severity gate"));
    assert.match(summary, /orca-code-review-block/, "the summary step must delete a stale block comment once reviews resume");
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
