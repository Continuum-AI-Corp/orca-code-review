// Unit tests for severity.mjs — the ONE place that owns "which severity is
// this finding?". gate.mjs (merge gate / promotion), report.mjs (control-plane
// counts) and summary-comment.mjs (PR summary) all consume it, so these tests
// pin the two rules they must share:
//   1. only a LEADING [P0]/[P1]/[P2] tag counts (case-insensitive);
//   2. an untagged finding defaults to P1 (fail-safe — escalate, don't pass).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { SEVERITIES, severityOf, countSeverities } from "./severity.mjs";

describe("severityOf", () => {
  test("reads the leading tag", () => {
    assert.equal(severityOf({ content: "[P0] sql injection" }), "P0");
    assert.equal(severityOf({ content: "[P2] use const" }), "P2");
  });

  test("is case-insensitive and tolerates leading whitespace", () => {
    assert.equal(severityOf({ content: "[p0] lowercase" }), "P0");
    assert.equal(severityOf({ content: "  [P2] indented" }), "P2");
  });

  test("untagged -> P1 fail-safe", () => {
    assert.equal(severityOf({ content: "no tag, real bug" }), "P1");
  });

  test("a tag mentioned later must NOT override the fail-safe", () => {
    assert.equal(severityOf({ content: "see the [P2] example below" }), "P1");
  });

  test("missing/odd content never crashes", () => {
    assert.equal(severityOf({}), "P1");
    assert.equal(severityOf(undefined), "P1");
    assert.equal(severityOf({ content: 42 }), "P1");
  });
});

describe("countSeverities", () => {
  test("always returns all three keys, zeroed", () => {
    assert.deepEqual(countSeverities([]), { P0: 0, P1: 0, P2: 0 });
    assert.deepEqual(countSeverities(undefined), { P0: 0, P1: 0, P2: 0 });
  });

  test("counts by leading tag with the P1 fail-safe", () => {
    const counts = countSeverities([
      { content: "[P0] a" },
      { content: "[p1] b" },
      { content: "untagged" },
      { content: "[P2] c" },
      { content: "[P2] d" },
    ]);
    assert.deepEqual(counts, { P0: 1, P1: 2, P2: 2 });
  });

  test("SEVERITIES lists P0/P1/P2 in display order", () => {
    assert.deepEqual(SEVERITIES, ["P0", "P1", "P2"]);
  });
});
