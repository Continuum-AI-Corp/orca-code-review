// Shared severity parsing for the Orca-Code-Review scripts.
//
// One module owns the rule "which severity is this finding?" so the merge gate
// (gate.mjs), the control-plane run report (report.mjs), and the PR summary
// comment (summary-comment.mjs) can never drift apart:
//
//   - Only a LEADING [P0]/[P1]/[P2] tag counts (case-insensitive). A tag
//     mentioned later in prose or a code example must not override the
//     fail-safe below, otherwise an untagged finding could promote a PR and
//     slip past P0/P1 gating.
//   - An untagged finding defaults to P1 (fail-safe): the model is instructed
//     to tag every comment, and a missing tag must escalate for another look
//     rather than pass as advisory.

export const SEVERITIES = ["P0", "P1", "P2"];

// Severity of one `ocr review --format json` comment.
export function severityOf(comment) {
  const m = String(comment?.content || "").match(/^\s*\[(P[012])\]/i);
  return m ? m[1].toUpperCase() : "P1";
}

// {P0: n, P1: n, P2: n} for a result's comments array — always all three keys,
// zeroed, so consumers can render/report counts without existence checks.
export function countSeverities(comments) {
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const c of Array.isArray(comments) ? comments : []) counts[severityOf(c)] += 1;
  return counts;
}
