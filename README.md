# gh-code-reviewer

An LLM code reviewer for GitHub pull requests and local changes. It reads the diff *and* the rest
of the repository, reviews in stages with models sized to each job, argues against its own findings
before anyone sees them, and posts inline comments plus one summary comment on the PR.

Author: **Santhosh Rubenraj** · License: MIT

## What a review does

```
changes ──► impact analysis ──► docs summary ──► triage ──► batch planning ──► deep review per batch
            (tree-sitter         (README, docs/)  (rules,    (token budget,     (findings, positives,
             import graph,                        then a     related files      test ideas; may ask
             blast radius,                        cheap      kept together)     for more files)
             test gaps)                           model)                             │
                                                                                     ▼
 PR comments ◄── persona presentation ◄── evidence check ◄── consolidation ◄── critic
 (inline +       (voice, verdict,         (summary claims     (overview, risk,    1. quoted code must exist
  summary +       aspects, fixes           must quote real     security, tests,    2. a model argues against
  testing)        checked)                 code)               recommendations)       every finding
```

| Stage | Default model tier | If it fails… |
| --- | --- | --- |
| Impact analysis | none (static) | review continues without ripple-effect context |
| Docs summary, triage, batch planning | cheap (`claude-haiku-5-5`) | heuristic summary · every file reviewed · size-based batches |
| Deep review | deep (`claude-opus-5-5`) | affected files marked failed; the run is not cached |
| Critic | balanced (`claude-sonnet-5-5`) | grounded findings kept, report marked "not double-checked" |
| Consolidation | deep | summary built from the verified findings |
| Evidence check | balanced | summary kept unchanged |
| Persona presentation | deep | plain presentation built from the data |

Every model call streams with timeouts, retries transient errors, falls back through a chain of
models (only providers whose key you have), and stops the run with a clear error only when every
model failed.

### Design choices

- **Grounding before judging.** Findings whose quoted code is not in the diff or file are dropped
  without a model call; the rest face a critic. The summary's security concerns, recommendations
  and test requirements go through the same evidence check.
- **Repository-aware.** A tree-sitter import graph finds which files use the changed exports, how
  far the change ripples (blast radius) and which tests cover it. Reviewers see the callers; the
  model can also request extra files (up to 10 per round, 2 rounds).
- **Lines GitHub accepts.** Diffs are sent with new-file line numbers, and inline comments only go
  on lines inside a diff hunk; everything else lands in the summary.
- **Idempotent.** Summary and testing comments are found by hidden markers and edited in place
  (long ones split into parts, stale parts removed). Inline comments already on the PR are not
  repeated. Reviews are cached by commit, settings and team rules; batches by content.
- **Risk never goes down.** The model can raise the merge risk, never lower it below what the
  verified findings imply.

## GitHub Actions

1. Add `ANTHROPIC_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`) as a repository secret.
2. Copy [examples/pr-review.yml](examples/pr-review.yml) into `.github/workflows/`.

| Input | Default | |
| --- | --- | --- |
| `anthropic-api-key` / `google-api-key` | | provider keys |
| `github-token` | `github.token` | needs `pull-requests: write` |
| `persona` | `neutral` | `neutral` `mentor` `terse` `detective` `captain` `monk` `random` `none` |
| `fail-on` | empty | fail the job on a finding at or above `critical`/`high`/`medium`/`low` |
| `impact-analysis` | `true` | needs `actions/checkout` before the step |
| `skip-validation` | `false` | skip the evidence check of the summary |
| `docs-notice` | `false` | note on the PR when code changed but docs did not |
| `export-tests` | `false` | write `test-plan.json` and impact graphs to the `output-dir` output |

PRs from forks do not receive secrets, so the review is skipped there unless you deliberately use
`pull_request_target` (read GitHub's security guidance first).

## Command line

```bash
bun install
ghr setup                                   # guided: keys (validated), GitHub token, persona, editor

ghr review https://github.com/o/r/pull/12   # print the review
ghr review o/r#12 --post --fail-on high     # post it; exit 2 on high or critical findings
ghr local                                   # your branch vs origin/main, written to a markdown file
ghr local --uncommitted -i                  # uncommitted work, then browse and chat about each issue
ghr local --pick                            # choose commits from a list
ghr local --commits a1b2c3,d4e5f6 --go      # a commit range, model-written title, no prompts
ghr local --rerun-last                      # repeat the last review
ghr impact --export-tests                   # impact graph, blast radius, test plan; no model calls
```

Other commands: `ghr models`, `ghr config` (secrets masked) / `ghr config models` (models per tier
and stage), `ghr memory list|add|search|delete|compact|clear|export|import`, `ghr sessions
list|show|delete`, `ghr cleanup [--days=30] [--dry-run] [--cache]`, `ghr verify-rules [--suggest]`,
`ghr check-github [pr]`, `ghr changelog`. Run `ghr --help` for every flag.

### Interactive mode

`-i` opens an issue navigator after the review. Each issue has its own chat with the reviewer, in
the persona's voice, with the file's diff as context. Replies choose the model tier for the next
answer (`/model basic|standard|advanced|auto` to override), long chats are compacted, `/context
<file>` adds a file, and `/memory save` remembers what you agreed. Chats are saved with the review
session and resume where you left them.

### Developer memory

Preferences, decisions and conventions you save (or that come out of chats) are kept per git
identity in `~/.gh-code-reviewer/memory/`, scored by importance, recency and use, and compacted
(with model summaries) as they grow.

## Team rules

Put Markdown files in `.review/` (and/or `.github/code-review.md`, always global). Scope a rule with
front matter:

```markdown
---
globs: ["src/api/**/*.ts", "src/routes/**"]
---
Every handler validates its request body with the shared schema helpers.
```

`ghr verify-rules` checks sizes, globs and how many files each rule matches, and how much of the
review budget the rules use; `--suggest` asks a model for improvements.

## Configuration

Precedence: defaults < `~/.ghreviewrc.json` (or `$GHR_CONFIG`) < environment.

```json
{
  "persona": "mentor",
  "tiers": { "deep": "anthropic:claude-opus-5-5", "balanced": "anthropic:claude-sonnet-5-5", "cheap": "google:gemini-3-flash-preview" },
  "stageTiers": { "critic": "deep" },
  "maxBatchTokens": 60000,
  "impact": { "enabled": true, "maxDepth": 3 },
  "securityContexts": [{ "name": "payments", "patterns": ["src/payments/**"], "instructions": "Check amounts are integers in minor units." }],
  "editor": "code",
  "updateRepo": "Santhosh-Rubenraj-Solomon/gh-code-reviewer"
}
```

Environment: `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` (or `GEMINI_API_KEY`),
`GITHUB_TOKEN` (or `GH_TOKEN`), `GITHUB_API_URL` (GitHub Enterprise), `GHR_PERSONA`,
`GHR_MODEL_DEEP|BALANCED|CHEAP`, `GHR_DATA_DIR`, `GHR_EDITOR`, `GHR_UPDATE_REPO`, `GHR_NO_DEBUG`.

Custom personas: JSON files in `~/.gh-code-reviewer/personas/`.

## Stack

TypeScript on Bun · Mastra agents, one per stage · Vercel AI SDK (Claude, Gemini) · zod structured
output · tree-sitter (TS/JS) · GitHub REST via `fetch` · LMDB sessions and caches · Ink + React
terminal UI · meow CLI · js-tiktoken.

## Layout

| Path | |
| --- | --- |
| `src/cli.ts`, `src/app/` | commands, review command, interactive screens, progress |
| `src/pipeline/` | docs, triage, batcher, reviewer, file requests, critic, consolidator, validator, presentation, `run.ts` |
| `src/impact/`, `src/repo/` | tree-sitter parsing, dependency and entity graphs, impact analysis, test plan; repo access (checkout or tarball) |
| `src/github/`, `src/sources/`, `src/publish.ts`, `src/render/`, `src/targets/` | GitHub API, change sources, posting and rendering |
| `src/llm.ts`, `src/models.ts`, `src/prompts.ts`, `src/personas/` | model layer, catalogue and prices, prompts, personas |
| `src/store/`, `src/logger.ts`, `src/timing.ts`, `src/history.ts` | sessions and caches, step log, call timings, rerun history |
| `src/memory/`, `src/chat/`, `src/ui/`, `src/issues.ts` | developer memory, issue chat, Ink components |
| `src/review-rules.ts`, `src/verify-rules.ts`, `src/security-context.ts` | team rules and review emphasis |

## Tests

```bash
bun test          # no network or API keys needed
bun run typecheck
```

Models are a scripted fake, GitHub is a fake `fetch`, and LMDB, git and tree-sitter run for real
against temporary directories.

## Limitations

- Impact analysis understands TypeScript and JavaScript; other languages are reviewed from the diff
  and full file only.
- Token counts for batching use `cl100k` as an approximation.
- Posted reviews use the `COMMENT` event; blocking a merge is done with `fail-on` and branch protection.
