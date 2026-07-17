// Pins the project-conventions directive wiring — a SECURITY property, so a
// refactor can't silently drop it. The directive points the engine at the
// repo's own AGENTS.md/CLAUDE.md for project conventions, but that doc lives in
// the PR head checkout: on a FORK PR it is attacker-controlled. So the directive
// must (1) only ride --background on same-repo PRs, gated by the `same_repo`
// output the `pr` step derives from head/base repo identity, and (2) frame the
// doc as untrusted data that can never weaken the review or change severity tags.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(SCRIPTS, "..", rel), "utf8");

describe("project-conventions directive: fork-injection gate", () => {
  test("the pr step derives same_repo from head/base repo full_name", () => {
    const yml = read("action.yml");
    assert.match(yml, /core\.setOutput\('same_repo'/, "pr step must publish a same_repo output");
    // Both event paths must resolve head.repo full_name (fork detection).
    assert.match(yml, /head\.repo && context\.payload\.pull_request\.head\.repo\.full_name/);
    assert.match(yml, /pr\.head\.repo && pr\.head\.repo\.full_name/);
  });

  test("the directive is appended to --background ONLY when SAME_REPO is true", () => {
    const yml = read("action.yml");
    assert.match(
      yml,
      /if \[ "\$SAME_REPO" = "true" \] && \[ -s "\$CONVENTIONS_DIRECTIVE" \]; then/,
      "the conventions directive must be guarded by SAME_REPO == true",
    );
    // The guard must wrap the concatenation, not sit beside an unconditional one.
    assert.match(yml, /cat "\$BACKGROUND" "\$CONVENTIONS_DIRECTIVE" > "\$COMBINED_BG"/);
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
