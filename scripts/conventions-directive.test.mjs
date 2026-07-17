// Pins the project-conventions directive wiring — a SECURITY property, so a
// refactor can't silently drop it. The directive points the engine at the
// repo's own AGENTS.md/CLAUDE.md for project conventions. That doc is
// attacker-controlled on a fork PR head, so we NEVER read the head copy:
// the driver extracts it from the BASE revision (merged, reviewed, immutable
// by the PR) via `git show "$BASE:<path>"` and inlines it into the background
// file, framed as untrusted data that can never weaken the review or change
// severity tags. Size is safe because we pass --background-file (a path), not
// an inline --background argv value.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(SCRIPTS, "..", rel), "utf8");

describe("project-conventions directive: base-revision extraction", () => {
  test("conventions are read from the BASE revision, not the PR head", () => {
    const yml = read("action.yml");
    // The doc is pulled from $BASE (origin/<base ref>) via git show — the
    // trusted base content — for the three accepted filenames in order.
    assert.match(
      yml,
      /for f in AGENTS\.md CLAUDE\.md CONTRIBUTING\.md; do/,
      "must try AGENTS.md, CLAUDE.md, CONTRIBUTING.md in order",
    );
    assert.match(yml, /git show "\$BASE:\$f"/, "must extract the doc from the base revision");
    // The head-trust gate is gone: no same_repo output, no SAME_REPO guard.
    assert.doesNotMatch(yml, /same_repo/, "the same_repo head gate must be removed");
    assert.doesNotMatch(yml, /SAME_REPO/, "the SAME_REPO guard must be removed");
  });

  test("the background is assembled into a file and inlined into --background", () => {
    const yml = read("action.yml");
    // The pinned engine (1.3.13) has no --background-file flag, so the assembled
    // file is passed inline. The base-revision doc is appended to that file
    // after the untrusted-data framing.
    assert.match(yml, /--background "\$\(cat "\$BACKGROUND"\)"/, "must pass the background inline (1.3.13 has no --background-file)");
    assert.doesNotMatch(yml, /--background-file "/, "must not invoke the unsupported --background-file flag");
    assert.match(yml, /cat "\$CONVENTIONS_DIRECTIVE"/, "the framing directive must precede the inlined doc");
    assert.match(yml, />> "\$BACKGROUND"/, "the doc must be appended to the background file");
  });

  test("conventions are only loaded when the PR targets the default branch", () => {
    const yml = read("action.yml");
    // A PR base is author-chosen; a push-access contributor could target a
    // branch holding a malicious AGENTS.md. The base is only a protected,
    // un-rewritable ref when it is the repo's default branch, so the doc is
    // gated on that. The pr step exports the boolean, the review step gates.
    assert.match(
      yml,
      /base_is_default', String\(base === context\.payload\.repository\.default_branch\)/,
      "the pr step must derive base_is_default from the repo default branch",
    );
    assert.match(yml, /BASE_IS_DEFAULT: \$\{\{ steps\.pr\.outputs\.base_is_default \}\}/, "must wire base_is_default into the env");
    assert.match(yml, /if \[ "\$BASE_IS_DEFAULT" = "true" \]/, "the conventions loop must gate on BASE_IS_DEFAULT");
  });

  test("the appended conventions doc is size-capped", () => {
    const yml = read("action.yml");
    // Guards the inline --background argv against an oversized base doc (E2BIG).
    assert.match(yml, /CONVENTIONS_MAX_BYTES=\d+/, "must define a byte cap");
    assert.match(yml, /head -c "\$CONVENTIONS_MAX_BYTES"/, "must truncate the doc to the byte cap");
  });

  test("the framing directive is appended before the base-revision doc", () => {
    const yml = read("action.yml");
    // Order matters: the untrusted-data framing must lead so the engine reads
    // the doc as reference data, not instructions. Assert the directive cat
    // precedes the BEGIN-doc marker within the append block.
    const directiveIdx = yml.indexOf('cat "$CONVENTIONS_DIRECTIVE"');
    const docBeginIdx = yml.indexOf("----- BEGIN %s");
    assert.ok(directiveIdx !== -1, "the directive must be catted into the background");
    assert.ok(docBeginIdx !== -1, "the doc must be delimited by a BEGIN marker");
    assert.ok(
      directiveIdx < docBeginIdx,
      "the framing directive must be appended before the base-revision doc",
    );
  });

  test("the directive frames the doc as untrusted and severity-preserving", () => {
    const md = read("rules/conventions-directive.md");
    assert.match(md, /untrusted/i, "must mark the conventions doc as untrusted data");
    assert.match(md, /never change how you review for correctness or security|NEVER change how you review/i);
    // Must forbid the doc from altering the severity tagging the whole pipeline greps.
    assert.match(md, /\[P0\]\/\[P1\]\/\[P2\]\/\[P3\]/);
    assert.match(md, /disregard that text|ignore/i);
  });
});
