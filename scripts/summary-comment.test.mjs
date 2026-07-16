// Contract tests for summary-comment.mjs — the single edit-in-place PR
// summary comment.
//
// The structure is load-bearing: the driver (action.yml) upserts the comment
// by the MARKER line, and the NEXT run parses the orca-cr-state line out of
// the previous body for the push counter and the Δ column. These tests pin:
// marker first, state JSON round-trips, table rows for P0/P1/P2/P3 always
// present (even at 0), delta math including negative deltas, the three
// tier-state lines, and the gate line.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const SUMMARY = join(dirname(fileURLToPath(import.meta.url)), "summary-comment.mjs");
const MARKER = "<!-- orca-code-review-summary -->";
const STATE_RE = /<!-- orca-cr-state: (\{.*?\}) -->/;
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "summary-test-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Renders the comment for a result with the given comment bodies. `prevBody`
// (a previous comment body, usually a previous run() output) enables the Δ column.
function run(contents, flags, prevBody) {
  const id = Math.random().toString(36).slice(2);
  const resultFile = join(dir, `${id}.json`);
  writeFileSync(resultFile, JSON.stringify({ comments: contents.map((content) => ({ content })) }));
  const args = [SUMMARY, resultFile, ...flags];
  if (prevBody !== undefined) {
    const prevFile = join(dir, `${id}-prev.md`);
    writeFileSync(prevFile, prevBody);
    args.push("--prev", prevFile);
  }
  return execFileSync("node", args, { encoding: "utf8" });
}

describe("marker and machine state", () => {
  test("marker is the very first line; state JSON round-trips (untagged -> P1)", () => {
    const out = run(["[P0] a", "untagged bug"], ["--tier", "cheap", "--push", "1", "--gate", "blocked"]);
    assert.equal(out.split("\n")[0], MARKER);
    const m = out.match(STATE_RE);
    assert.ok(m, "state line must be present");
    assert.deepEqual(JSON.parse(m[1]), { p0: 1, p1: 1, p2: 0, push: 1 });
  });

  test("header names the push number", () => {
    const out = run([], ["--tier", "strong", "--push", "4", "--gate", "pass"]);
    assert.match(out, /## Orca-Code-Review — push 4/);
  });
});

describe("severity table", () => {
  test("P0/P1/P2/P3 rows are always present, even at 0 — and no Δ column without --prev", () => {
    const out = run([], ["--tier", "strong", "--push", "1", "--gate", "pass"]);
    assert.ok(out.includes("| Severity | Count |"));
    assert.ok(out.includes("| P0 | 0 |"));
    assert.ok(out.includes("| P1 | 0 |"));
    assert.ok(out.includes("| P2 | 0 |"));
    assert.ok(out.includes("| P3 | 0 |"));
    assert.ok(!out.includes("Δ"), "no Δ column when there is no previous state");
  });

  test("Δ vs previous push: negative, positive, and zero deltas", () => {
    // push 1: p0:1 p1:2 p2:1 -> push 2: p0:0 p1:3 p2:1
    const push1 = run(
      ["[P0] a", "[P1] b", "[P1] c", "[P2] d"],
      ["--tier", "cheap", "--push", "1", "--gate", "blocked"],
    );
    const push2 = run(
      ["[P1] x", "[P1] y", "[P1] z", "[P2] w"],
      ["--tier", "cheap", "--push", "2", "--gate", "blocked"],
      push1,
    );
    assert.ok(push2.includes("| Severity | Count | Δ vs previous push |"));
    assert.ok(push2.includes("| P0 | 0 | -1 |"), "negative delta");
    assert.ok(push2.includes("| P1 | 3 | +1 |"), "positive delta");
    assert.ok(push2.includes("| P2 | 1 | 0 |"), "zero delta");
    assert.deepEqual(JSON.parse(push2.match(STATE_RE)[1]), { p0: 0, p1: 3, p2: 1, push: 2 });
  });

  test("a previous body without a parseable state line just omits the Δ column", () => {
    const out = run(
      ["[P2] nit"],
      ["--tier", "strong", "--push", "3", "--gate", "pass"],
      "some earlier comment with no state marker",
    );
    assert.ok(!out.includes("Δ"));
    assert.ok(out.includes("| P2 | 1 |"));
  });
});

describe("tier-state line", () => {
  test("cheap + blocked -> held", () => {
    const out = run(["[P0] a"], ["--tier", "cheap", "--push", "1", "--gate", "blocked"]);
    assert.match(out, /Tier: CHEAP — held \(fix P0\/P1 first/);
  });

  test("cheap + pass -> escalating to STRONG this run", () => {
    const out = run(["[P2] nit"], ["--tier", "cheap", "--push", "1", "--gate", "pass"]);
    assert.match(out, /Tier: escalating to STRONG this run/);
  });

  test("strong -> final pass, with the gate outcome", () => {
    const pass = run([], ["--tier", "strong", "--push", "2", "--gate", "pass"]);
    assert.match(pass, /Tier: STRONG \(final pass\) — pass/);
    const blocked = run(["[P0] a"], ["--tier", "strong", "--push", "2", "--gate", "blocked"]);
    assert.match(blocked, /Tier: STRONG \(final pass\) — blocked/);
  });
});

describe("gate line", () => {
  test("blocked -> ❌ with the blocking (P0+P1) count", () => {
    const out = run(
      ["[P0] a", "[P1] b", "[P2] c"],
      ["--tier", "strong", "--push", "1", "--gate", "blocked"],
    );
    assert.ok(out.includes("❌ 2 findings block merge"));
  });

  test("blocked with a single finding reads singular", () => {
    const out = run(["[P0] a"], ["--tier", "strong", "--push", "1", "--gate", "blocked"]);
    assert.ok(out.includes("❌ 1 finding blocks merge"));
  });

  test("pass -> ✅ no blocking findings", () => {
    const out = run(["[P2] nit"], ["--tier", "strong", "--push", "1", "--gate", "pass"]);
    assert.ok(out.includes("✅ no blocking findings"));
  });

  test("--block-on P2: the blocking count follows the configured set, not a hardcoded P0+P1", () => {
    const out = run(
      ["[P0] a", "[P2] b", "[P2] c"],
      ["--tier", "strong", "--push", "1", "--gate", "blocked", "--block-on", "P2"],
    );
    assert.ok(out.includes("❌ 2 findings block merge"), `got:\n${out}`);
  });

  test("--block-on accepts a CSV set and normalizes case/whitespace", () => {
    const out = run(
      ["[P1] a", "[P2] b", "[P2] c"],
      ["--tier", "strong", "--push", "1", "--gate", "blocked", "--block-on", " p1 , p2 "],
    );
    assert.ok(out.includes("❌ 3 findings block merge"));
  });

  test("an empty --block-on ('block on nothing') renders the ✅ pass wording", () => {
    const out = run(
      ["[P0] a", "[P1] b"],
      ["--tier", "strong", "--push", "1", "--gate", "pass", "--block-on", ""],
    );
    assert.ok(out.includes("✅ no blocking findings"));
  });

  test("no --block-on keeps the default P0+P1 count (back-compat)", () => {
    const out = run(
      ["[P0] a", "[P1] b", "[P1] c", "[P2] d"],
      ["--tier", "strong", "--push", "1", "--gate", "blocked"],
    );
    assert.ok(out.includes("❌ 3 findings block merge"));
  });

  test("an unknown severity in --block-on exits 2 — a wiring bug must be loud", () => {
    const r = spawnSync(
      "node",
      [SUMMARY, join(dir, "x.json"), "--tier", "strong", "--push", "1", "--gate", "pass", "--block-on", "P0,P5"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 2);
  });
});

describe("held run (cheap tier withheld escalation on fix-first findings)", () => {
  test("held + empty --block-on: the ❌ count follows the FIX-FIRST set, never the contradictory '0 findings'", () => {
    const out = run(
      ["[P0] a", "[P1] b", "[P2] c"],
      // block_on='' would make the block-on count 0; --held must count fix-first (P0+P1=2).
      ["--tier", "cheap", "--push", "1", "--gate", "blocked", "--block-on", "", "--held", "--fix-first", "P0,P1"],
    );
    assert.match(out, /Tier: CHEAP — held/, `held tier line expected:\n${out}`);
    assert.ok(out.includes("❌ 2 findings block merge"), `held count must be over fix-first, got:\n${out}`);
    assert.ok(!out.includes("❌ 0 findings"), "a held run must never render the self-contradictory 0-count");
  });

  test("held count uses fix-first even when block-on covers different severities", () => {
    const out = run(
      ["[P0] a", "[P1] b"],
      ["--tier", "cheap", "--push", "1", "--gate", "blocked", "--block-on", "P2", "--held", "--fix-first", "P0,P1"],
    );
    assert.ok(out.includes("❌ 2 findings block merge"), `got:\n${out}`);
  });

  test("a single held finding reads singular", () => {
    const out = run(
      ["[P0] only"],
      ["--tier", "cheap", "--push", "1", "--gate", "blocked", "--block-on", "", "--held", "--fix-first", "P0,P1"],
    );
    assert.ok(out.includes("❌ 1 finding blocks merge"), `got:\n${out}`);
  });

  test("non-held behavior is unchanged: the count still follows --block-on", () => {
    const out = run(
      ["[P0] a", "[P2] b", "[P2] c"],
      ["--tier", "strong", "--push", "1", "--gate", "blocked", "--block-on", "P2"],
    );
    assert.ok(out.includes("❌ 2 findings block merge"), `got:\n${out}`);
  });

  test("an unknown severity in --fix-first exits 2 — a wiring bug must be loud", () => {
    const r = spawnSync(
      "node",
      [SUMMARY, join(dir, "x.json"), "--tier", "cheap", "--push", "1", "--gate", "blocked", "--held", "--fix-first", "P0,P9"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 2);
  });
});

describe("mode notes (exhaustive / quiet)", () => {
  test("--passes > 1 renders the exhaustive note; state JSON is unchanged", () => {
    const out = run(["[P0] a"], ["--tier", "strong", "--push", "2", "--gate", "blocked", "--passes", "3"]);
    assert.ok(out.includes("exhaustive: 3 passes"));
    assert.deepEqual(JSON.parse(out.match(STATE_RE)[1]), { p0: 1, p1: 0, p2: 0, push: 2 });
  });

  test("--passes 1 (and no --passes at all) renders NO exhaustive note", () => {
    const explicit = run([], ["--tier", "strong", "--push", "1", "--gate", "pass", "--passes", "1"]);
    assert.ok(!explicit.includes("exhaustive"));
    const absent = run([], ["--tier", "strong", "--push", "1", "--gate", "pass"]);
    assert.ok(!absent.includes("exhaustive"));
  });

  test("--quiet renders the P2 note next to the TRUE counts", () => {
    const out = run(
      ["[P0] a", "[P2] nit"],
      ["--tier", "strong", "--push", "1", "--gate", "blocked", "--quiet"],
    );
    assert.ok(out.includes("quiet mode: P2 shown in summary only"));
    assert.ok(out.includes("| P2 | 1 |"), "the summary must keep the true P2 count");
  });

  test("no --quiet -> no quiet note", () => {
    const out = run(["[P2] nit"], ["--tier", "strong", "--push", "1", "--gate", "pass"]);
    assert.ok(!out.includes("quiet mode"));
  });

  test("a non-numeric or sub-1 --passes exits 2 — a wiring bug must be loud", () => {
    for (const passes of ["zero", "0", "-1"]) {
      const r = spawnSync(
        "node",
        [SUMMARY, join(dir, "x.json"), "--tier", "strong", "--push", "1", "--gate", "pass", "--passes", passes],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 2, `--passes ${passes} must exit 2`);
    }
  });
});

describe("robustness", () => {
  test("unreadable result.json still renders (zero counts), exit 0", () => {
    const r = spawnSync(
      "node",
      [SUMMARY, join(dir, "missing.json"), "--tier", "strong", "--push", "1", "--gate", "pass"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("| P0 | 0 |"));
  });

  test("bad usage (missing/invalid flags) exits 2 — a wiring bug must be loud", () => {
    for (const args of [
      [],
      ["--tier", "cheap", "--push", "1"], // no --gate
      ["--tier", "mid", "--push", "1", "--gate", "pass"], // bad tier
      ["--tier", "cheap", "--push", "zero", "--gate", "pass"], // bad push
    ]) {
      const r = spawnSync("node", [SUMMARY, join(dir, "x.json"), ...args], { encoding: "utf8" });
      assert.equal(r.status, 2, `args ${JSON.stringify(args)} must exit 2`);
    }
  });
});
