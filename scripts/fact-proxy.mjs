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
// Env:
//   ORCAROUTER_URL  full upstream chat-completions URL (origin + path forwarded)
//   CR_FACTS_FILE   path to the JSON facts file the driver rewrites per pass
// On listen it prints `PROXY_URL=http://127.0.0.1:<port><upstream-path>` to
// stdout; the driver sets OCR_LLM_URL to that. Auth is forwarded untouched and
// never logged.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { URL } from "node:url";

const UPSTREAM = new URL(process.env.ORCAROUTER_URL || "https://api.orcarouter.ai/v1/chat/completions");
const upstreamLib = UPSTREAM.protocol === "http:" ? http : https;
const FACTS_FILE = process.env.CR_FACTS_FILE || "";
// Where to record a guardrail/firewall block so a later step can post it to the
// PR. The gateway returns these as structured 400s; OCR collapses them into an
// opaque CLI error, so the proxy is the only place that sees the real reason.
const POLICY_BLOCK_FILE = process.env.CR_POLICY_BLOCK_FILE || "";

// A guardrail (content policy) or firewall (tool-call policy) block arrives as
// HTTP 400 with `error.code = guardrail_blocked|firewall_blocked`. Persist the
// layer, policy name, and a regex-stripped reason; ignore any other 400.
function recordPolicyBlock(buf) {
  if (!POLICY_BLOCK_FILE) return;
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
      POLICY_BLOCK_FILE,
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
function readFacts() {
  if (!FACTS_FILE) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(FACTS_FILE, "utf8"));
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

const server = http.createServer((req, res) => {
  const headers = { ...req.headers };
  delete headers.host; // must match upstream, not the loopback proxy
  Object.assign(headers, readFacts());

  const target = new URL(req.url, UPSTREAM);
  const upReq = upstreamLib.request(
    target,
    { method: req.method, headers, host: UPSTREAM.host },
    (upRes) => {
      const status = upRes.statusCode || 502;
      // Buffer a 400 so we can read the guardrail/firewall reason, then relay
      // the identical bytes to OCR (which still fails closed). Everything else
      // streams straight through so SSE stays unbuffered.
      if (status === 400 && POLICY_BLOCK_FILE) {
        const chunks = [];
        upRes.on("data", (c) => chunks.push(c));
        upRes.on("end", () => {
          const body = Buffer.concat(chunks);
          recordPolicyBlock(body);
          res.writeHead(status, upRes.headers);
          res.end(body);
        });
        upRes.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        return;
      }
      res.writeHead(status, upRes.headers);
      upRes.pipe(res); // stream SSE through unbuffered
    },
  );
  upReq.on("error", (e) => {
    console.error(`fact-proxy: upstream error: ${e.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upReq); // forward the chat-completion payload
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  // OCR must POST to the upstream's path; only the origin is swapped for us.
  process.stdout.write(`PROXY_URL=http://127.0.0.1:${port}${UPSTREAM.pathname}\n`);
});
