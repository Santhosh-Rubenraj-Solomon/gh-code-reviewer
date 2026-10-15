import { createHash } from 'node:crypto';
import { modelForStage, type Config } from '../config';
import { CostTracker } from '../cost';
import { analyzeImpact, type AnalyzedImpact } from '../impact/analyzer';
import { formatFileImpactForPrompt, formatImpactSummaryForPrompt } from '../impact/format';
import { symbolSource } from '../impact/parser';
import type { LLMClient } from '../llm';
import { resolvePersona, type Persona } from '../personas';
import type { RepoFileProvider } from '../repo/provider';
import { loadRuleSet } from '../review-rules';
import { securityContextFor, type SecurityContextRule } from '../security-context';
import { cacheKey, impactKey, type ReportCache } from '../store';
import { SEVERITY_ORDER, type ChangedFile, type ChangeSet, type Finding, type ReviewReport } from '../types';
import { mapLimit } from '../utils/pool';
import { planBatches } from './batcher';
import { consolidate, fallbackConsolidated } from './consolidator';
import { critique } from './critic';
import type { StageDeps } from './deps';
import { formatDocsSummary, partitionDocs, summarizeDocs } from './docs';
import { buildPresentation } from './presentation';
import { REVIEW_PROMPT_VERSION, reviewBatch, type BatchCache } from './reviewer';
import { staticTriage, triage } from './triage';
import { validateConsolidated } from './validator';

/** Pipeline steps, reported through `onStep` so the CLI can drive the logger, store and progress UI. */
export type RunStep =
  | 'impact'
  | 'docs'
  | 'triage'
  | 'batching'
  | 'review'
  | 'critic'
  | 'consolidate'
  | 'validate'
  | 'persona';

export type StepState = 'running' | 'completed' | 'skipped' | 'failed';

export interface RunOptions {
  config: Config;
  llm: LLMClient;
  /** Whole-repository access: enables impact analysis, team rules and model file requests. */
  provider?: RepoFileProvider;
  cache?: ReportCache;
  batchCache?: BatchCache;
  securityContexts?: SecurityContextRule[];
  /** Ignore a cached report for this commit and review again. */
  fresh?: boolean;
  log?: (message: string) => void;
  onStep?: (step: RunStep, state: StepState, detail?: string) => void;
  /** Persona chooser for 'random'; injectable for tests. */
  rng?: () => number;
  /** Where unparseable model answers are saved for debugging. */
  debugDir?: string;
  /** Reuses impact analysis for the same repository state and changed files (24 h). */
  impactCache?: {
    get(key: string): AnalyzedImpact | undefined;
    put(key: string, value: AnalyzedImpact): Promise<void> | void;
  };
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

/** Changed files that import each other, from the impact graph; batching keeps them together. */
export function relatedChangedFiles(impact: AnalyzedImpact | undefined, changed: string[]): Record<string, string[]> {
  const related: Record<string, string[]> = {};
  if (!impact) return related;
  const set = new Set(changed);
  for (const { from, to } of impact.edges) {
    if (!set.has(from) || !set.has(to) || from === to) continue;
    (related[from] ??= []).push(to);
    (related[to] ??= []).push(from);
  }
  return related;
}

async function loadRules(provider: RepoFileProvider | undefined, config: Config, log: (m: string) => void) {
  if (!provider) return { rules: loadRuleSet([]), fingerprint: undefined };
  try {
    const files = await provider.listRuleFiles();
    const rules = loadRuleSet(files, config.rules);
    for (const s of rules.skipped) log(`rule file ${s.path} skipped: ${s.reason}`);
    // Rules change what the reviewer is told, so they are part of what makes two reviews the same.
    const fingerprint = files.length
      ? createHash('sha256')
          .update(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path))))
          .digest('hex')
          .slice(0, 16)
      : undefined;
    return { rules, fingerprint };
  } catch (error) {
    log(`team rules unavailable: ${(error as Error).message}`);
    return { rules: loadRuleSet([]), fingerprint: undefined };
  }
}

/** Repository state plus the exact changes: impact results only carry over when both are identical. */
async function impactCacheKey(provider: RepoFileProvider, changeSet: ChangeSet): Promise<string> {
  const changes = createHash('sha256');
  for (const f of changeSet.files) changes.update(`${f.path}\0${f.status}\0${f.patch}\0`);
  return impactKey(`${await provider.repoHash()}:${changes.digest('hex').slice(0, 16)}`, changeSet.files.map(f => f.path));
}

/**
 * impact -> docs -> triage (static, then cheap model) -> batch planning -> deep review per batch
 * -> critic (grounding, then model) -> consolidate -> validate -> persona presentation.
 * Every stage after review degrades instead of failing; only a CriticalFailureError aborts the run.
 */
export async function runReview(
  changeSet: ChangeSet,
  options: RunOptions,
): Promise<{ report: ReviewReport; cached: boolean }> {
  const { config, llm, cache, provider } = options;
  const log = options.log ?? (() => {});
  const step = options.onStep ?? (() => {});
  const { rules, fingerprint } = await loadRules(provider, config, log);
  // Anything that changes what the reviewer is asked or told belongs in the key.
  const key = cacheKey(changeSet, config, fingerprint, {
    title: changeSet.title,
    description: changeSet.description,
    securityContexts: options.securityContexts ?? config.securityContexts ?? null,
    rootConfigFiles: config.rootConfigFiles ?? null,
    maxBatchTokens: config.maxBatchTokens,
    maxFilesPerBatch: config.maxFilesPerBatch,
    prompt: REVIEW_PROMPT_VERSION,
  });

  if (cache && !options.fresh) {
    const hit = cache.get(key);
    if (hit) {
      log(`reusing cached review for ${changeSet.headSha.slice(0, 7)}`);
      return { report: hit, cached: true };
    }
  }

  const cost = new CostTracker();
  const deps: StageDeps = { llm, cost, log };
  const filesByPath = new Map<string, ChangedFile>(changeSet.files.map(f => [f.path, f]));

  // Impact analysis needs the whole repository, so it only runs with a provider.
  let impact: AnalyzedImpact | undefined;
  if (provider && config.impact.enabled) {
    step('impact', 'running');
    const impactKeyValue = options.impactCache ? await impactCacheKey(provider, changeSet).catch(() => undefined) : undefined;
    impact = impactKeyValue ? options.impactCache!.get(impactKeyValue) : undefined;
    if (impact) {
      log('impact: reusing the analysis of this exact repository state');
    } else {
      impact = await analyzeImpact(provider, changeSet.files, config.impact);
      for (const note of impact.notes) log(`impact: ${note}`);
      if (impactKeyValue && impact.notes.length === 0) await options.impactCache!.put(impactKeyValue, impact);
    }
    step('impact', 'completed', `blast radius ${impact.blastRadius.level}`);
  } else {
    step('impact', 'skipped');
  }

  step('docs', 'running');
  const docs = partitionDocs(changeSet.files)
    .docOnly.filter(f => f.status !== 'removed' && f.content)
    .map(f => ({ path: f.path, content: f.content! }));
  const docsSummary = docs.length ? formatDocsSummary(await summarizeDocs(deps, docs)) : undefined;
  step('docs', docs.length ? 'completed' : 'skipped');

  step('triage', 'running');
  const { candidates, skipped: staticSkipped } = staticTriage(changeSet.files, {
    rootConfigFiles: config.rootConfigFiles,
  });
  log(`triage: ${candidates.length} candidate file(s), ${staticSkipped.length} skipped by rule`);
  const triaged = await triage(deps, changeSet, candidates, { docsSummary });
  step('triage', 'completed', `${triaged.reviewable.length} to review`);

  // Nothing worth a deep review (lockfiles, docs, assets): say so without spending more model calls.
  if (triaged.reviewable.length === 0) {
    for (const s of ['batching', 'review', 'critic', 'consolidate', 'validate', 'persona'] as const) step(s, 'skipped');
    const skipped = [...staticSkipped, ...triaged.skipped];
    const consolidated = {
      ...fallbackConsolidated(changeSet, { fileReviews: [], findings: [], summaries: triaged.summaries }),
      overview:
        `No code in this change needed a review: ${skipped.length} file(s) were skipped ` +
        `(${[...new Set(skipped.map(f => f.reason))].join(', ')}).` +
        (docsSummary ? ` Documentation changes: ${docsSummary}` : ''),
      functionality: { isComplete: true, missing: [], explanation: 'Not assessed: there was no reviewable code.' },
      limitations: [],
      completeness: 'complete' as const,
    };
    const report: ReviewReport = {
      title: changeSet.title,
      headSha: changeSet.headSha,
      overview: consolidated.overview,
      risk: 'low',
      highlights: [],
      findings: [],
      rejected: [],
      skipped,
      reviewedFiles: [],
      validated: true,
      cost: cost.summary(),
      fileReviews: [],
      consolidated,
      impact,
      docsSummary,
    };
    await cache?.put(key, report);
    return { report, cached: false };
  }

  step('batching', 'running');
  const globalRuleTokens = rules.globalTokens();
  const batches = await planBatches(deps, triaged.reviewable, {
    maxTokens: Math.max(1_000, config.maxBatchTokens - globalRuleTokens),
    maxFiles: config.maxFilesPerBatch,
    extraTokens: path => rules.tokensForFile(path),
    related: relatedChangedFiles(impact, changeSet.files.map(f => f.path)),
    dependencies: triaged.dependencies,
    summaries: triaged.summaries,
  });
  step('batching', 'completed', `${batches.length} batch(es)`);
  log(`review: ${triaged.reviewable.length} file(s) in ${batches.length} batch(es)`);

  step('review', 'running');
  const context = {
    title: changeSet.title,
    description: changeSet.description,
    docsSummary,
    summaries: triaged.summaries,
    rules: rules.globalText() || undefined,
    rulesFor: (path: string) => rules.scopedFor(path),
    securityContextFor: (path: string) => securityContextFor(path, options.securityContexts ?? config.securityContexts),
    impactFor: impact ? (path: string) => formatFileImpactForPrompt(impact!, path) : undefined,
    reader: provider,
    symbolSource: provider ? symbolSource : undefined,
    cache: options.batchCache,
    debugDir: options.debugDir,
    cacheSalt: JSON.stringify([modelForStage(config, 'review'), config.tiers]),
  };
  // reviewBatch reports per-file errors itself; only a CriticalFailureError escapes and aborts the run.
  const fileReviews = (await mapLimit(batches, config.reviewConcurrency, batch => reviewBatch(deps, batch, context))).flat();
  const failed = fileReviews.filter(r => r.status !== 'ok');
  for (const r of failed) log(`review of ${r.path} ${r.status}: ${r.error ?? ''}`);
  step('review', failed.length ? 'failed' : 'completed', `${fileReviews.length - failed.length} ok, ${failed.length} failed`);

  step('critic', 'running');
  const draft = fileReviews.flatMap(r => r.findings);
  const verdict = await critique(deps, draft, filesByPath);
  log(`critic: kept ${verdict.kept.length} of ${draft.length} finding(s)`);
  const findings = sortFindings(verdict.kept);
  step('critic', 'completed', `${findings.length} kept`);

  step('consolidate', 'running');
  let consolidated = await consolidate(deps, changeSet, {
    fileReviews,
    findings,
    summaries: triaged.summaries,
    docsSummary,
    impactSummary: impact ? formatImpactSummaryForPrompt(impact) : undefined,
    globalRules: rules.globalText() || undefined,
  });
  step('consolidate', 'completed');

  let removals: ReviewReport['removals'];
  if (config.skipValidation) {
    step('validate', 'skipped');
  } else {
    step('validate', 'running');
    const validated = await validateConsolidated(deps, consolidated, fileReviews, { files: filesByPath });
    consolidated = validated.consolidated;
    removals = validated.removals;
    step('validate', 'completed');
  }

  let persona: Persona | null = null;
  let presentation: ReviewReport['presentation'];
  try {
    persona = resolvePersona(config.persona, { dir: config.personaDir, rng: options.rng, warn: log });
  } catch (error) {
    log(`persona unavailable: ${(error as Error).message}`);
  }
  if (persona) {
    step('persona', 'running');
    presentation = await buildPresentation(deps, persona, {
      title: changeSet.title,
      consolidated,
      fileReviews,
      findings,
      files: filesByPath,
      impact,
    });
    step('persona', 'completed', persona.key);
  } else {
    step('persona', 'skipped');
  }

  const report: ReviewReport = {
    title: changeSet.title,
    headSha: changeSet.headSha,
    overview: consolidated.overview,
    risk: consolidated.risk,
    highlights: consolidated.highlights,
    intro: presentation?.intro || undefined,
    findings,
    rejected: verdict.rejected,
    skipped: [...staticSkipped, ...triaged.skipped],
    reviewedFiles: triaged.reviewable.map(f => f.path),
    validated: verdict.validated,
    cost: cost.summary(),
    fileReviews,
    consolidated,
    removals,
    presentation,
    impact,
    docsSummary,
  };

  // A run with failed batches is not cached, so the next run retries them.
  if (failed.length === 0) await cache?.put(key, report);
  return { report, cached: false };
}
