#!/usr/bin/env node
// Merge the Orca-Code-Review summary into the PR DESCRIPTION body.
//
// GitHub orders PR issue comments chronologically with no pin-to-top API, so a
// summary posted as a comment sinks below the inline findings and is hard to
// find. The PR description body is the only element anchored at the very top,
// so the summary lives there instead — inside a marker-delimited region that is
// replaced in place on every push, leaving the author's own text untouched.
//
// This module is the pure merge primitive (no network). The action.yml driver
// reads the current body via pulls.get, calls injectSummary(), and writes the
// result back via pulls.update. Kept separate + unit-tested because the
// author-text-preservation logic is the risky part (the bot edits every
// consuming repo's PR description).
//
//   REGION_START ... REGION_END wraps the exact markdown scripts/summary-comment.mjs
//   already emits (including its own <!-- orca-code-review-summary --> marker +
//   machine-state line), so the push counter / Δ column keep working unchanged.

export const REGION_START = "<!-- orca-cr-summary:start -->";
export const REGION_END = "<!-- orca-cr-summary:end -->";

// Matches the whole region non-greedily, including a single trailing newline so
// repeated injects don't accumulate blank lines between the region and author text.
const REGION_RE = new RegExp(
  `${REGION_START}[\\s\\S]*?${REGION_END}\\n?`,
);

// Return the summary markdown currently stored in body's region, or null if the
// body has no region yet. The driver feeds this to summary-comment.mjs --prev
// (for the Δ column) and reads its machine-state line to number the next push.
export function extractRegion(body) {
  const m = String(body ?? "").match(
    new RegExp(`${REGION_START}\\n?([\\s\\S]*?)\\n?${REGION_END}`),
  );
  return m ? m[1] : null;
}

// Return a new body with the summary region set to `summaryMd`. If the body
// already has a region, replace it IN PLACE (keeps its position — normally the
// top). Otherwise PREPEND it, so the summary is anchored at the very top on the
// first push; the author's existing text follows below, separated by a blank line.
export function injectSummary(body, summaryMd) {
  const region = `${REGION_START}\n${summaryMd.trimEnd()}\n${REGION_END}`;
  const current = String(body ?? "");
  if (REGION_RE.test(current)) {
    return current.replace(REGION_RE, `${region}\n`);
  }
  // Preserve the author's body verbatim (leading whitespace may be meaningful —
  // an indented code block, nested list). trim() only decides whether there is
  // any author text to keep below the region; it never rewrites what we prepend.
  return current.trim() ? `${region}\n\n${current}` : region;
}
