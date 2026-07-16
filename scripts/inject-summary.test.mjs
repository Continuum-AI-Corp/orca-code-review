// Contract tests for inject-summary.mjs — the PR-description merge primitive.
//
// The bot edits every consuming repo's PR description on every push, so the
// author-text-preservation and in-place-replace behavior is load-bearing:
// a bug here silently mangles users' PR descriptions. Lock it down.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  injectSummary,
  extractRegion,
  REGION_START,
  REGION_END,
} from "./inject-summary.mjs";

const SUMMARY = "<!-- orca-code-review-summary -->\n## Orca-Code-Review — push 1\n\n✅ no blocking findings";

describe("injectSummary", () => {
  test("prepends the region to the top on first insert, keeping author text below", () => {
    const body = "My PR does a thing.\n\n- item one\n- item two";
    const out = injectSummary(body, SUMMARY);
    assert.ok(out.startsWith(REGION_START), "region must be first");
    assert.ok(out.includes(SUMMARY), "summary markdown preserved verbatim");
    assert.ok(out.includes("My PR does a thing."), "author text preserved");
    assert.ok(out.indexOf(REGION_END) < out.indexOf("My PR does a thing."), "author text sits below the region");
  });

  test("preserves the author's leading whitespace verbatim on first insert", () => {
    const body = "    indented code block\n\nprose after";
    const out = injectSummary(body, SUMMARY);
    assert.ok(out.startsWith(REGION_START), "region still first");
    assert.ok(out.includes(`\n\n${body}`), "author body prepended verbatim, indentation intact");
  });

  test("a whitespace-only body collapses to region only (no author text to keep)", () => {
    assert.equal(injectSummary("   \n\n  ", SUMMARY), `${REGION_START}\n${SUMMARY}\n${REGION_END}`);
  });

  test("replaces an existing region in place without touching author text or position", () => {
    const body = `Intro line.\n\n${REGION_START}\nOLD SUMMARY\n${REGION_END}\n\nTrailing author notes.`;
    const out = injectSummary(body, SUMMARY);
    assert.ok(!out.includes("OLD SUMMARY"), "old summary gone");
    assert.ok(out.includes(SUMMARY), "new summary present");
    assert.ok(out.startsWith("Intro line."), "region position preserved (not moved to top)");
    assert.ok(out.includes("Trailing author notes."), "trailing author text preserved");
    assert.equal(out.match(new RegExp(REGION_START, "g")).length, 1, "exactly one region after replace");
  });

  test("re-injecting is idempotent in structure (no region accumulation, no blank-line growth)", () => {
    const body = "Author body.";
    const once = injectSummary(body, SUMMARY);
    const twice = injectSummary(once, SUMMARY);
    assert.equal(once, twice, "second identical inject is a no-op");
    assert.equal(twice.match(new RegExp(REGION_START, "g")).length, 1, "still one region");
  });

  test("handles null/empty body — region only, no leading blank lines", () => {
    assert.equal(injectSummary(null, SUMMARY), `${REGION_START}\n${SUMMARY}\n${REGION_END}`);
    assert.equal(injectSummary("", SUMMARY), `${REGION_START}\n${SUMMARY}\n${REGION_END}`);
  });

  test("trims trailing whitespace off the summary before wrapping", () => {
    const out = injectSummary(null, `${SUMMARY}\n\n\n`);
    assert.equal(out, `${REGION_START}\n${SUMMARY}\n${REGION_END}`);
  });
});

describe("extractRegion", () => {
  test("returns null when there is no region", () => {
    assert.equal(extractRegion("just author text"), null);
    assert.equal(extractRegion(null), null);
  });

  test("round-trips the injected summary so --prev / push-counter parsing works", () => {
    const out = injectSummary("author", SUMMARY);
    assert.equal(extractRegion(out), SUMMARY);
  });

  test("recovers the machine-state line the next push reads to number itself", () => {
    const withState =
      "<!-- orca-code-review-summary -->\n<!-- orca-cr-state: {\"p0\":0,\"p1\":1,\"p2\":2,\"push\":3} -->\n\n## Orca-Code-Review — push 3";
    const region = extractRegion(injectSummary("x", withState));
    const m = region.match(/<!-- orca-cr-state: (\{.*?\}) -->/);
    assert.ok(m, "state line survives the round-trip");
    assert.equal(JSON.parse(m[1]).push, 3);
  });
});
