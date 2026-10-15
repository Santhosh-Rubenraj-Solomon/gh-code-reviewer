#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import meow from 'meow';
import { confirmIdentity, exploreIssues, pickCommits, pickRun, runConfigWizard, runModelWizard, showProgress } from './app/interactive';
import { ProgressTracker } from './app/progress';
import { reviewCommand, type ReviewCommandOptions, type ReviewMode } from './app/review';
import { ChatSession } from './chat';
import { annotatePatch } from './diff';
import {
  changelogCommand,
  checkGithubCommand,
  cleanupCommand,
  CommandError,
  configShowCommand,
  sessionsCommand,
  updateCheck,
} from './commands';
import { loadConfig, modelForStage, type Config } from './config';
import { CostTracker } from './cost';
import { parseSeverity } from './gate';
import { GitHubClient } from './github/client';
import { parsePullRef, pullRefFromActions } from './github/pull-ref';
import { ReviewHistory } from './history';
import { issueKey, toInteractiveIssues } from './issues';
import { MastraLLM } from './llm';
import { StepLogger } from './logger';
import { DeveloperMemory, memoryCommand, resolveDeveloperId } from './memory';
import { MODEL_CATALOG, missingKeys } from './models';
import { listPersonas, validatePersonaKey } from './personas';
import { LocalRepoProvider } from './repo/local-provider';
import { listUnmergedCommits, repoRoot } from './sources/local-git';
import { pruneTarballCache } from './repo/github-tarball-provider';
import { ReviewStore } from './store';
import { TimingCollector } from './timing';
import { BUILT_IN_PERSONAS, type Stage } from './types';
import { anthropicKeyValidator, defaultRcPath, githubTokenValidator, googleKeyValidator } from './ui';
import { formatVerifyReport, suggestRuleImprovements, verifyRules } from './verify-rules';
import { VERSION } from './version';

const cli = meow(
  `
  Review
    $ ghr review [pr]          Review a GitHub pull request (URL or owner/repo#123).
                               Inside a pull_request workflow the PR is detected automatically.
    $ ghr local                Review your branch against --base (default origin/main).
        --uncommitted          ...or your uncommitted changes
        --commits <a,b>        ...or a range of commits
        --pick                 ...or commits you pick from a list
    $ ghr impact [pr]          Impact analysis only: dependency graph, blast radius, coverage gaps

  Review options
    --post                     Post inline comments and a summary to the pull request
    --persona <name>           ${BUILT_IN_PERSONAS.join(' | ')} | random | none
    --fail-on <severity>       Exit 2 when a finding is at or above: critical | high | medium | low
    --interactive, -i          Browse the findings and chat about each one afterwards
    --title/--problem/--solution  Describe a local change; --identify lets a model write them
    --go                       --identify --fresh, no prompts (for scripts)
    --rerun / --rerun-last     Repeat one of the last five reviews
    --out <file>               Also write the full review as markdown
    --json                     Print the full report as JSON
    --impact-graph             Also write the impact graph (Mermaid and text)
    --export-tests             Also write test-plan.json
    --no-impact                Skip impact analysis
    --skip-validation          Skip the evidence check of the summary
    --docs-notice              Note on the PR when code changed but docs did not
    --fresh                    Ignore cached reviews for this commit
    --ci                       No interactive UI; plain log output (automatic when CI=true)

  Other commands
    $ ghr setup                Guided setup of keys, persona and editor
    $ ghr config [models]      Show the config (secrets masked), or choose models per tier and stage
    $ ghr models               List models and which one each stage uses
    $ ghr memory <action>      Your review memory: list | add | search | delete | compact | clear | export | import
    $ ghr sessions <action>    Past review sessions: list [filter] | show <id> | delete <id>
    $ ghr cleanup [--days=30]  Delete sessions and cached reviews older than N days (--dry-run to preview)
    $ ghr cleanup --cache      Forget every cached review, so the next run reviews from scratch
    $ ghr verify-rules         Check .review/*.md team rules (--suggest for model suggestions)
    $ ghr check-github [pr]    Check the GitHub token and its access
    $ ghr changelog            Latest release notes (needs updateRepo in the config)

  Environment
    ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, GITHUB_TOKEN; settings in ~/.ghreviewrc.json
`,
  {
    importMeta: import.meta,
    flags: {
      post: { type: 'boolean', default: false },
      out: { type: 'string' },
      json: { type: 'boolean', default: false },
      base: { type: 'string', default: 'origin/main' },
      uncommitted: { type: 'boolean', default: false },
      commits: { type: 'string' },
      pick: { type: 'boolean', default: false },
      title: { type: 'string' },
      problem: { type: 'string' },
      solution: { type: 'string' },
      identify: { type: 'boolean', default: false },
      go: { type: 'boolean', default: false },
      persona: { type: 'string' },
      failOn: { type: 'string' },
      fresh: { type: 'boolean', default: false },
      skipValidation: { type: 'boolean', default: false },
      impact: { type: 'boolean', default: true },
      impactGraph: { type: 'boolean', default: false },
      exportTests: { type: 'boolean', default: false },
      interactive: { type: 'boolean', shortFlag: 'i', default: false },
      docsNotice: { type: 'boolean' },
      ci: { type: 'boolean', default: false },
      rerun: { type: 'boolean', default: false },
      rerunLast: { type: 'boolean', default: false },
      suggest: { type: 'boolean', default: false },
      days: { type: 'string' },
      dryRun: { type: 'boolean', default: false },
      type: { type: 'string' },
      yes: { type: 'boolean', default: false },
      cache: { type: 'boolean', default: false },
      version: { type: 'boolean', shortFlag: 'v', default: false },
    },
  },
);

const ci = cli.flags.ci || cli.flags.go || process.env.CI === 'true' || !process.stdout.isTTY;
const err = (text: string) => process.stderr.write(`${text}\n`);

function github(config: Config): GitHubClient {
  if (!config.githubToken) throw new Error('GITHUB_TOKEN is required for this command');
  return new GitHubClient({ token: config.githubToken, apiUrl: config.githubApiUrl });
}

function releaseRepo(config: Config) {
  const [owner, repo] = config.updateRepo?.split('/') ?? [];
  return owner && repo ? { owner, repo } : undefined;
}

function listModels(config: Config): string {
  const lines = ['Known models (USD per 1M tokens, input / output):'];
  for (const [id, info] of Object.entries(MODEL_CATALOG)) {
    lines.push(`  ${id.padEnd(40)} ${info.inputPerMillion} / ${info.outputPerMillion}`);
  }
  lines.push('', 'Stage -> tier -> model:');
  for (const stage of Object.keys(config.stageTiers) as Stage[]) {
    lines.push(`  ${stage.padEnd(12)} ${config.stageTiers[stage].padEnd(9)} ${modelForStage(config, stage)}`);
  }
  return lines.join('\n');
}

/** Missing keys: a person at a terminal gets the setup wizard; scripts get a clear error. */
async function ensureKeys(config: Config): Promise<Config> {
  const missing = missingKeys(Object.values(config.tiers), config);
  if (!missing.length) return config;
  if (!ci && (await setup(config))) return ensureKeys(loadConfig());
  throw new Error(`Missing API key(s): ${missing.join(', ')}. Run "ghr setup" or set them in the environment.`);
}

function setup(config: Config): Promise<boolean> {
  return runConfigWizard({
    rcPath: defaultRcPath(),
    validateAnthropicKey: anthropicKeyValidator(),
    validateGoogleKey: googleKeyValidator(),
    validateGithubToken: githubTokenValidator(fetch, config.githubApiUrl),
    personas: listPersonas(config.personaDir).map(p => p.key),
  });
}

async function chooseReview(): Promise<{ mode: ReviewMode; target?: string } | null> {
  const flags = cli.flags;
  const [command, arg] = cli.input;
  if (flags.rerun || flags.rerunLast) {
    const history = new ReviewHistory({ path: join(loadConfig().dataDir, 'history.json') });
    const entry = flags.rerunLast ? history.latest() : ci ? history.latest() : await pickRun(history.load());
    if (!entry) throw new Error('There is no earlier review to repeat');
    if (entry.persona && !flags.persona) flags.persona = entry.persona;
    if (entry.title && !flags.title && entry.kind !== 'pr') flags.title = entry.title;
    process.chdir(entry.cwd);
    return { mode: entry.kind, target: entry.target || undefined };
  }
  const inPullRequestRun = (() => {
    try {
      return pullRefFromActions(process.env, path => readFileSync(path, 'utf8')) !== null;
    } catch {
      return false;
    }
  })();
  if (command === 'review' || (command === 'impact' && (arg || inPullRequestRun))) return { mode: 'pr', target: arg };
  if (flags.uncommitted) return { mode: 'uncommitted' };
  if (flags.commits) return { mode: 'commits', target: flags.commits };
  if (flags.pick) {
    const { commits } = listUnmergedCommits({ cwd: process.cwd() });
    if (!commits.length) throw new Error('There are no commits on this branch that are not on the base branch');
    if (commits.length === 1) return { mode: 'commits', target: commits[0]!.sha };
    if (ci) throw new Error('--pick needs a terminal; use --commits <sha,sha> in scripts');
    const shas = await pickCommits(commits);
    return shas ? { mode: 'commits', target: shas.join(',') } : null;
  }
  return { mode: 'local', target: flags.base };
}

async function review(config: Config, impactOnly: boolean): Promise<number> {
  const flags = cli.flags;
  const choice = await chooseReview();
  if (!choice) return 1;
  if (flags.persona) config.persona = flags.persona;
  validatePersonaKey(config.persona, config.personaDir);
  if (flags.skipValidation) config.skipValidation = true;
  if (!flags.impact) config.impact.enabled = false;
  // Impact analysis alone is static and needs no model.
  if (!impactOnly) config = await ensureKeys(config);

  const timings = new TimingCollector();
  const logger = new StepLogger({ console: ci, timings });
  const progress = new ProgressTracker(logger);
  const llm = new MastraLLM(config, { timings, log: logger.log });
  let store: ReviewStore | undefined;
  try {
    store = new ReviewStore({ path: config.storePath });
  } catch (error) {
    logger.warn(`session store unavailable, continuing without it: ${(error as Error).message}`);
  }

  const options: ReviewCommandOptions = {
    mode: choice.mode,
    target: choice.target,
    title: flags.title,
    problem: flags.problem,
    solution: flags.solution,
    identify: flags.identify || flags.go,
    post: flags.post,
    out: flags.out,
    json: flags.json,
    failOn: flags.failOn ? parseSeverity(flags.failOn) : undefined,
    fresh: flags.fresh || flags.go,
    impactOnly,
    impactGraph: flags.impactGraph,
    exportTests: flags.exportTests,
    docsNotice: flags.docsNotice,
  };

  // A person at a terminal confirms or edits how local work is described; --go and CI skip the question.
  const askIdentity = choice.mode !== 'pr' && !impactOnly && !ci;

  const output: string[] = [];
  let hideProgress = () => {};
  const startProgress = () => {
    if (!ci && !flags.json) hideProgress = showProgress(progress, 'gh-code-reviewer');
  };
  if (!askIdentity) startProgress();
  try {
    const outcome = await reviewCommand(options, {
      config,
      llm,
      logger,
      progress,
      timings,
      store,
      history: new ReviewHistory({ path: join(config.dataDir, 'history.json') }),
      github: config.githubToken ? () => github(config) : undefined,
      cwd: process.cwd(),
      env: process.env,
      print: text => output.push(text),
      confirmIdentity: askIdentity
        ? async (draft, generate) => {
            const confirmed = await confirmIdentity(draft, generate);
            startProgress();
            return confirmed;
          }
        : undefined,
    });
    hideProgress();
    console.log(output.join('\n'));
    err(`Run log: ${logger.dumpToFile(join(config.dataDir, 'logs'))}`);

    if (flags.interactive && outcome.report && !ci) {
      const issues = toInteractiveIssues(outcome.report);
      if (!issues.length) console.log('Nothing to discuss: no verified issues.');
      else await explore(config, llm, issues, outcome, store);
    }
    return outcome.exitCode;
  } catch (error) {
    hideProgress();
    if (output.length) console.log(output.join('\n'));
    const path = logger.dumpToFile(join(config.dataDir, 'logs'));
    err(`Full log: ${path}`);
    throw error;
  } finally {
    await store?.close();
  }
}

async function explore(
  config: Config,
  llm: MastraLLM,
  issues: ReturnType<typeof toInteractiveIssues>,
  outcome: Awaited<ReturnType<typeof reviewCommand>>,
  store: ReviewStore | undefined,
) {
  const memory = new DeveloperMemory({ developerId: await resolveDeveloperId(), dir: join(config.dataDir, 'memory'), llm });
  // Read files from the revision that was reviewed: the PR's checkout or tarball, or the local repository.
  const repo = new LocalRepoProvider(outcome.repoDir ?? process.cwd());
  const pull = outcome.changeSet?.pull;
  const files = new Map((outcome.changeSet?.files ?? []).map(f => [f.path, f]));
  const sessionId = outcome.sessionId;
  await exploreIssues(
    issues,
    issue => {
      const file = issue.files.map(path => files.get(path)).find(Boolean);
      return ChatSession.create({
        issue,
        llm,
        memory,
        personaInstruction: outcome.persona?.chatInstruction,
        project: pull ? `${pull.owner}/${pull.repo}` : null,
        tierModels: { basic: config.tiers.cheap, standard: config.tiers.balanced, advanced: config.tiers.deep },
        readFile: async path => (await repo.readFile(path)) ?? '',
        contextDiff: file?.patch ? annotatePatch(file.patch) : undefined,
        // Coming back to an issue in a later run picks the conversation up where it stopped.
        initialTranscript: sessionId ? store?.getChat(sessionId, issueKey(issue.title, issue.files[0])) : undefined,
        model: {
          stream: async (messages, model, onChunk) => {
            const result = await llm.streamText('chat', messages, onChunk, { model });
            return { text: result.text, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
          },
        },
      });
    },
    (issue, session) => {
      // Keyed by what the issue is, not its position, so a re-ordered list never mixes conversations up.
      if (sessionId && store) void store.saveChat(sessionId, issueKey(issue.title, issue.files[0]), session.transcript());
    },
  );
  await store?.flush();
}

async function main(): Promise<number> {
  if (cli.flags.version) {
    console.log(`ghr v${VERSION}`);
    return 0;
  }
  const [command = 'local', ...args] = cli.input;
  let config = loadConfig();

  // Release notice: never in CI, never blocking for more than a few seconds, never self-installing.
  const repo = releaseRepo(config);
  if (repo && config.githubToken && command !== 'changelog') {
    const notice = await updateCheck({ client: github(config), repo, current: VERSION, ci });
    if (notice) err(notice);
  }

  switch (command) {
    case 'review':
    case 'local':
      return review(config, false);
    case 'impact':
      return review(config, true);
    case 'models':
      console.log(listModels(config));
      return 0;
    case 'setup':
      return (await setup(config)) ? 0 : 1;
    case 'config': {
      if (args[0] === 'models' || args[0] === 'model') {
        const saved = await runModelWizard({
          current: { tiers: config.tiers, stageTiers: config.stageTiers },
          catalogue: Object.entries(MODEL_CATALOG).map(([id, m]) => ({ id, label: m.label })),
          keys: config,
          rcPath: defaultRcPath(),
        });
        return saved ? 0 : 1;
      }
      const rcPath = defaultRcPath();
      if (!existsSync(rcPath) && !ci) return (await setup(config)) ? 0 : 1;
      console.log(configShowCommand({ rcPath, readText: p => (existsSync(p) ? readFileSync(p, 'utf8') : null) }));
      return 0;
    }
    case 'memory': {
      const llm = new MastraLLM(config);
      const store = new DeveloperMemory({ developerId: await resolveDeveloperId(), dir: join(config.dataDir, 'memory'), llm });
      // meow consumes flags, so hand the memory command back the ones it understands.
      const memoryArgs = [...args, ...(cli.flags.type ? [`--type=${cli.flags.type}`] : []), ...(cli.flags.yes ? ['--yes'] : [])];
      const result = await memoryCommand(memoryArgs, { store });
      console.log(result.output);
      return result.exitCode;
    }
    case 'sessions':
    case 'cleanup': {
      const store = new ReviewStore({ path: config.storePath });
      try {
        if (command === 'cleanup' && cli.flags.cache) {
          const cleared = await store.clearCaches();
          console.log(`Cleared ${cleared.reports} cached review(s) and ${cleared.batches} cached batch review(s).`);
          return 0;
        }
        const cleanupArgs = [...args, ...(cli.flags.days ? [`--days=${cli.flags.days}`] : []), ...(cli.flags.dryRun ? ['--dry-run'] : [])];
        console.log(
          command === 'sessions' ? await sessionsCommand(args, { store }) : await cleanupCommand(cleanupArgs, { store, pruneRepos: () => pruneTarballCache() }),
        );
        return 0;
      } finally {
        await store.close();
      }
    }
    case 'verify-rules': {
      const provider = new LocalRepoProvider(repoRoot(process.cwd()));
      const [ruleFiles, repoFiles] = await Promise.all([provider.listRuleFiles(), provider.listAllFiles()]);
      const report = verifyRules({ ruleFiles, repoFiles, limits: config.rules, budgetTokens: config.maxBatchTokens });
      console.log(formatVerifyReport(report));
      if (cli.flags.suggest) {
        config = await ensureKeys(config);
        const deps = { llm: new MastraLLM(config), cost: new CostTracker(), log: err };
        const suggestions = await suggestRuleImprovements(deps, report, repoFiles);
        console.log(
          suggestions.length
            ? ['', 'Suggestions:', ...suggestions.map(s => `  [${s.type}] ${s.message}`)].join('\n')
            : '\nNo suggestions.',
        );
      }
      return report.status === 'errors' ? 1 : 0;
    }
    case 'check-github':
      console.log(await checkGithubCommand({ client: github(config), ref: args[0] ? parsePullRef(args[0]) : undefined }));
      return 0;
    case 'changelog':
      console.log(await changelogCommand({ client: github(config), repo, current: VERSION }));
      return 0;
    case 'help':
      cli.showHelp(0);
      return 0;
    default:
      err(`Unknown command "${command}".`);
      cli.showHelp(1);
      return 1;
  }
}

main().then(
  code => process.exit(code),
  error => {
    err(error instanceof CommandError ? error.message : `[ghr] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
