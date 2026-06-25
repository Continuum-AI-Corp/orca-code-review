// Contract tests for gate.mjs — the cascade's decision primitive.
//
// The stateful cascade (action.yml) drives both the promotion choice and the
// merge gate purely off this script's exit code:
//   - promotion: `if gate --has $FIX_FIRST` is TRUE  -> stay on the cheap tier
//                                             FALSE -> promote PR to strong tier
//   - merge gate: `if gate --has $BLOCK_ON`  is TRUE  -> fail the check (block)
// So locking down these exit codes locks down the review-routing logic. Run
// these before changing anything about cascade/severity behavior.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "gate.mjs");
let dir;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gate-test-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Runs the gate against a result with the given comment bodies and returns the
// exit code (0 = at least one finding matches --has, 1 = none match / no input).
function gate(contents, has) {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  const comments = contents.map((content) => ({ content }));
  writeFileSync(file, JSON.stringify({ comments }));
  try {
    execFileSync("node", [GATE, file, "--has", has], { stdio: "pipe" });
    return 0;
  } catch (e) {
    return e.status;
  }
}

const FIX_FIRST = "P0,P1"; // severities that hold the PR on the cheap tier
const BLOCK_ON = "P0"; // severities that block the merge

describe("promotion decision (--has FIX_FIRST)", () => {
  test("P0 present -> match (stay on cheap tier, fix first)", () => {
    expect(gate(["[P0] sql injection", "[P2] use const"], FIX_FIRST)).toBe(0);
  });

  test("P1 present -> match (stay on cheap tier)", () => {
    expect(gate(["[P1] possible null deref"], FIX_FIRST)).toBe(0);
  });

  test("P2-only -> no match (promote PR to strong tier)", () => {
    expect(gate(["[P2] use const", "[P2] dead code"], FIX_FIRST)).toBe(1);
  });

  test("clean (no findings) -> no match (promote PR to strong tier)", () => {
    expect(gate([], FIX_FIRST)).toBe(1);
  });

  test("untagged finding -> treated as P1 (stay on cheap tier, fail-safe)", () => {
    expect(gate(["no severity tag, but a real bug"], FIX_FIRST)).toBe(0);
  });
});

describe("merge gate (--has BLOCK_ON)", () => {
  test("P0 present -> match (block the merge)", () => {
    expect(gate(["[P0] exposed secret"], BLOCK_ON)).toBe(0);
  });

  test("P1-only -> no match (gate passes)", () => {
    expect(gate(["[P1] race condition"], BLOCK_ON)).toBe(1);
  });

  test("untagged (P1 fail-safe) does not block on P0", () => {
    expect(gate(["untagged bug"], BLOCK_ON)).toBe(1);
  });
});

describe("robustness", () => {
  test("missing / unparseable file -> no match (exit 1), never crashes", () => {
    expect(() => {
      execFileSync("node", [GATE, join(dir, "does-not-exist.json"), "--has", "P0"], {
        stdio: "pipe",
      });
    }).toThrow(expect.objectContaining({ status: 1 }));
  });

  test("tag is case-insensitive", () => {
    expect(gate(["[p0] lowercase tag still counts"], BLOCK_ON)).toBe(0);
  });
});
