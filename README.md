# OrcaRouter Code Review

AI pull-request review powered by the [OrcaRouter](https://orcarouter.ai) model
gateway. A cheap model screens every push; once a push comes back clear of
serious (P0/P1) issues, a strong model makes the final pass. Findings post as
inline PR comments, tagged by severity, and a configurable gate can block the
merge.

> Review engine powered by [Open Code Review](https://github.com/alibaba/open-code-review)
> (Apache-2.0). See [`NOTICE`](./NOTICE).

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
3. **Inline comments** — findings post on the exact lines of the PR.
4. **Merge gate** — the job fails if any **P0/P1** is found; mark the check
   "required" in branch protection to block the merge.
5. **Per-commit loop** — `synchronize` re-reviews on every new push; comment
   `/orcarouter-review` on a PR to re-run on demand. The comment re-run posts
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
   name: OrcaRouter Code Review
   on:
     pull_request_target:
       types: [opened, synchronize]
     issue_comment:
       types: [created]
   permissions:
     contents: read
     pull-requests: write
     issues: write # label-based tier state + clean/fallback PR comments
   jobs:
     review:
       runs-on: ubuntu-latest
       # PR events, or a `/orcarouter-review` command from a maintainer —
       # otherwise any commenter could spend your quota.
       if: |
         github.event_name == 'pull_request_target' ||
         (github.event_name == 'issue_comment' &&
           github.event.issue.pull_request &&
           startsWith(github.event.comment.body, '/orcarouter-review') &&
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
| `brand` | `OrcaRouter Code Review` | Name shown on PR comments |
| `router` | `orcarouter/code-review` | OrcaRouter router alias whose DSL recipe picks the cheap/strong model per tier (the action names no models) |
| `fix-first` | `P0,P1` | Keep the PR on the cheap tier until these are cleared (then it's promoted) |
| `block-on` | `P0,P1` | Fail the check (block merge) on one of these |

## Severity rubric

| Tag | Meaning | Examples |
|---|---|---|
| **P0** | Blocker — must not merge | injection, XSS, `eval` on untrusted input, exposed secret, data loss, crash on a normal path, broken build |
| **P1** | High — fix before merge | null deref, unhandled async rejection, race condition, resource leak, missing boundary validation, wrong-result logic |
| **P2** | Advisory | dead code, duplication, naming, `any`, `==` vs `===`, `var`, nested ternaries, minor perf |

The rubric lives in `rules/severity-instruction.md` — edit it to retune what
counts as P0/P1/P2 for your codebase.

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
gate by pushing a new commit (the `/orcarouter-review` comment posts a fresh
read but can't flip the required check — see the per-commit loop note above).

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
