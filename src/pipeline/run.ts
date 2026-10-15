import type { Config } from '../config';
import { CostTracker } from '../cost';
import type { LLMClient } from '../llm';
import { cacheKey, type ReportCache } from '../store';
import { SEVERITY_ORDER, type ChangedFile, type ChangeSet, type Finding, type ReviewReport } from '../types';
import { mapLimit } from '../utils/pool';
import { buildBatches } from './batcher';
import { consolidate } from './consolidator';
import { critique } from './critic';
import type { StageDeps } from './deps';
import { personaIntro } from './persona';
import { reviewBatch } from './reviewer';
import { staticTriage, triage } from './triage';

export interface RunOptions {
  config: Config;
  llm: LLMClient;
  rules?: string;
  cache?: ReportCache;
  /** Ignore a cached report for this commit and review again. */
  fresh?: boolean;
  log?: (message: string) => void;
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

/**
 * triage (static, then cheap model) -> batch -> deep review per batch
 * -> critic (grounding check, then model) -> consolidate -> optional persona intro.
 */
export async function runReview(
  changeSet: ChangeSet,
  options: RunOptions,
): Promise<{ report: ReviewReport; cached: boolean }> {
  const { config, llm, cache } = options;
  const log = options.log ?? (() => {});
  const key = cacheKey(changeSet, config);

  if (cache && !options.fresh) {
    const hit = cache.get(key);
    if (hit) {
      log(`reusing cached review for ${changeSet.headSha.slice(0, 7)}`);
      return { report: hit, cached: true };
    }
  }

  const cost = new CostTracker();
  const deps: StageDeps = { llm, cost, log };

  const { candidates, skipped: staticSkipped } = staticTriage(changeSet.files);
  log(`triage: ${candidates.length} candidate file(s), ${staticSkipped.length} skipped by rule`);
  const triaged = await triage(deps, changeSet, candidates);

  const batches = buildBatches(triaged.reviewable, {
    maxTokens: config.maxBatchTokens,
    maxFiles: config.maxFilesPerBatch,
  });
  log(`review: ${triaged.reviewable.length} file(s) in ${batches.length} batch(es)`);

  const context = {
    title: changeSet.title,
    description: changeSet.description,
    rules: options.rules,
    summaries: triaged.summaries,
  };
  const perBatch = await mapLimit(batches, config.reviewConcurrency, async (batch, i) => {
    try {
      return await reviewBatch(deps, batch, context);
    } catch (error) {
      log(`batch ${i + 1} failed and was skipped: ${(error as Error).message}`);
      return [];
    }
  });
  const draft = perBatch.flat();

  const filesByPath = new Map<string, ChangedFile>(changeSet.files.map(f => [f.path, f]));
  const verdict = await critique(deps, draft, filesByPath);
  log(`critic: kept ${verdict.kept.length} of ${draft.length} finding(s)`);

  const findings = sortFindings(verdict.kept);
  const overview = await consolidate(deps, changeSet, triaged.summaries, findings);
  const intro = await personaIntro(deps, config.persona, overview, findings);

  const report: ReviewReport = {
    title: changeSet.title,
    headSha: changeSet.headSha,
    overview: overview.overview,
    risk: overview.risk,
    highlights: overview.highlights,
    intro,
    findings,
    rejected: verdict.rejected,
    skipped: [...staticSkipped, ...triaged.skipped],
    reviewedFiles: triaged.reviewable.map(f => f.path),
    validated: verdict.validated,
    cost: cost.summary(),
  };

  await cache?.put(key, report);
  return { report, cached: false };
}
