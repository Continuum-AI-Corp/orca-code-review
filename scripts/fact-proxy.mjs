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
// Retry: transient upstream failures — HTTP 429/502/503/504 or a connection
// error — are retried up to 3 more attempts with 1s/2s/4s backoff; a numeric
// Retry-After header (seconds) wins, capped at 30s. To make replays safe the
// request body is fully buffered BEFORE the first attempt (the old code piped
// it upstream, and a consumed stream can't be replayed). Any other status —
// every other 4xx included — is never retried, and a final failure relays the
// upstream status/body unchanged. Every response carries x-cr-retry-count
// (retries actually performed) for observability.
//
// Env:
//   ORCAROUTER_URL  full upstream chat-completions URL (origin + path forwarded)
//   CR_FACTS_FILE   path to the JSON facts file the driver rewrites per pass
// On listen it prints `PROXY_URL=http://127.0.0.1:<port><upstream-path>` to
// stdout; the driver sets OCR_LLM_URL to that. Auth is forwarded untouched and
// never logged.
//
// Exported for tests: createProxyServer({ upstreamUrl, factsFile,
// policyBlockFile, sleep, maxRetries }) returns an unlistened http.Server —
// `sleep` is the injectable backoff seam. The CLI entry below keeps the
// original env-var + PROXY_URL contract; action.yml usage is unchanged.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { URL, pathToFileURL } from "node:url";

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const BACKOFF_MS = [1000, 2000, 4000];
const RETRY_AFTER_CAP_MS = 30_000;
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
} = {}) {
  const upstream = new URL(upstreamUrl);
  const upstreamLib = upstream.protocol === "http:" ? http : https;

  return http.createServer((req, res) => {
    const headers = { ...req.headers };
    delete headers.host; // must match upstream, not the loopback proxy
    Object.assign(headers, readFacts(factsFile));
    const target = new URL(req.url, upstream);

    // Buffer the request body fully BEFORE the first attempt: retries must
    // replay identical bytes, and a piped stream can only be consumed once.
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("error", () => {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      // The buffered body is replayed with its exact length; never forward the
      // client's transfer-encoding for a re-sent buffer.
      delete headers["transfer-encoding"];
      headers["content-length"] = String(body.length);

      // Relay the (final) upstream response. All relay paths stamp
      // x-cr-retry-count so a flaky gateway is visible in the job log.
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
      };

      const scheduleRetry = (nextRetries, ms) => {
        // A broken sleep must not strand the request — retry immediately then.
        Promise.resolve(sleep(ms)).then(
          () => attempt(nextRetries),
          () => attempt(nextRetries),
        );
      };

      // One upstream attempt; `retries` = retries already performed (0-based).
      const attempt = (retries) => {
        if (res.destroyed) return; // client gave up — nobody left to answer
        const upReq = upstreamLib.request(
          target,
          { method: req.method, headers, host: upstream.host },
          (upRes) => {
            const status = upRes.statusCode || 502;
            if (RETRYABLE_STATUS.has(status) && retries < maxRetries) {
              upRes.resume(); // drain and discard — this response is not relayed
              const ms = retryDelayMs(retries, upRes.headers["retry-after"]);
              console.error(
                `fact-proxy: upstream ${status} — retry ${retries + 1}/${maxRetries} in ${ms}ms`,
              );
              scheduleRetry(retries + 1, ms);
              return;
            }
            relay(upRes, status, retries);
          },
        );
        upReq.on("error", (e) => {
          if (retries < maxRetries) {
            const ms = retryDelayMs(retries, undefined);
            console.error(
              `fact-proxy: upstream error (${e.message}) — retry ${retries + 1}/${maxRetries} in ${ms}ms`,
            );
            scheduleRetry(retries + 1, ms);
            return;
          }
          console.error(`fact-proxy: upstream error: ${e.message}`);
          if (!res.headersSent) res.writeHead(502, { "x-cr-retry-count": String(retries) });
          res.end();
        });
        upReq.end(body);
      };

      attempt(0);
    });
  });
}

// ---- CLI entry (contract unchanged): env-driven, prints PROXY_URL on listen.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const upstream = new URL(
    process.env.ORCAROUTER_URL || "https://api.orcarouter.ai/v1/chat/completions",
  );
  const server = createProxyServer({
    upstreamUrl: upstream.href,
    factsFile: process.env.CR_FACTS_FILE || "",
    policyBlockFile: process.env.CR_POLICY_BLOCK_FILE || "",
  });
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    // OCR must POST to the upstream's path; only the origin is swapped for us.
    process.stdout.write(`PROXY_URL=http://127.0.0.1:${port}${upstream.pathname}\n`);
  });
}
