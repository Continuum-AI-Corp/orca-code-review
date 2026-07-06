#!/usr/bin/env node
// In-job fact-injecting proxy for the OrcaRouter Code Review cascade.
//
// OCR can only send the auth header (x-api-key / authorization) — it has no way
// to attach custom headers. But the routing DSL routes on `headers[...]`. This
// tiny loopback proxy bridges the gap: OCR talks to it (OCR_LLM_URL points
// here), it stamps the cascade's raw-fact headers, and forwards everything —
// including SSE streams — to the real OrcaRouter endpoint.
//
// It is ephemeral: bound to 127.0.0.1 on an OS-assigned port, lives only for
// the duration of one Actions job, and dies with it. Nothing is deployed.
//
// The facts are re-read from CR_FACTS_FILE on EVERY request, so the driver can
// flip them between the cheap pass and the in-run strong escalation without
// restarting the proxy. The file is a flat JSON object of header->value; an
// absent/empty/unparseable file stamps nothing (the DSL falls through to its
// default, i.e. the cheap tier).
//
// Retry: transient upstream failures are retried up to 3 more attempts with
// 1s/2s/4s backoff; a numeric Retry-After header (seconds) wins, capped at
// 30s. WHAT is retryable is deliberately narrow, because a replayed chat
// completion is not idempotent — a duplicate can double-bill:
//   - HTTP 429/502/503/504: a response was received, so the gateway owned the
//     request and answered "not processed" — safe to replay. No other status
//     is ever retried (every other 4xx included).
//   - Connection errors ONLY when they prove the upstream never began
//     processing: ECONNREFUSED / ENOTFOUND / EAI_AGAIN (the connection or name
//     lookup never came up), or any error raised BEFORE the request body
//     finished flushing. An ECONNRESET after the body was fully sent (and
//     before any response) is ambiguous — the gateway may already have
//     consumed and billed the request — so it is surfaced as 502, NOT replayed.
//   - Once a response has started relaying to the client, NOTHING is retried:
//     the response headers are already out, so a mid-stream failure destroys
//     the client connection (fail fast) instead of re-attempting.
// To make replays safe the request body is buffered BEFORE the first attempt,
// capped at 8 MiB: a larger body streams straight through with ALL retries
// disabled for that request (nothing is kept to replay; memory stays bounded).
// A final failure relays the upstream status/body unchanged (502 for a
// connection error). Every response carries x-cr-retry-count (retries actually
// performed) for observability.
//
// Timeout: each upstream attempt is capped (default 120s, CR_UPSTREAM_TIMEOUT_MS
// / the upstreamTimeoutMs opt override it) so a black-hole gateway (accepts the
// TCP connection, never answers) fails fast into the SAME error handler instead
// of hanging until OCR's own timeout. A pre-response timeout is classified like
// any pre-send connection error (retried only if the body hadn't finished
// flushing — replay stays idempotency-safe); a timeout after the relay started
// tears the client stream down and never retries.
//
// Resilience: the client (OCR) can vanish at any time. A 'close' before the
// response finished cancels the in-flight upstream request (an OCR disconnect
// must not leak a still-billing completion) and blocks any pending retry from
// dialing again; a client-side 'error' is caught (a write to a dead socket must
// not throw an unhandled EPIPE); and the CLI installs a process-level
// uncaughtException backstop that logs and keeps serving — one bad client can
// never take the proxy down mid-job.
//
// Env:
//   ORCAROUTER_URL          full upstream chat-completions URL (origin + path forwarded)
//   CR_FACTS_FILE           path to the JSON facts file the driver rewrites per pass
//   CR_UPSTREAM_TIMEOUT_MS  optional per-attempt upstream timeout (ms; default 120000)
// On listen it prints `PROXY_URL=http://127.0.0.1:<port><upstream-path>` to
// stdout; the driver sets OCR_LLM_URL to that. Auth is forwarded untouched and
// never logged.
//
// Exported for tests: createProxyServer({ upstreamUrl, factsFile,
// policyBlockFile, sleep, maxRetries, maxBufferBytes }) returns an unlistened
// http.Server — `sleep` is the injectable backoff seam and `maxBufferBytes`
// the retry-buffer cap. The CLI entry below keeps the original env-var +
// PROXY_URL contract; action.yml usage is unchanged.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { URL, pathToFileURL } from "node:url";

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
// Connection-error codes that PROVE the request never reached processing:
// name resolution or the TCP connect itself failed, so no bytes of the
// request were ever consumed upstream. Everything else is judged by whether
// the request body had finished flushing when the error fired.
const PRE_PROCESSING_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const BACKOFF_MS = [1000, 2000, 4000];
const RETRY_AFTER_CAP_MS = 30_000;
// Bodies above this stream straight through (single attempt, no retries):
// buffering arbitrarily large bodies for replay would unbound the proxy's
// memory on a shared runner.
const MAX_RETRY_BUFFER_BYTES = 8 * 1024 * 1024;
// A gateway that accepts the connection but never responds (a black hole) must
// not hang the whole job — cap each upstream attempt and let the error handler
// classify the timeout like any other pre/post-response failure.
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A guardrail (content policy) or firewall (tool-call policy) block arrives as
// HTTP 400 with `error.code = guardrail_blocked|firewall_blocked`. Persist the
// layer, policy name, and a regex-stripped reason; ignore any other 400.
function recordPolicyBlock(buf, policyBlockFile) {
  if (!policyBlockFile) return;
  let code, message;
  try {
    const j = JSON.parse(buf.toString("utf8"));
    code = j?.error?.code;
    message = j?.error?.message || "";
  } catch {
    return;
  }
  if (code !== "guardrail_blocked" && code !== "firewall_blocked") return;
  const kind = code === "guardrail_blocked" ? "guardrail" : "firewall";
  const nameMatch = message.match(
    /blocked by (?:guardrail|firewall(?: policy)?)\s+"([^"]+)"/i,
  );
  const idMatch = message.match(/\(request id:\s*([^)]+)\)/i);
  // Strip the parts the comment renders separately (policy name, request id),
  // collapse the verbose regex fragments, then dedupe identical reasons so a
  // two-rule match doesn't read as "a configured rule; a configured rule".
  let detail = message
    .replace(/^.*?blocked by (?:guardrail|firewall(?: policy)?)\s+"[^"]+":\s*/i, "")
    .replace(/\s*\(request id:[^)]*\)/i, "")
    .replace(/regex\(matched pattern "[\s\S]*?"\)/gi, "a configured rule")
    .trim();
  detail = [...new Set(detail.split(/;\s*/).map((s) => s.trim()).filter(Boolean))].join("; ");
  try {
    fs.writeFileSync(
      policyBlockFile,
      JSON.stringify({
        kind,
        policyName: nameMatch ? nameMatch[1] : null,
        requestId: idMatch ? idMatch[1].trim() : null,
        detail: detail || null,
      }),
    );
  } catch {
    /* best-effort: a missing block comment is acceptable; the job still fails closed */
  }
}

// Only x-cr-* facts are injectable; never let the file smuggle auth or other
// headers in. Matches the gateway's own x-cr-* convention (not on any denylist).
function readFacts(factsFile) {
  if (!factsFile) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(factsFile, "utf8"));
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const lk = String(k).toLowerCase();
      if (lk.startsWith("x-cr-") && v !== undefined && v !== "") out[lk] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

// Delay before the (retryIndex+1)-th retry: a numeric Retry-After (seconds,
// capped at 30s) wins; otherwise the fixed 1s/2s/4s schedule. An HTTP-date
// Retry-After is deliberately ignored — clock math is not worth it here.
function retryDelayMs(retryIndex, retryAfter) {
  if (retryAfter !== undefined) {
    const s = String(retryAfter).trim();
    if (/^\d+$/.test(s)) return Math.min(Number(s) * 1000, RETRY_AFTER_CAP_MS);
  }
  return BACKOFF_MS[Math.min(retryIndex, BACKOFF_MS.length - 1)];
}

export function createProxyServer({
  upstreamUrl,
  factsFile = "",
  policyBlockFile = "",
  sleep = defaultSleep,
  maxRetries = 3,
  maxBufferBytes = MAX_RETRY_BUFFER_BYTES,
  upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
} = {}) {
  const upstream = new URL(upstreamUrl);
  const upstreamLib = upstream.protocol === "http:" ? http : https;

  return http.createServer((req, res) => {
    const headers = { ...req.headers };
    delete headers.host; // must match upstream, not the loopback proxy
    Object.assign(headers, readFacts(factsFile));
    // Identify the relay traffic to the gateway as OrcaRouter Code Review, not
    // the underlying OCR engine's default User-Agent — so the gateway's request
    // logs / client-app attribution show the product. Set AFTER the spread so it
    // overrides whatever the engine sent.
    headers["user-agent"] = "orca-code-review";
    const target = new URL(req.url, upstream);

    // The upstream request currently in flight for THIS client request (the
    // buffered attempt or the streaming variant), so a client disconnect can
    // cancel it. `clientGone` latches that disconnect so no scheduled retry
    // dials upstream again once OCR has hung up.
    let activeUpReq = null;
    let clientGone = false;

    // The client (OCR) socket can die at any moment. Without an 'error' sink a
    // write to a half-open socket throws an unhandled EPIPE/ECONNRESET and
    // would crash the whole proxy — log and drop instead.
    res.on("error", (e) => {
      console.error(`fact-proxy: client connection error (${e.message}) — dropping`);
      res.destroy();
    });
    // OCR hung up before we finished answering: the upstream call is now
    // orphaned. Cancel it so a disconnect can't leak a still-billing
    // completion, and stop any pending retry from starting a fresh one. A
    // normal completion also fires 'close', but with writableEnded already set
    // (nothing left in flight), so it is a no-op.
    res.on("close", () => {
      if (res.writableEnded) return;
      clientGone = true;
      if (activeUpReq && !activeUpReq.destroyed) {
        activeUpReq.destroy(new Error("client disconnected"));
      }
    });

    // Terminal failure for one client request. Before the relay: answer 502.
    // After it: the headers are out, so destroy the connection — a truncated
    // stream must error out fast, not leave OCR waiting until the job timeout.
    const failResponse = (retries) => {
      if (clientGone || res.writableEnded) return; // client already gone — nobody to answer
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "x-cr-retry-count": String(retries) });
      res.end();
    };

    // Relay the (final) upstream response — the point of no return: the
    // status/headers go on the wire here, so from now on NOTHING may retry
    // (a second writeHead would throw ERR_HTTP_HEADERS_SENT and kill the
    // whole proxy). relay() only ever runs at a terminal settle, so no retry
    // can be scheduled after it. All relay paths stamp x-cr-retry-count so a
    // flaky gateway is visible in the job log.
    const relay = (upRes, status, retries) => {
      const outHeaders = { ...upRes.headers, "x-cr-retry-count": String(retries) };
      // Buffer a 400 so we can read the guardrail/firewall reason, then relay
      // the identical bytes to OCR (which still fails closed). Everything else
      // streams straight through so SSE stays unbuffered.
      if (status === 400 && policyBlockFile) {
        const parts = [];
        upRes.on("data", (c) => parts.push(c));
        upRes.on("end", () => {
          const buf = Buffer.concat(parts);
          recordPolicyBlock(buf, policyBlockFile);
          if (clientGone || res.writableEnded) return; // client left during the 400 buffer — nobody to answer
          res.writeHead(status, outHeaders);
          res.end(buf);
        });
        upRes.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        return;
      }
      res.writeHead(status, outHeaders);
      upRes.pipe(res); // stream SSE through unbuffered
      // pipe() forwards data, not errors — and http.IncomingMessage swallows
      // an unlistened 'error' entirely, so without this handler a mid-stream
      // upstream failure would leave `res` open forever (OCR would hang until
      // the job timeout). Fail fast instead.
      upRes.on("error", (e) => {
        console.error(`fact-proxy: upstream stream failed mid-relay (${e.message}) — dropping the client connection`);
        res.destroy();
      });
    };

    const scheduleRetry = (body, nextRetries, ms) => {
      // A broken sleep must not strand the request — retry immediately then.
      Promise.resolve(sleep(ms)).then(
        () => attempt(body, nextRetries),
        () => attempt(body, nextRetries),
      );
    };

    // One upstream attempt over the buffered body; `retries` = retries already
    // performed (0-based). The `settled` latch guarantees exactly ONE of
    // {relay, scheduleRetry, failResponse} runs per attempt: a socket reset
    // while draining a retryable-status body fires upReq 'error' AFTER the
    // status path already scheduled a retry, and without the latch that would
    // start a second parallel retry chain (two relays -> double writeHead).
    const attempt = (body, retries) => {
      if (clientGone || res.destroyed) return; // client gave up — nobody left to answer
      let settled = false;
      const settleThisAttempt = () => {
        if (settled) return false;
        settled = true;
        return true;
      };
      let bodySent = false; // request body fully flushed to the socket
      let relayedThisAttempt = false; // THIS attempt's response is the one relaying

      const upReq = upstreamLib.request(
        target,
        { method: req.method, headers, host: upstream.host },
        (upRes) => {
          const status = upRes.statusCode || 502;
          if (RETRYABLE_STATUS.has(status) && retries < maxRetries) {
            if (!settleThisAttempt()) return;
            // Drain and discard — this response is not relayed. The drain
            // needs its own 'error' sink so a reset mid-drain is just noise
            // (the retry below is already scheduled and owns the outcome).
            upRes.on("error", (e) => {
              console.error(`fact-proxy: discarded ${status} response errored while draining (${e.message})`);
            });
            upRes.resume();
            const ms = retryDelayMs(retries, upRes.headers["retry-after"]);
            console.error(
              `fact-proxy: upstream ${status} — retry ${retries + 1}/${maxRetries} in ${ms}ms`,
            );
            scheduleRetry(body, retries + 1, ms);
            return;
          }
          if (!settleThisAttempt()) return;
          relayedThisAttempt = true;
          relay(upRes, status, retries);
        },
      );
      activeUpReq = upReq;
      // Fail fast on a black-hole gateway: destroying the request routes the
      // timeout through the SAME upReq 'error' handler below, so a pre-response
      // timeout is classified exactly like a pre-send connection error (retried
      // only when the body hadn't finished flushing — replay stays idempotent-
      // safe) and a post-relay timeout tears the stream down without retrying.
      upReq.setTimeout(upstreamTimeoutMs, () => {
        upReq.destroy(new Error(`upstream timeout after ${upstreamTimeoutMs}ms`));
      });
      upReq.on("error", (e) => {
        if (!settleThisAttempt()) {
          // This attempt's outcome is already owned elsewhere. If it was owned
          // by THIS attempt's relay, the stream just died mid-relay — fail the
          // client fast rather than hanging. If it was owned by a scheduled
          // retry (a drain-phase reset on a discarded 429/5xx body), do
          // nothing: the fresh attempt must not be disturbed.
          if (relayedThisAttempt) res.destroy();
          return;
        }
        // Retry ONLY errors that prove the upstream never began processing
        // (see the header): a replayed completion is not idempotent, and a
        // reset after the body was fully sent may already have been billed.
        const preProcessing = PRE_PROCESSING_CODES.has(e.code) || !bodySent;
        if (retries < maxRetries && preProcessing) {
          const ms = retryDelayMs(retries, undefined);
          console.error(
            `fact-proxy: upstream error (${e.message}) — retry ${retries + 1}/${maxRetries} in ${ms}ms`,
          );
          scheduleRetry(body, retries + 1, ms);
          return;
        }
        console.error(
          `fact-proxy: upstream error: ${e.message}${
            retries < maxRetries ? " (after the request was sent — not retried)" : ""
          }`,
        );
        failResponse(retries);
      });
      upReq.end(body, () => {
        bodySent = true;
      });
    };

    // Buffer the request body BEFORE the first attempt: retries must replay
    // identical bytes, and a piped stream can only be consumed once. The
    // buffer is capped: a body over maxBufferBytes flips to a single
    // pass-through attempt with retries disabled (see startStreaming).
    const chunks = [];
    let buffered = 0;
    let streaming = false;
    let streamReq = null;

    const startStreaming = () => {
      streaming = true;
      console.error(
        `fact-proxy: request body exceeds ${maxBufferBytes} bytes — streaming through, retries disabled (nothing is kept to replay)`,
      );
      // The body streams through byte-identical, so the client's own
      // content-length (if any) is still correct; without one Node re-chunks.
      delete headers["transfer-encoding"];
      const upReq = upstreamLib.request(
        target,
        { method: req.method, headers, host: upstream.host },
        (upRes) => {
          relay(upRes, upRes.statusCode || 502, 0);
        },
      );
      // Same black-hole guard as the buffered path; a streamed body can't be
      // replayed, so any error (incl. this timeout) fails closed, never retries.
      upReq.setTimeout(upstreamTimeoutMs, () => {
        upReq.destroy(new Error(`upstream timeout after ${upstreamTimeoutMs}ms`));
      });
      upReq.on("error", (e) => {
        console.error(`fact-proxy: upstream error (streamed body is unreplayable — not retried): ${e.message}`);
        failResponse(0);
      });
      streamReq = upReq;
      activeUpReq = upReq;
      for (const c of chunks) upReq.write(c);
      chunks.length = 0;
      req.pipe(upReq); // pipe ends upReq when the client body ends
    };

    req.on("data", (c) => {
      if (streaming) return; // the pipe carries everything from here on
      chunks.push(c);
      buffered += c.length;
      if (buffered > maxBufferBytes) startStreaming();
    });
    req.on("error", (e) => {
      if (streamReq) streamReq.destroy(e); // stop the upstream copy of a broken client body
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
    req.on("end", () => {
      if (streaming) return; // completion is the pipe's job now
      const body = Buffer.concat(chunks);
      // The buffered body is replayed with its exact length; never forward the
      // client's transfer-encoding for a re-sent buffer.
      delete headers["transfer-encoding"];
      headers["content-length"] = String(body.length);
      attempt(body, 0);
    });
  });
}

// ---- CLI entry (contract unchanged): env-driven, prints PROXY_URL on listen.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Backstop: one misbehaving client (a mid-write EPIPE, a socket destroyed
  // under us) must NEVER take the whole proxy down mid-job — every request
  // already fails closed on its own path. Log and keep serving; do NOT exit.
  // Registered only for the real proxy process, so importing the factory into
  // tests never masks their uncaught errors.
  process.on("uncaughtException", (e) => {
    console.error(`fact-proxy: uncaught exception (kept alive): ${e && e.stack ? e.stack : e}`);
  });

  const upstream = new URL(
    process.env.ORCAROUTER_URL || "https://api.orcarouter.ai/v1/chat/completions",
  );
  const envTimeout = Number(process.env.CR_UPSTREAM_TIMEOUT_MS);
  const server = createProxyServer({
    upstreamUrl: upstream.href,
    factsFile: process.env.CR_FACTS_FILE || "",
    policyBlockFile: process.env.CR_POLICY_BLOCK_FILE || "",
    ...(Number.isFinite(envTimeout) && envTimeout > 0 ? { upstreamTimeoutMs: envTimeout } : {}),
  });
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    // OCR must POST to the upstream's path; only the origin is swapped for us.
    process.stdout.write(`PROXY_URL=http://127.0.0.1:${port}${upstream.pathname}\n`);
  });
}
