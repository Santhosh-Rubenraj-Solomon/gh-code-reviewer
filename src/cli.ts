#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import meow from 'meow';
import { loadConfig, modelForStage, type Config } from './config';
import { breachesThreshold, parseSeverity } from './gate';
import { GitHubClient } from './github/client';
import { formatPullRef, parsePullRef, pullRefFromActions } from './github/pull-ref';
import { MastraLLM } from './llm';
import { MODEL_CATALOG, missingKeys } from './models';
import { runReview } from './pipeline/run';
import { publishToGitHub } from './publish';
import { renderSummary } from './render/markdown';
import { loadRules } from './rules';
import { loadLocalChanges } from './sources/local-git';
import { loadPullRequest } from './sources/github-pr';
import { LmdbReportCache, type ReportCache } from './store';
import { BUILT_IN_PERSONAS, type ChangeSet, type PersonaName, type Stage } from './types';

const cli = meow(
  `
  Usage
    $ ghr review [pr]      Review a GitHub pull request (URL or owner/repo#123).
                           Inside GitHub Actions the PR is detected automatically.
    $ ghr local            Review commits on the current branch against --base.
    $ ghr models           List known models and the model each stage uses.

  Options
    --post                 Post the review to the pull request (inline comments + summary)
    --out <file>           Also write the summary markdown to a file
    --json                 Print the full report as JSON instead of markdown
    --base <ref>           Base for "local" (default: origin/main)
    --persona <name>       ${BUILT_IN_PERSONAS.join(' | ')} | random | none
    --fail-on <severity>   Exit with code 2 if a finding is at or above this severity
    --fresh                Ignore the cached review for this commit
    --no-cache             Do not read or write the review cache

  Environment
    ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY   model provider keys
    GITHUB_TOKEN                                      needed for "review"
    Settings can also live in ~/.ghreviewrc.json
`,
  {
    importMeta: import.meta,
    flags: {
      post: { type: 'boolean', default: false },
      out: { type: 'string' },
      json: { type: 'boolean', default: false },
      base: { type: 'string', default: 'origin/main' },
      persona: { type: 'string' },
      failOn: { type: 'string' },
      fresh: { type: 'boolean', default: false },
      cache: { type: 'boolean', default: true },
    },
  },
);

const log = (message: string) => console.error(`[ghr] ${message}`);

function listModels(config: Config): void {
  console.log('Known models (USD per 1M tokens, input/output):');
  for (const [id, info] of Object.entries(MODEL_CATALOG)) {
    console.log(`  ${id.padEnd(40)} ${info.inputPerMillion} / ${info.outputPerMillion}`);
  }
  console.log('\nStage -> model:');
  for (const stage of Object.keys(config.stageTiers) as Stage[]) {
    console.log(`  ${stage.padEnd(12)} ${config.stageTiers[stage].padEnd(9)} ${modelForStage(config, stage)}`);
  }
}

async function main(): Promise<number> {
  const [command = 'review', target] = cli.input;
  const config = loadConfig();
  if (cli.flags.persona) config.persona = cli.flags.persona as PersonaName;

  if (command === 'models') {
    listModels(config);
    return 0;
  }
  if (command !== 'review' && command !== 'local') {
    cli.showHelp(1);
    return 1;
  }

  const threshold = cli.flags.failOn ? parseSeverity(cli.flags.failOn) : undefined;
  const missing = missingKeys(Object.values(config.tiers), config);
  if (missing.length) throw new Error(`Missing API key(s): ${missing.join(', ')}`);

  let changeSet: ChangeSet;
  let github: GitHubClient | undefined;
  if (command === 'review') {
    if (!config.githubToken) throw new Error('GITHUB_TOKEN is required to review a pull request');
    const ref = target ? parsePullRef(target) : pullRefFromActions(process.env, p => readFileSync(p, 'utf8'));
    if (!ref) throw new Error('No pull request given, and this is not a pull_request workflow run');
    github = new GitHubClient({ token: config.githubToken, apiUrl: config.githubApiUrl });
    log(`loading ${formatPullRef(ref)}`);
    changeSet = await loadPullRequest(github, ref);
  } else {
    changeSet = loadLocalChanges({ base: cli.flags.base });
  }

  let cache: ReportCache | undefined;
  if (cli.flags.cache) {
    try {
      cache = new LmdbReportCache(config.storePath);
    } catch (error) {
      log(`cache unavailable, continuing without it: ${(error as Error).message}`);
    }
  }

  try {
    const { report } = await runReview(changeSet, {
      config,
      llm: new MastraLLM(config),
      rules: loadRules(config.rulesFiles, process.cwd()),
      cache,
      fresh: cli.flags.fresh,
      log,
    });

    const markdown = renderSummary(report);
    if (cli.flags.out) writeFileSync(cli.flags.out, markdown);
    console.log(cli.flags.json ? JSON.stringify(report, null, 2) : markdown);

    if (cli.flags.post) {
      if (!github || !changeSet.pull) throw new Error('--post only works with "review"');
      const result = await publishToGitHub(github, changeSet.pull, report, changeSet);
      log(`posted ${result.inlinePosted} inline comment(s); summary ${result.summary}`);
    }

    if (threshold && breachesThreshold(report.findings, threshold)) {
      log(`found issues at or above "${threshold}"`);
      return 2;
    }
    return 0;
  } finally {
    await cache?.close();
  }
}

main().then(
  code => process.exit(code),
  error => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
