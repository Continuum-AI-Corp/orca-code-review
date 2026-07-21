# Orca-Code-Review

AI pull-request review powered by the [OrcaRouter](https://orcarouter.ai) model
gateway. A cheap model screens every push; once a push comes back clear of
serious (P0/P1) issues, a strong model makes the final pass. Findings post as
inline PR comments, tagged by severity, and a configurable gate can block the
merge.

## What it does

1. **Stateful cost-tiered cascade** — each PR stores its current tier as an
   `orca-review:strong` label, both tiers routed through OrcaRouter. A PR starts
   on the cheap tier (no label). If the cheap model finds any **P0/P1**, those are
   serious — the PR stays on the cheap tier so you fix them first (no point
   paying for the strong tier while obvious bugs remain). When a cheap pass comes
   back with nothing worse than **P2**, the action **escalates to the strong
   model in the same run** (so the strong tier always reviews before merge) and
   records a **permanent promotion** via the label, so every later push goes
   straight to the strong model. The action names **no models**: it decides the
   tier and emits it as raw facts (`x-cr-prev-tier` / `x-cr-prev-p0p1`), which an
   in-job loopback proxy stamps as headers onto OCR's requests; the workspace
   **router's DSL recipe** maps those facts to the concrete cheap/strong model
   (see [`recipes/code-review.dsl.yaml`](./recipes/code-review.dsl.yaml) and
   [Configuration](#configuration)).
2. **Severity tagging** — every comment is prefixed `[P0]` / `[P1]` / `[P2]`
   (see rubric below). The tag mandate is layered onto OCR's built-in
   language/security review via `--background` (it adds to, never replaces,
   those checks) using `rules/severity-instruction.md`.
3. **Inline comments + one summary** — findings post on the exact lines of the
   PR, and a single summary — severity counts with a Δ against the previous
   push, the current tier, and the gate verdict — is written into the top of
   the PR description and refreshed in place on every push (so it stays pinned
   above the inline findings instead of sinking down the comment timeline).
4. **Merge gate** — the job fails if any **P0/P1** is found; mark the check
   "required" in branch protection to block the merge.
5. **Per-commit loop** — `synchronize` re-reviews on every new push; comment
   `/orca-code-review` on a PR to re-run on demand. The comment re-run posts
   fresh review comments but does **not** update the required merge-gate check:
   an `issue_comment` run is tied to the default branch, not the PR head, so its
   pass/fail can't attach to the PR's commit. Push a new commit to refresh the
   gate; use the comment command for an extra read, not to flip a red check
   green.
6. **Guardrail / firewall layer** — because every call goes through OrcaRouter on
   your key, any guardrail attached to that key runs **in parallel** with the
   model review at no extra token cost: secret/PII detection,
   prompt-injection/jailbreak rails, and code-security rules (plus optional
   external CVE scanners). This is OrcaRouter's own enforcement, not the model's —
   see [Setup](#setup-4-steps) step 2 to enable it.

## Setup (4 steps)

1. **Create the router that owns model selection.** In the OrcaRouter dashboard
   (Routers → New), create a router named **`code-review`** in your workspace and
   paste [`recipes/code-review.dsl.yaml`](./recipes/code-review.dsl.yaml) as its
   DSL. This is where the cheap/strong models live — edit the recipe to change
   them; the action references it by alias (`orcarouter/code-review`) and names
   no models itself. (Routers are per-workspace, so this is a one-time manual
   step the API key can't do for you.)

2. **Attach a guardrail to your key — the security + firewall layer.** The model
   review is one layer; OrcaRouter's guardrail/firewall runs on the **same key**,
   in parallel, at no extra token cost — secret/PII detection,
   prompt-injection/jailbreak rails, and code-security rules. **It only runs if
   the key has a guardrail attached** — a bare key gets the model review alone.
   In the OrcaRouter dashboard:
   1. **Guardrails → New** — create a policy. Start from the built-in presets
      (the **code-security** group ships free, pattern-based rails: `.env`/secret
      blocking, copyleft-license flagging, insecure-API advisories); add
      **secrets**, **PII**, and **prompt-injection** presets as needed.
   2. **Keys → edit your key → Guardrail** — select the policy you created (the
      dropdown's "Account default / none" falls back to your workspace default
      guardrail, if any).
   3. Prefer **flag / annotate** actions over **block** on a review key, so a
      finding annotates the PR instead of rejecting the request.
   - **Dependency CVE scanning** (OSV / Snyk / Semgrep) is *not* a preset — add
     it as an external **Connection** under Integrations, then reference it from
     a guardrail rule. OSV is free/public; Snyk and Semgrep need their own keys.

3. Add this workflow at **`.github/workflows/orcarouter-code-review.yml`**
   (copy from [`workflows/orcarouter-code-review.yml`](./workflows/orcarouter-code-review.yml)):

   ```yaml
   name: Orca-Code-Review
   on:
     pull_request_target:
       # ready_for_review makes the dashboard's trigger=ready_for_review mode
       # fire when a draft PR becomes ready.
       types: [opened, synchronize, ready_for_review]
     issue_comment:
       types: [created]
   permissions:
     contents: read
     pull-requests: write
     issues: write # label-based tier state + clean/fallback PR comments
   jobs:
     review:
       runs-on: ubuntu-latest
       # PR events, or a `/orca-code-review` command from a maintainer —
       # otherwise any commenter could spend your quota.
       if: |
         github.event_name == 'pull_request_target' ||
         (github.event_name == 'issue_comment' &&
           github.event.issue.pull_request &&
           startsWith(github.event.comment.body, '/orca-code-review') &&
           contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association))
       steps:
         - uses: Continuum-AI-Corp/orca-code-review@v1
           with:
             orcarouter-api-key: ${{ secrets.ORCAROUTER_API_KEY }}
   ```

4. Add a repository secret **`ORCAROUTER_API_KEY`** (Settings → Secrets and
   variables → Actions).

Open a PR — the review posts automatically. You never copy scripts or config;
bump the `@v1` tag to update.

## Configuration

All optional — pass as `with:` inputs on the action:

| Input | Default | Purpose |
|---|---|---|
| `orcarouter-api-key` | _(required)_ | OrcaRouter API key |
| `orcarouter-url` | `https://api.orcarouter.ai/v1/chat/completions` | Gateway endpoint |
| `brand` | `Orca-Code-Review` | Name shown on PR comments |
| `router` | `orcarouter/code-review` | OrcaRouter router alias whose DSL recipe picks the cheap/strong model per tier (the action names no models) |
| `fix-first` | `P0,P1` | Keep the PR on the cheap tier until these are cleared (then it's promoted) |
| `block-on` | `P0,P1` | Fail the check (block merge) on one of these |
| `max-diff-kb` | `512` | Skip the review when the merge-base diff is bigger than this many KB — a skip posts a notice without running the engine; the check's outcome is `on-oversized-diff` |
| `max-diff-files` | `300` | Skip the review (same notice + `on-oversized-diff` outcome) when the diff touches more than this many files |
| `on-oversized-diff` | `fail` | What an oversized-diff skip does to the check: `fail` (default) fails it, so a diff padded past the limits can never bypass a required merge gate; `pass` makes skips advisory (notice + green check) |
| `settings` | `true` | Fetch per-repo settings from the OrcaRouter dashboard on every run; set `"false"` to skip the fetch and make the workflow file authoritative (inputs/defaults apply as-is, no dashboard override) |
| `auto-review-authors` | `""` (everyone) | Comma-separated author-association allowlist for **automatic** reviews. Empty reviews every PR. On a **public** repo, set e.g. `OWNER,MEMBER,COLLABORATOR,CONTRIBUTOR` so anonymous fork PRs can't drain your wallet with paid cascades (they can still be reviewed on demand via `/orca-code-review`). See [Public repos & spend](SECURITY.md#public-repos--spend). |
| `report` | `true` | Send a per-run summary (severity counts only — never code) to the OrcaRouter control plane; set `"false"` to disable — see [Run reporting](#run-reporting) |
| `github-token` | `${{ github.token }}` | Token used to fetch the PR head, post review comments, and manage the tier label; override only if the default `GITHUB_TOKEN` lacks the needed scopes |
| `engine-version` | `1.3.13` | Pinned `@alibaba-group/open-code-review` version (the review engine); bump deliberately after testing — later steps parse its JSON output shape |

`fix-first` and `block-on` can also be set per-repo from the OrcaRouter
dashboard — see the precedence rule under
[Dashboard settings](#dashboard-settings-no-workflow-edits).

## Dashboard settings (no workflow edits)

At the start of every run the action fetches this repo's review settings from
your gateway (`GET <gateway origin>/api/code_review/settings?repo=owner/name`,
authenticated with your API key), so a reviewer can retune behavior from the
OrcaRouter dashboard without touching the workflow:

| Setting | Values (default first) | Effect in the Action |
|---|---|---|
| `auto_review` | `true` / `false` | `false`: automatic (`pull_request_target`) runs skip the engine, leave one small "automatic review is off" comment, and **pass** the check. `/orca-code-review` comment commands still run. |
| `trigger` | `every_push` / `ready_for_review` / `on_demand` | `every_push`: review every push. `ready_for_review`: skip automatic runs **while the PR is a draft** (add `ready_for_review` to your workflow's `pull_request_target.types` so the review fires when the PR leaves draft). `on_demand`: skip all automatic runs — only `/orca-code-review` comments review. All skips pass the check. |
| `exhaustive` | `false` / `true` | Re-run the engine up to **2 extra times on the strong (enforced) tier**, deduplicating findings across passes (one review pass is not exhaustive; a re-run surfaces missed findings). The cheap screening pass never gets extras — its result is either superseded by the same-run strong review or held on fix-first findings anyway. The loop stops early once a pass adds nothing new **or a fix-first (P0/P1) finding is already in hand** (the gate blocks on it regardless of extra depth). **Cost cap: at most 3 engine passes total on the enforced tier.** The summary comment notes `exhaustive: N passes`. |
| `quiet` | `false` / `true` | Advisory **P2 comments are not posted inline** — they are muted at the posting step only. The summary keeps the **true** P0/P1/P2 counts with a `quiet mode: P2 shown in summary only` note, and the gate/run report always see the unfiltered counts. |
| `fix_first` | `"P0,P1"` | Same meaning as the `fix-first` input — see precedence below. |
| `block_on` | `"P0,P1"` | Same meaning as the `block-on` input — see precedence below. |
| `rubric` | `""` | Non-empty: **replaces** the built-in `rules/severity-instruction.md` as the review instruction. A custom rubric MUST retain the mandate that every comment starts with a literal `[P0]`/`[P1]`/`[P2]` tag — the tiering, gate, and counts all parse it. (Untagged output is protected regardless: a missing tag falls back to P1, so it still escalates and blocks rather than slipping through.) |

**Precedence (`fix-first` / `block-on`):** an explicit `with:` input that
**differs** from the action's documented default (`"P0,P1"`) wins over the
server setting; an input left at (or set to) the default defers to the server.
So dashboard-managed repos just omit the inputs, and a workflow that pins
`block-on: "P0"` keeps that pin even if the dashboard says otherwise.

**Making the workflow file authoritative:** because a default-valued input
defers to the server, pinning the *documented default itself* (e.g.
`block-on: "P0,P1"`) cannot prevent a dashboard override. If the workflow file
must be the single source of truth, set `settings: "false"` on the action —
the fetch is skipped entirely, every input (or its documented default)
applies as-is, and none of the dashboard settings above (including
`auto_review` / `trigger` gating, `exhaustive`, `quiet`, and `rubric`) can
take effect.

**Everything fails open to the defaults.** If the settings endpoint is
unreachable, times out (5s, one retry), or returns garbage, the action logs it
and proceeds with the built-in defaults above — a settings outage never skips,
blocks, or fails a review. Invalid individual values (an unknown `trigger`, a
bad severity list) fall back field-by-field while the valid fields still apply.

## Severity rubric

| Tag | Meaning | Examples |
|---|---|---|
| **P0** | Blocker — must not merge | injection, XSS, `eval` on untrusted input, exposed secret, data loss, crash on a normal path, broken build |
| **P1** | High — fix before merge | null deref, unhandled async rejection, race condition, resource leak, missing boundary validation, wrong-result logic |
| **P2** | Advisory | dead code, duplication, naming, `any`, `==` vs `===`, `var`, nested ternaries, minor perf |

The rubric lives in `rules/severity-instruction.md` — edit it to retune what
counts as P0/P1/P2 for your codebase, or replace it per-repo from the
dashboard via the `rubric` setting (see
[Dashboard settings](#dashboard-settings-no-workflow-edits) — a replacement
rubric must keep the leading `[P0]`/`[P1]`/`[P2]` tag mandate).

## Run reporting

After each review pass the action POSTs a small run summary to your OrcaRouter
control plane (`<gateway origin>/api/code_review/report`, authenticated with
your API key): repo name, PR number, head SHA, tier (`cheap`/`strong`),
P0/P1/P2 counts, gate result, and engine version. **That's the whole payload —
no code, no diff, no finding text is ever sent.** (The diff itself only ever
goes to the model through the gateway, exactly as before.) Reporting is
best-effort — a control-plane outage can never fail the review — and can be
turned off entirely with `report: "false"`.

## Making it block merges (optional)

By default the review **posts comments and reports a pass/fail check, but does
not stop a merge** — a red check still leaves the green merge button clickable.
(The PR's "no conflicts with the base branch" banner is git-level mergeability,
unrelated to this check.)

To actually block merges on the gate, mark the check **required** — a one-time
repo setting:

1. **Settings → Branches** (or **Rules → Rulesets**) → add a rule targeting your
   default branch (e.g. `main`).
2. Enable **Require status checks to pass before merging**.
3. Search for and select the **`review`** check (it must have run at least once
   on a PR to appear in the list).
4. Save.

Now a failing review disables the merge button until it goes green. Re-run the
gate by pushing a new commit (the `/orca-code-review` comment posts a fresh
read but can't flip the required check — see the per-commit loop note above).

**Merge-gate note — oversized diffs.** An oversized-diff skip (`max-diff-kb` /
`max-diff-files`) **fails the check by default** (`on-oversized-diff: "fail"`):
if a skip passed, padding a PR past the size limit would bypass the P0/P1 gate
entirely without a single finding being read. When the check fails for size,
raise the limits, split the PR, or — if you accept that oversized PRs merge
unreviewed — set `on-oversized-diff: "pass"` to restore the advisory
skip-and-pass behavior. Settings-based skips (auto-review off, draft PRs,
on-demand mode) still pass the check: those are deliberate "don't review"
states, not a gate bypass.

## Try it locally (optional)

```bash
npm install -g @alibaba-group/open-code-review@1.3.13
ocr config set llm.url        https://api.orcarouter.ai/v1/chat/completions
ocr config set llm.auth_token <YOUR_ORCAROUTER_KEY>
ocr config set llm.auth_header authorization
ocr config set llm.model      orcarouter/code-review   # routes via your DSL recipe
ocr config set llm.use_anthropic false
ocr llm test                                    # connectivity check
ocr review --background "$(cat rules/severity-instruction.md)" --format json
```

## Notes

- The workflow uses `pull_request_target` so secrets are available on fork PRs.
  This is safe here because the engine only **reads** the diff and repo files —
  it never executes PR code. Don't add build/test steps that run untrusted code
  to this workflow.
- Server-side gateway guardrails (secret/PII detection, prompt-injection /
  jailbreak rails, code-security rules) run on your OrcaRouter key — see
  [Setup](#setup-4-steps) step 2 to enable them. When a guardrail or firewall
  **blocks** a request, the action posts the reason as a PR comment and fails the
  check closed (the diff was never sent to the model). Dependency CVE / SBOM
  scanning is not bundled; wire it in as an external guardrail Connection (step 2).

## License

[MIT](./LICENSE) © Continuum-AI-Corp.

The review engine is [Open Code Review](https://github.com/alibaba/open-code-review)
(Apache-2.0); its license and attribution are preserved in [`NOTICE`](./NOTICE).
