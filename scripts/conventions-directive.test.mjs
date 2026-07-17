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

  test("the background is passed as a file, and the doc is inlined into it", () => {
    const yml = read("action.yml");
    // --background-file (a path) sidesteps the argv size limit that inline
    // --background "$(cat …)" hit on large docs.
    assert.match(yml, /--background-file "\$BACKGROUND"/, "must invoke with --background-file");
    assert.doesNotMatch(yml, /--background "\$\(cat "\$BACKGROUND"\)"/, "must not inline the background via argv");
    // The extracted doc is appended after the untrusted-data framing.
    assert.match(yml, /cat "\$CONVENTIONS_DIRECTIVE"/, "the framing directive must precede the inlined doc");
    assert.match(yml, />> "\$BACKGROUND"/, "the doc must be appended to the background file");
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
