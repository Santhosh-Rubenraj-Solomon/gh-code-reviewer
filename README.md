# gh-code-reviewer

An LLM code reviewer for GitHub pull requests. It runs as a GitHub Action (or locally
as a CLI), reviews the diff in several stages, and posts inline comments plus one
summary comment. Every finding has to survive a critic stage that argues against it
before a developer ever sees it.

Author: **Santhosh Rubenraj** · License: MIT

## How a review works

```
PR diff ──► static triage ──► model triage ──► batching ──► deep review (per batch)
            (lockfiles,       (cheap model:     (token        (strongest model,
             binaries,         skip trivial      budget,       structured JSON
             build output)     files, summarise) by folder)    findings)
                                                                   │
  summary comment ◄── persona intro ◄── consolidation ◄── critic ◄─┘
  + inline comments   (optional voice)  (overview, risk)  1. evidence must exist in the code
                                                          2. model argues against each finding
```

| Stage | Tier (default model) | Fails… |
| --- | --- | --- |
| Triage | cheap (`claude-haiku-5-5`) | open: every file gets reviewed |
| Review | deep (`claude-opus-5-5`) | per batch: other batches still run |
| Critic | balanced (`claude-sonnet-5-5`) | keeps grounded findings, flags the report "not double-checked" |
| Consolidate | deep (`claude-opus-5-5`) | to a plain summary |
| Persona | cheap (`claude-haiku-5-5`) | silently: the intro is cosmetic |

Design choices worth knowing:

- **Grounding before judging.** The critic first checks, without any model call, that each
  finding's quoted evidence actually appears in the diff or file. Invented code is dropped
  for free. Only grounded findings go to the critic model.
- **Line numbers the model can't get wrong.** Diffs are sent with the new-file line number
  printed on every line, and inline comments are only placed on lines GitHub will accept
  (lines inside a diff hunk). Everything else goes into the summary.
- **Risk never goes down.** The model's risk rating can raise but never lower what the
  verified findings imply.
- **Idempotent on re-runs.** The summary comment is found by a hidden marker and edited in
  place. Inline comments that are already on the PR are not posted again. Locally, reports
  are cached in LMDB by PR + commit + model settings.

## Use it in GitHub Actions

1. Add `ANTHROPIC_API_KEY` as a repository secret.
2. Copy [examples/pr-review.yml](examples/pr-review.yml) to `.github/workflows/` in the repo
   to review, and replace `YOUR_GITHUB_USERNAME`.
3. Optional: add team rules in `.github/code-review.md`. They are included in every review prompt.

The workflow needs `pull-requests: write`. PRs from forks don't receive secrets, so the review is
skipped there unless you deliberately move to `pull_request_target` (read GitHub's security
guidance before doing that).

| Input | Default | |
| --- | --- | --- |
| `anthropic-api-key` | | needed for `anthropic:*` models |
| `google-api-key` | | needed for `google:*` models |
| `github-token` | `github.token` | |
| `persona` | `neutral` | `neutral`, `mentor`, `terse`, `detective` |
| `fail-on` | empty | fail the job on a finding at or above this severity |

## Use it locally

```bash
bun install
export ANTHROPIC_API_KEY=... GITHUB_TOKEN=...

bun run src/cli.ts review https://github.com/owner/repo/pull/12          # print the review
bun run src/cli.ts review owner/repo#12 --post                            # post it to the PR
bun run src/cli.ts local --base origin/main --out review.md               # review your branch
bun run src/cli.ts models                                                 # stage -> model map
```

## Configuration

Precedence: built-in defaults < `~/.ghreviewrc.json` (or `$GHR_CONFIG`) < environment.

```json
{
  "persona": "mentor",
  "tiers": {
    "deep": "anthropic:claude-opus-5-5",
    "balanced": "anthropic:claude-sonnet-5-5",
    "cheap": "google:gemini-3-flash-preview"
  },
  "stageTiers": { "critic": "deep" },
  "maxBatchTokens": 60000,
  "rulesFiles": [".github/code-review.md"]
}
```

Environment: `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` (or `GEMINI_API_KEY`),
`GITHUB_TOKEN` (or `GH_TOKEN`), `GITHUB_API_URL` (GitHub Enterprise), `GHR_PERSONA`,
`GHR_MODEL_DEEP`, `GHR_MODEL_BALANCED`, `GHR_MODEL_CHEAP`.

## Stack

TypeScript on Bun · [Mastra](https://mastra.ai) agents, one per stage · Vercel AI SDK providers
for Claude and Gemini · zod schemas for structured output · GitHub REST API via `fetch` ·
LMDB for the local report cache · `js-tiktoken` for batch sizing · `meow` for the CLI.

## Layout

| Path | |
| --- | --- |
| `src/cli.ts` | CLI entry: `review`, `local`, `models` |
| `src/pipeline/` | triage, batcher, reviewer, critic, consolidator, persona, `run.ts` orchestrator |
| `src/github/` | REST client (pagination, contents, reviews, comment upsert) and PR reference parsing |
| `src/sources/` | where changes come from: a GitHub PR, or local git |
| `src/diff.ts` | unified diff parsing, line mapping, annotation |
| `src/publish.ts`, `src/render/` | deciding inline vs summary, and the markdown |
| `src/llm.ts`, `src/models.ts`, `src/prompts.ts` | Mastra agents, model catalogue and pricing, prompts |
| `action.yml` | the composite GitHub Action |

## Tests

```bash
bun test          # 126 tests, no network or API keys needed
bun run typecheck
```

The pipeline is tested against a scripted fake model, the GitHub client against a fake `fetch`,
the store against a real LMDB in a temp dir, and the local source against a real git repo in a
temp dir.

## Limitations

- Batching is by folder and token budget, not by an import graph, so related files in
  different folders can land in different batches.
- Token counts for batching use `cl100k` as an approximation, with a safety margin.
- No interactive terminal UI; output is markdown or JSON.
