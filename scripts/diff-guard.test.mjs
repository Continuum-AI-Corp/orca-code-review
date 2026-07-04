// Contract tests for diff-guard.mjs — the oversized-diff skip decision.
//
// The guard runs BEFORE the review engine: on "skip" the driver (action.yml)
// posts a notice and passes the check without ever starting the engine.
// Decisions are DATA, not errors — the script always exits 0 (execFileSync
// throwing anywhere below would fail the test), and anything unreadable fails
// OPEN to "review" so a guard glitch can never silently disable the review.
//
// Limits: --max-kb (default 512) on byte size, --max-files (default 300) on
// `diff --git` headers. AT a limit still reviews; only strictly-over skips.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "diff-guard.mjs");
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "diff-guard-test-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Runs the guard and returns the parsed JSON decision. execFileSync throws on
// a nonzero exit, so every call also asserts the exit-0 contract.
function run(args) {
  return JSON.parse(execFileSync("node", [GUARD, ...args], { encoding: "utf8" }));
}

function writeDiff(content) {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.diff`);
  writeFileSync(file, content);
  return file;
}

// One well-formed single-file hunk (~90 bytes).
const fileBlock = (i) =>
  `diff --git a/f${i}.js b/f${i}.js\n` +
  `index 0000000..1111111 100644\n--- a/f${i}.js\n+++ b/f${i}.js\n@@ -1 +1 @@\n-old\n+new\n`;

describe("size threshold (--max-kb)", () => {
  test("under the limit -> review, with size and file count reported", () => {
    const out = run(["--diff", writeDiff(fileBlock(1)), "--max-kb", "1", "--max-files", "300"]);
    assert.equal(out.decision, "review");
    assert.equal(out.files, 1);
    assert.ok(out.size_kb > 0 && out.size_kb <= 1);
    assert.ok(out.reason.length > 0, "review decisions carry a reason too");
  });

  test("exactly AT the limit -> review (only strictly-over skips)", () => {
    const head = "diff --git a/a b/a\n";
    const pad = `+${"x".repeat(1024 - head.length - 2)}\n`;
    const content = head + pad;
    assert.equal(content.length, 1024, "fixture must be exactly 1 KB");
    const out = run(["--diff", writeDiff(content), "--max-kb", "1"]);
    assert.equal(out.decision, "review");
  });

  test("one byte over the limit -> skip, reason names the limit", () => {
    const head = "diff --git a/a b/a\n";
    const pad = `+${"x".repeat(1024 - head.length - 2)}\nx`;
    const content = head + pad;
    assert.equal(content.length, 1025, "fixture must be one byte over 1 KB");
    const out = run(["--diff", writeDiff(content), "--max-kb", "1"]);
    assert.equal(out.decision, "skip");
    assert.match(out.reason, /over the 1 KB limit/);
    assert.equal(out.files, 1);
  });
});

describe("file-count threshold (--max-files)", () => {
  test("exactly AT the limit -> review", () => {
    const out = run(["--diff", writeDiff(fileBlock(1) + fileBlock(2)), "--max-files", "2"]);
    assert.equal(out.decision, "review");
    assert.equal(out.files, 2);
  });

  test("over the limit -> skip, reason names the limit", () => {
    const out = run([
      "--diff",
      writeDiff(fileBlock(1) + fileBlock(2) + fileBlock(3)),
      "--max-files",
      "2",
    ]);
    assert.equal(out.decision, "skip");
    assert.equal(out.files, 3);
    assert.match(out.reason, /over the 2-file limit/);
  });

  test("only real `diff --git` headers count — content lines never do", () => {
    // In a unified diff every content line is prefixed (' ', '+', '-'), so a
    // header string INSIDE a change must not be counted as a file.
    const content =
      fileBlock(1) +
      `diff --git a/b.sh b/b.sh\n@@ -1 +1 @@\n-echo hi\n+diff --git a/fake b/fake\n`;
    const out = run(["--diff", writeDiff(content), "--max-files", "300"]);
    assert.equal(out.files, 2);
  });
});

describe("defaults (512 KB / 300 files)", () => {
  test("a >512 KB diff skips with no flags given", () => {
    const out = run(["--diff", writeDiff(`diff --git a/a b/a\n+${"x".repeat(513 * 1024)}\n`)]);
    assert.equal(out.decision, "skip");
    assert.match(out.reason, /over the 512 KB limit/);
  });

  test("301 files skips, 300 reviews, with no flags given", () => {
    let many = "";
    for (let i = 0; i < 301; i += 1) many += fileBlock(i);
    assert.equal(run(["--diff", writeDiff(many)]).decision, "skip");

    let exactly = "";
    for (let i = 0; i < 300; i += 1) exactly += fileBlock(i);
    assert.equal(run(["--diff", writeDiff(exactly)]).decision, "review");
  });

  test("a non-numeric limit falls back to its default instead of crashing", () => {
    const out = run(["--diff", writeDiff(fileBlock(1)), "--max-kb", "banana"]);
    assert.equal(out.decision, "review");
  });
});

describe("fail-open (malformed / empty input)", () => {
  test("empty diff -> review, with a fail-open reason", () => {
    const out = run(["--diff", writeDiff("")]);
    assert.equal(out.decision, "review");
    assert.match(out.reason, /failing open/);
    assert.equal(out.size_kb, 0);
    assert.equal(out.files, 0);
  });

  test("missing diff file -> review (exit 0), with a fail-open reason", () => {
    const out = run(["--diff", join(dir, "does-not-exist.diff")]);
    assert.equal(out.decision, "review");
    assert.match(out.reason, /failing open/);
  });

  test("no --diff at all -> review (exit 0), never crashes", () => {
    const out = run([]);
    assert.equal(out.decision, "review");
    assert.match(out.reason, /failing open/);
  });

  test("non-diff garbage content -> review with files: 0", () => {
    const out = run(["--diff", writeDiff("this is not a diff at all\njust some text\n")]);
    assert.equal(out.decision, "review");
    assert.equal(out.files, 0);
  });
});
