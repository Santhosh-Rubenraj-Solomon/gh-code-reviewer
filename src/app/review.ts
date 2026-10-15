import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from '../config';
import { CostTracker, priceUsage } from '../cost';
import { breachesThreshold } from '../gate';
import type { GitHubClient } from '../github/client';
import { formatPullRef, parsePullRef, pullRefFromActions } from '../github/pull-ref';
import type { HistoryEntry, ReviewHistory } from '../history';
import { analyzeImpact, type AnalyzedImpact } from '../impact/analyzer';
import { toMermaid, toText } from '../impact/format';
import { buildTestPlan } from '../impact/test-plan';
import type { LLMClient } from '../llm';
import type { StepLogger } from '../logger';
import type { TimingCollector } from '../timing';
import { personaByKey, resolvePersona, type Persona } from '../personas';
import { identifyChange, type ChangeIdentity } from '../pipeline/identify';
import { runReview, type RunStep, type StepState } from '../pipeline/run';
import { publishToGitHub } from '../publish';
import { renderCompleteMarkdown, renderSummary } from '../render';
import { GitHubTarballProvider } from '../repo/github-tarball-provider';
import { LocalRepoProvider } from '../repo/local-provider';
import type { RepoFileProvider } from '../repo/provider';
import { loadPullRequest } from '../sources/github-pr';
import { loadCommitChanges, loadLocalChanges, loadWorkingTreeChanges, repoRoot } from '../sources/local-git';
import { cacheKey, type ReviewStore } from '../store';
import { writeMarkdownReport } from '../targets/markdown-file';
import type { ChangeSet, ReviewReport, Severity } from '../types';
import { LOG_STEP_FOR, SESSION_STAGE_FOR, type ProgressTracker } from './progress';

export type ReviewMode = 'pr' | 'local' | 'uncommitted' | 'commits';

export interface ReviewCommandOptions {
  mode: ReviewMode;
  /** PR URL or owner/repo#n (pr), base ref (local), comma-separated SHAs (commits). */
  target?: string;
  title?: string;
  problem?: string;
  solution?: string;
  /** Let the cheap model name the change (title, problem, solution) when no title is given. */
  identify?: boolean;
  post?: boolean;
  out?: string;
  json?: boolean;
  failOn?: Severity;
  fresh?: boolean;
  impactOnly?: boolean;
  impactGraph?: boolean;
  exportTests?: boolean;
  docsNotice?: boolean;
}

export interface ReviewServices {
  config: Config;
  llm: LLMClient;
  logger: StepLogger;
  progress?: ProgressTracker;
  /** LLM call timings; persisted with the session when a store is present. */
  timings?: TimingCollector;
  store?: ReviewStore;
  history?: ReviewHistory;
  github?: () => GitHubClient;
  cwd: string;
  env: Record<string, string | undefined>;
  print: (text: string) => void;
  /**
   * Lets a person confirm or edit how a local change is described before it is reviewed. `generate`
   * asks the model. Resolving null cancels the review.
   */
  confirmIdentity?: (
    draft: ChangeIdentity,
    generate: () => Promise<ChangeIdentity>,
  ) => Promise<ChangeIdentity | null>;
  /** Opens local reports in the configured editor; tests turn it off. */
  openReports?: boolean;
  now?: () => Date;
}

export interface ReviewOutcome {
  exitCode: number;
  report?: ReviewReport;
  changeSet?: ChangeSet;
  persona?: Persona | null;
  /** Store session of this run, for saving follow-up data such as chats. */
  sessionId?: string;
  /** Directory holding the reviewed revision's files (checkout or downloaded tarball), for follow-up reads. */
  repoDir?: string;
  outputs: string[];
}

function describe(problem?: string, solution?: string): string {
  return [problem && `**Problem:** ${problem}`, solution && `**Solution:** ${solution}`].filter(Boolean).join('\n\n');
}

async function loadChanges(options: ReviewCommandOptions, services: ReviewServices): Promise<ChangeSet> {
  const { cwd, env } = services;
  switch (options.mode) {
    case 'pr': {
      const ref = options.target
        ? parsePullRef(options.target)
        : pullRefFromActions(env, path => readFileSync(path, 'utf8'));
      if (!ref) throw new Error('No pull request given, and this is not a pull_request workflow run');
      if (!services.github) throw new Error('GITHUB_TOKEN is required to review a pull request');
      services.logger.info(`loading ${formatPullRef(ref)}`);
      return loadPullRequest(services.github(), ref);
    }
    case 'local':
      return loadLocalChanges({ base: options.target || 'origin/main', cwd });
    case 'uncommitted':
      return loadWorkingTreeChanges({ cwd });
    case 'commits': {
      const shas = (options.target ?? '').split(',').map(s => s.trim()).filter(Boolean);
      return loadCommitChanges({ cwd, shas });
    }
  }
}

/**
 * Whole-repo access for impact analysis, team rules and file requests. Inside a workflow run that
 * checked out the same repository the checkout is used; otherwise the commit's tarball is downloaded.
 */
async function repoProvider(changeSet: ChangeSet, services: ReviewServices): Promise<RepoFileProvider | undefined> {
  const { config, cwd, env, logger } = services;
  try {
    if (!changeSet.pull) return new LocalRepoProvider(repoRoot(cwd));
    const { owner, repo } = changeSet.pull;
    if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY?.toLowerCase() === `${owner}/${repo}`.toLowerCase()) {
      return new LocalRepoProvider(env.GITHUB_WORKSPACE || cwd);
    }
    return await GitHubTarballProvider.create({
      owner,
      repo,
      sha: changeSet.headSha,
      token: config.githubToken,
      apiUrl: config.githubApiUrl,
    });
  } catch (error) {
    logger.warn(`repository files unavailable, reviewing the diff only: ${(error as Error).message}`);
    return undefined;
  }
}

function sourceId(changeSet: ChangeSet, mode: ReviewMode): string {
  if (changeSet.pull) return `${changeSet.pull.owner}-${changeSet.pull.repo}-${changeSet.pull.number}`;
  return `${mode}-${changeSet.headSha.slice(0, 7)}`;
}

function writeFile(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

export async function reviewCommand(options: ReviewCommandOptions, services: ReviewServices): Promise<ReviewOutcome> {
  const { config, logger, store } = services;
  const now = services.now ?? (() => new Date());
  const outputs: string[] = [];
  const mark = (step: Parameters<StepLogger['setStep']>[0], state: StepState, detail?: string) => {
    if (state === 'running') logger.setStep(step);
    services.progress?.mark(step, state, detail);
  };

  // Spend shows up live in the progress view as each model call finishes.
  const stopCostFeed = services.timings?.onRecord(entry => {
    const usd = priceUsage(entry.model, entry);
    const step =
      entry.stage === 'identify'
        ? 'fetch'
        : ((LOG_STEP_FOR as Record<string, Parameters<StepLogger['addCost']>[1]>)[entry.stage] ?? 'review');
    if (usd > 0) logger.addCost(usd, step);
  });

  mark('fetch', 'running');
  const changeSet = await loadChanges(options, services);
  mark('fetch', 'completed', `${changeSet.files.length} file(s)`);
  if (changeSet.files.length === 0) {
    services.print('No changes to review.');
    return { exitCode: 0, changeSet, outputs };
  }

  if (!changeSet.pull) {
    const generate = () =>
      identifyChange({ llm: services.llm, cost: new CostTracker(), log: logger.log }, changeSet.files);
    let identity: ChangeIdentity | undefined = options.title
      ? { title: options.title, problem: options.problem ?? '', solution: options.solution ?? '' }
      : options.identify
        ? await generate()
        : undefined;
    if (services.confirmIdentity && !options.impactOnly) {
      const confirmed = await services.confirmIdentity(
        identity ?? { title: '', problem: options.problem ?? '', solution: options.solution ?? '' },
        generate,
      );
      if (!confirmed) {
        services.print('Review cancelled.');
        return { exitCode: 1, changeSet, outputs };
      }
      identity = confirmed;
    }
    if (identity) {
      changeSet.title = identity.title;
      changeSet.description = describe(identity.problem, identity.solution) || changeSet.description;
      logger.info(`reviewing: ${identity.title}`);
    }
  }

  const id = sourceId(changeSet, options.mode);
  const outDir = join(config.dataDir, 'output', id);
  const provider = await repoProvider(changeSet, services);

  try {
    if (options.impactOnly) {
      if (!provider) throw new Error('Impact analysis needs repository files, which are not available');
      mark('impact', 'running');
      const impact = await analyzeImpact(provider, changeSet.files, config.impact);
      mark('impact', 'completed', `blast radius ${impact.blastRadius.level}`);
      const paths = changeSet.files.map(f => f.path);
      outputs.push(
        writeFile(outDir, 'impact-graph.mmd', toMermaid(impact, paths)),
        writeFile(outDir, 'impact-graph.txt', toText(impact, paths)),
        writeFile(outDir, 'impact-summary.json', JSON.stringify(impact, null, 2)),
      );
      if (options.exportTests) {
        const plan = buildTestPlan({ sourceId: id, changedFiles: changeSet.files, impact, now });
        outputs.push(writeFile(outDir, 'test-plan.json', JSON.stringify(plan, null, 2)));
      }
      services.print(toText(impact, paths));
      services.print(`\nWrote:\n${outputs.map(p => `  ${p}`).join('\n')}`);
      return { exitCode: 0, changeSet, outputs };
    }

    const session = await store?.getOrCreateSession(
      {
        key: cacheKey(changeSet, config),
        source: { type: options.mode, id: changeSet.pull ? formatPullRef(changeSet.pull) : id, title: changeSet.title },
        target: options.post ? 'github' : 'local',
        config: { persona: config.persona, tiers: config.tiers, skipValidation: config.skipValidation },
      },
      { fresh: options.fresh },
    );
    if (session) {
      await store!.setStageStatus(session.id, 'fetch', 'completed');
      await store!.saveStageData(session.id, 'fetch', {
        files: changeSet.files.map(f => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
      });
      services.timings?.onRecord(entry => void store!.recordTiming(session.id, entry));
    }

    let running: RunStep | undefined;
    const onStep = (step: RunStep, state: StepState, detail?: string) => {
      running = state === 'running' ? step : running === step ? undefined : running;
      mark(LOG_STEP_FOR[step], state, detail);
      if (detail) logger.info(`${step}: ${detail}`);
      if (session) void store!.setStageStatus(session.id, SESSION_STAGE_FOR[step], state);
    };

    const reviewRun = runReview(changeSet, {
      config,
      llm: services.llm,
      provider,
      cache: store,
      // --fresh means fresh all the way down: cached file reviews and impact results are rewritten, not read.
      batchCache: store && {
        get: key => (options.fresh ? undefined : store.getBatch(key)),
        put: (key, value) => store.putBatch(key, value),
      },
      fresh: options.fresh,
      log: logger.log,
      onStep,
      debugDir: join(config.dataDir, 'logs'),
      impactCache: store && {
        get: key => (options.fresh ? undefined : store.getImpact<AnalyzedImpact>(key)),
        put: (key, value) => store.putImpact(key, value),
      },
    });
    const { report, cached } = await reviewRun.catch(async (error: unknown) => {
      // Leave an honest record: the step that was running when the run stopped is the one that failed.
      if (running) {
        mark(LOG_STEP_FOR[running], 'failed');
        if (session) await store!.setStageStatus(session.id, SESSION_STAGE_FOR[running], 'failed', (error as Error).message);
      }
      throw error;
    });
    if (cached) {
      for (const step of ['impact', 'triage', 'batch', 'review', 'validate', 'persona'] as const) mark(step, 'completed', 'cached');
    }
    if (cached) logger.info('this commit was already reviewed with the same settings; reusing that review');
    if (!cached) {
      logger.info(
        `cost by stage: ${Object.entries(report.cost.byStage)
          .map(([stage, c]) => `${stage} $${(c?.costUsd ?? 0).toFixed(4)}`)
          .join(', ')} (total $${report.cost.totalUsd.toFixed(4)})`,
      );
    }
    if (session) {
      await store!.saveStageData(session.id, 'review', {
        findings: report.findings.length,
        rejected: report.rejected.length,
        risk: report.risk,
        files: (report.fileReviews ?? []).map(r => ({ path: r.path, status: r.status, findings: r.findings.length })),
      });
    }

    const persona =
      (report.presentation && personaByKey(report.presentation.persona, config.personaDir)) ??
      resolvePersona(config.persona, { dir: config.personaDir, warn: logger.log });

    if (options.impactGraph && report.impact) {
      const paths = changeSet.files.map(f => f.path);
      outputs.push(
        writeFile(outDir, 'impact-graph.mmd', toMermaid(report.impact, paths)),
        writeFile(outDir, 'impact-graph.txt', toText(report.impact, paths)),
      );
    }
    if (options.exportTests) {
      const plan = buildTestPlan({ sourceId: id, changedFiles: changeSet.files, impact: report.impact, report, now });
      outputs.push(writeFile(outDir, 'test-plan.json', JSON.stringify(plan, null, 2)));
    }
    if (options.out) {
      mkdirSync(dirname(options.out), { recursive: true });
      writeFileSync(options.out, renderCompleteMarkdown(report, persona));
      outputs.push(options.out);
    }

    if (options.json) {
      services.print(JSON.stringify(report, null, 2));
    } else if (changeSet.pull) {
      services.print(renderSummary(report, { marker: false }));
    } else {
      const path = await writeMarkdownReport(report, {
        dir: join(config.dataDir, 'reports'),
        id,
        persona,
        openWith: services.openReports === false ? undefined : config.editor || undefined,
        now,
        log: logger.log,
      });
      outputs.push(path);
      services.print(renderSummary(report, { marker: false }));
    }

    if (options.post) {
      if (!changeSet.pull || !services.github) throw new Error('--post only works when reviewing a pull request');
      mark('publish', 'running');
      try {
        const result = await publishToGitHub(services.github(), changeSet.pull, report, changeSet, {
          persona,
          docsNotice: options.docsNotice ?? config.docsNotice,
        });
        logger.info(`posted ${result.inlinePosted} inline comment(s); summary ${result.summary}`);
        mark('publish', 'completed');
        if (session) await store!.setStageStatus(session.id, 'publish', 'completed');
      } catch (error) {
        mark('publish', 'failed');
        if (session) await store!.setStageStatus(session.id, 'publish', 'failed', (error as Error).message);
        throw error;
      }
    } else {
      mark('publish', 'skipped');
    }

    const entry: HistoryEntry = {
      kind: options.mode,
      target: changeSet.pull ? formatPullRef(changeSet.pull) : options.target ?? '',
      title: changeSet.title,
      persona: config.persona,
      cwd: services.cwd,
      at: now().toISOString(),
    };
    services.history?.add(entry);
    if (outputs.length) services.print(`\nWrote:\n${outputs.map(p => `  ${p}`).join('\n')}`);
    logger.setStep('complete');

    const exitCode = options.failOn && breachesThreshold(report.findings, options.failOn) ? 2 : 0;
    if (exitCode) logger.warn(`found issues at or above "${options.failOn}"`);
    await store?.flush();
    const repoDir =
      provider instanceof GitHubTarballProvider
        ? provider.dir
        : provider
          ? changeSet.pull
            ? services.env.GITHUB_WORKSPACE || services.cwd
            : services.cwd
          : undefined;
    return { exitCode, report, changeSet, persona, sessionId: session?.id, repoDir, outputs };
  } finally {
    stopCostFeed?.();
    await provider?.cleanup?.();
  }
}
