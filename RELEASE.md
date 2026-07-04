# Releasing

## The `@v1` tag must track the endpoints it depends on

The setup-generated workflow and the README quickstart pin
`uses: Continuum-AI-Corp/orca-code-review@v1`. The `settings`, `report`,
`on-oversized-diff`, `auto-review-authors`, and diff-guard features depend on
gateway control-plane endpoints (`/api/code_review/settings`,
`/api/code_review/report`) **and** on the `scripts/settings.mjs` /
`scripts/report.mjs` this action ships.

**Release order matters.** If `@v1` points at a commit that predates these
scripts, a user who follows the quickstart gets working reviews but a
silently inert Settings tab (settings never fetched) and empty Analytics
(runs never reported) — no error, just two dead console tabs.

When cutting a release from a merged feature branch:

1. Merge the feature branch to `main` (the branch that includes
   `scripts/settings.mjs`, `scripts/report.mjs`, and the current
   `action.yml`).
2. Deploy the gateway (OrcaRouter-O2) so the control-plane endpoints are live.
3. Tag the merged commit and **move the floating `v1` tag to it**:
   ```
   git tag -f v1.<n> <merged-sha>     # immutable release
   git tag -f v1     <merged-sha>     # floating major that the workflow pins
   git push --force origin v1 v1.<n>
   ```
4. Verify: `git ls-tree v1 scripts/` lists `settings.mjs` and `report.mjs`,
   and `git show v1:action.yml` contains the "Fetch review settings" and
   "Report run" steps.

Until the tag is moved, do not advertise the new inputs under `@v1`. For
pre-release dogfooding, pin an immutable commit SHA (as OrcaRouter-O2's own
`.github/workflows/orcarouter-code-review.yml` does) rather than `@v1`.

## Marketplace

Publish/refresh the GitHub Marketplace listing from the same merged commit as
a verified publisher; the listing's default install snippet must match the
README quickstart (including `@v1` once moved).
