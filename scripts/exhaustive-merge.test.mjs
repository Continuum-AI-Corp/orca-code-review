// Contract tests for exhaustive-merge.mjs — the deterministic half of
// exhaustive mode.
//
// The loop driver (action.yml) re-runs the engine up to 2 extra times per
// tier and calls this script after each pass:
//
//   node exhaustive-merge.mjs --base <a.json> --new <b.json> --out <merged.json>
//
// It merges the two comment arrays, deduping by (file, effective line,
// normalized content): lowercase, whitespace collapsed, the LEADING severity
// tag stripped before comparison — so "[P2] Null   deref" and "[p1] null
// deref" on the same line are ONE finding (models re-tag and re-space the
// same issue across passes), while a different file or line is genuinely new.
// Base order is preserved, new findings append in their own order, and stdout
// is exactly {"new_findings":N} — the loop continues only while N > 0.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const MERGE = join(dirname(fileURLToPath(import.meta.url)), "exhaustive-merge.mjs");
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "exhaustive-merge-test-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const comment = (path, line, content) => ({ path, start_line: line, end_line: line, content });

// Writes both results, runs the merge, and returns {stdout-parsed, merged}.
// execFileSync throws on a nonzero exit, so every call asserts the exit-0
// contract too.
function runMerge(baseResult, newResult) {
  const id = Math.random().toString(36).slice(2);
  const base = join(dir, `${id}-base.json`);
  const fresh = join(dir, `${id}-new.json`);
  const out = join(dir, `${id}-merged.json`);
  if (baseResult !== undefined) {
    writeFileSync(base, typeof baseResult === "string" ? baseResult : JSON.stringify(baseResult));
  }
  if (newResult !== undefined) {
    writeFileSync(fresh, typeof newResult === "string" ? newResult : JSON.stringify(newResult));
  }
  const stdout = execFileSync("node", [MERGE, "--base", base, "--new", fresh, "--out", out], {
    encoding: "utf8",
  });
  return {
    counts: JSON.parse(stdout),
    merged: JSON.parse(readFileSync(out, "utf8")),
  };
}

describe("dedup key: file + line + normalized content", () => {
  test("identical comments collapse — 0 new findings, base kept verbatim", () => {
    const base = { comments: [comment("a.js", 3, "[P1] null deref on user")] };
    const r = runMerge(base, { comments: [comment("a.js", 3, "[P1] null deref on user")] });
    assert.deepEqual(r.counts, { new_findings: 0 });
    assert.deepEqual(r.merged.comments, base.comments);
  });

  test("whitespace and case variants collapse", () => {
    const r = runMerge(
      { comments: [comment("a.js", 3, "[P1] Null deref on user")] },
      { comments: [comment("a.js", 3, "[P1]  null   DEREF on\nuser")] },
    );
    assert.deepEqual(r.counts, { new_findings: 0 });
    assert.equal(r.merged.comments.length, 1);
  });

  test("severity-tag variants collapse (tag stripped before hashing) — the base's tag wins", () => {
    const r = runMerge(
      { comments: [comment("a.js", 3, "[P2] null deref on user")] },
      { comments: [comment("a.js", 3, "[P0] null deref on user")] },
    );
    assert.deepEqual(r.counts, { new_findings: 0 });
    assert.equal(r.merged.comments[0].content, "[P2] null deref on user");
  });

  test("a genuinely-new finding is counted and appended AFTER the base (order preserved)", () => {
    const r = runMerge(
      { comments: [comment("a.js", 3, "[P1] null deref"), comment("b.js", 7, "[P2] dead code")] },
      { comments: [comment("a.js", 3, "[P1] null deref"), comment("c.js", 9, "[P0] sql injection")] },
    );
    assert.deepEqual(r.counts, { new_findings: 1 });
    assert.deepEqual(
      r.merged.comments.map((c) => c.path),
      ["a.js", "b.js", "c.js"],
    );
  });

  test("same content on a DIFFERENT file or line is new, not a dupe", () => {
    const r = runMerge(
      { comments: [comment("a.js", 3, "[P1] null deref")] },
      { comments: [comment("a.js", 4, "[P1] null deref"), comment("b.js", 3, "[P1] null deref")] },
    );
    assert.deepEqual(r.counts, { new_findings: 2 });
    assert.equal(r.merged.comments.length, 3);
  });

  test("the effective line matches the posting rule (end_line, else start_line)", () => {
    // Same finding, once as a range ending at 5 and once as a bare line 5.
    const ranged = { path: "a.js", start_line: 2, end_line: 5, content: "[P1] race condition" };
    const bare = { path: "a.js", start_line: 5, end_line: 0, content: "[P1] race condition" };
    const r = runMerge({ comments: [ranged] }, { comments: [bare] });
    assert.deepEqual(r.counts, { new_findings: 0 });
  });

  test("duplicates INSIDE the new result collapse to one appended finding", () => {
    const r = runMerge(
      { comments: [] },
      { comments: [comment("a.js", 1, "[P2] use const"), comment("a.js", 1, "[p2] use   const")] },
    );
    assert.deepEqual(r.counts, { new_findings: 1 });
    assert.equal(r.merged.comments.length, 1);
  });
});

describe("merged output shape", () => {
  test("engine-shaped: the base's sibling keys survive; comment objects pass through untouched", () => {
    const base = { comments: [comment("a.js", 3, "[P1] null deref")], warnings: [] };
    const fresh = { comments: [comment("b.js", 1, "[P2] naming")], warnings: ["ignored — base wins"] };
    const r = runMerge(base, fresh);
    assert.deepEqual(r.merged.warnings, [], "sibling keys come from --base");
    assert.deepEqual(r.merged.comments[1], fresh.comments[0]);
  });

  test("empty inputs: empty+empty -> 0; empty base takes every new finding", () => {
    assert.deepEqual(runMerge({ comments: [] }, { comments: [] }).counts, { new_findings: 0 });
    const r = runMerge(
      { comments: [] },
      { comments: [comment("a.js", 1, "[P0] a"), comment("b.js", 2, "[P1] b")] },
    );
    assert.deepEqual(r.counts, { new_findings: 2 });
    assert.equal(r.merged.comments.length, 2);
  });
});

describe("robustness", () => {
  test("unreadable --new keeps the base and reports 0 (the loop stops safely), exit 0", () => {
    const base = { comments: [comment("a.js", 3, "[P1] null deref")] };
    const r = runMerge(base, undefined); // new file never written
    assert.deepEqual(r.counts, { new_findings: 0 });
    assert.deepEqual(r.merged.comments, base.comments);
  });

  test("unreadable --base adopts the new result (all findings count as new), exit 0", () => {
    const r = runMerge(undefined, { comments: [comment("a.js", 1, "[P0] a")] });
    assert.deepEqual(r.counts, { new_findings: 1 });
    assert.equal(r.merged.comments.length, 1);
  });

  test("bad usage (missing --base/--new/--out) exits 2 — a wiring bug must be loud", () => {
    for (const args of [
      [],
      ["--base", join(dir, "a.json"), "--new", join(dir, "b.json")], // no --out
      ["--base", join(dir, "a.json"), "--out", join(dir, "c.json")], // no --new
    ]) {
      const r = spawnSync("node", [MERGE, ...args], { encoding: "utf8" });
      assert.equal(r.status, 2, `args ${JSON.stringify(args)} must exit 2`);
    }
  });
});

// The exhaustive loop lives in action.yml's `run_review()` bash function, which
// drives up to two EXTRA engine passes on the strong tier. Extra depth is
// best-effort — a benign tooling/merge failure must warn+break and keep the
// findings already in hand (round-2's guarantee) — but a guardrail/firewall
// POLICY BLOCK on an extra pass is FATAL: OrcaRouter stopped the request before
// the model, and the always() "Surface guardrail / firewall block" step will
// post a "merge is blocked" comment, so the required check MUST fail closed too
// (not go green). Extract the REAL run_review and drive it with stubbed
// run_pass/node so the failure branch is exercised exactly as written.
describe("action.yml: exhaustive extra-pass failure handling (run_review)", () => {
  const actionYml = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "action.yml"), "utf8");

  // run_review's body has no nested braces (only for/if/case), so a non-greedy
  // match to the first brace-only line captures the whole function.
  function extractRunReview() {
    const m = actionYml().match(/run_review\(\) \{[\s\S]*?\n[ \t]*\}/);
    assert.ok(m, "run_review must exist in action.yml");
    return m[0];
  }

  // mode: policy | benign | merge. The stub run_pass makes the PRIMARY pass
  // (into $RESULT) succeed with one finding; the EXTRA pass (into $RESULT_EXTRA)
  // either records a policy block + fails (policy), fails with no block
  // (benign), or succeeds so the following merge can fail (merge). node() stubs
  // $GATE (always "no fix-first in hand" so the loop reaches the extra pass) and
  // $MERGE (fails only in merge mode).
  function runExhaustion(mode) {
    const id = Math.random().toString(36).slice(2);
    const RESULT = join(dir, `${id}-result.json`);
    const RESULT_EXTRA = join(dir, `${id}-extra.json`);
    const RESULT_MERGED = join(dir, `${id}-merged.json`);
    const POLICY_BLOCK = join(dir, `${id}-policy-block.json`);
    const PRIMARY = '{"comments":[{"path":"a.js","start_line":1,"end_line":1,"content":"[P2] primary finding"}],"warnings":[]}';
    const stubs = `
run_pass() {
  if [ "$1" = "$RESULT" ]; then
    printf '%s' '${PRIMARY}' > "$1"
    return 0
  fi
  case "$EXTRA_MODE" in
    policy) printf '{"kind":"guardrail","policyName":"pii"}' > "$POLICY_BLOCK"; return 1 ;;
    benign) return 1 ;;
    merge)  printf '{"comments":[],"warnings":[]}' > "$1"; return 0 ;;
  esac
}
node() {
  case "$1" in
    "$GATE")  return 1 ;;
    "$MERGE") if [ "$EXTRA_MODE" = "merge" ]; then return 1; fi; printf '{"new_findings":0}'; return 0 ;;
    -pe)      printf '0'; return 0 ;;
  esac
}
`;
    const script =
      `set -eo pipefail\n${extractRunReview()}\n${stubs}\n` +
      `run_review "strong (escalation)" "cheap" "false" true\n` +
      `echo "SURVIVED passes=$PASSES"\n`;
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        EXHAUSTIVE: "true",
        BRAND: "TestBrand",
        RESULT, RESULT_EXTRA, RESULT_MERGED, POLICY_BLOCK,
        GATE: "/stub/gate.mjs",
        MERGE: "/stub/merge.mjs",
        FIX_FIRST: "P0,P1",
        EXTRA_MODE: mode,
      },
    });
    return { r, RESULT, POLICY_BLOCK };
  }

  test("an extra-pass POLICY BLOCK fails the job closed (not swallowed as a warning)", () => {
    const { r } = runExhaustion("policy");
    assert.equal(r.status, 1, `a policy block must fail closed; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout + r.stderr, /blocked by a guardrail\/firewall policy/);
    assert.doesNotMatch(r.stdout, /SURVIVED/, "the step must not continue past a policy block");
  });

  test("an extra-pass BENIGN failure (no policy block) warns, breaks, and keeps the findings so far", () => {
    const { r, RESULT } = runExhaustion("benign");
    assert.equal(r.status, 0, `a benign extra-pass failure must not fail the job; stderr=${r.stderr}`);
    assert.match(r.stdout, /SURVIVED/, "exhaustion must end gracefully");
    assert.match(r.stdout + r.stderr, /produced no usable result/);
    const kept = JSON.parse(readFileSync(RESULT, "utf8"));
    assert.equal(kept.comments.length, 1, "the primary finding must survive");
  });

  test("an extra-pass MERGE failure warns, breaks, and keeps the findings so far (round-2 guarantee)", () => {
    const { r, RESULT } = runExhaustion("merge");
    assert.equal(r.status, 0, `a merge/tooling failure must not fail the job; stderr=${r.stderr}`);
    assert.match(r.stdout, /SURVIVED/);
    assert.match(r.stdout + r.stderr, /merge failed/);
    const kept = JSON.parse(readFileSync(RESULT, "utf8"));
    assert.equal(kept.comments.length, 1, "the primary finding must survive a merge failure");
  });
});
