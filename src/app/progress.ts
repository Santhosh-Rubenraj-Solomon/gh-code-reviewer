import type { LogStep, StepLogger } from '../logger';
import type { RunStep, StepState } from '../pipeline/run';
import type { SessionStage } from '../store/review-store';
import type { ProgressSnapshot, ProgressSource, StepStatus } from '../ui/ReviewProgress';

/** The logger groups the finer-grained pipeline steps into the steps a person watches. */
export const LOG_STEP_FOR: Record<RunStep, LogStep> = {
  impact: 'impact',
  docs: 'triage',
  triage: 'triage',
  batching: 'batch',
  review: 'review',
  critic: 'review',
  consolidate: 'validate',
  validate: 'validate',
  persona: 'persona',
};

/** Pipeline steps share their names with the store's session stages. */
export const SESSION_STAGE_FOR: Record<RunStep, SessionStage> = {
  impact: 'impact',
  docs: 'docs',
  triage: 'triage',
  batching: 'batching',
  review: 'review',
  critic: 'critic',
  consolidate: 'consolidate',
  validate: 'validate',
  persona: 'persona',
};

const VISIBLE_STEPS: { id: LogStep; label: string }[] = [
  { id: 'fetch', label: 'Fetch changes' },
  { id: 'impact', label: 'Impact analysis' },
  { id: 'triage', label: 'Triage' },
  { id: 'batch', label: 'Plan batches' },
  { id: 'review', label: 'Review' },
  { id: 'validate', label: 'Summarise and verify' },
  { id: 'persona', label: 'Presentation' },
  { id: 'publish', label: 'Publish' },
];

const STATUS_FOR: Record<StepState, StepStatus> = {
  running: 'running',
  completed: 'done',
  skipped: 'skipped',
  failed: 'failed',
};

/** Tracks step states and exposes them in the shape the Ink progress view reads. */
export class ProgressTracker implements ProgressSource {
  private readonly status = new Map<LogStep, StepStatus>();
  private readonly detail = new Map<LogStep, string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly logger: StepLogger) {
    logger.subscribe(() => this.emit());
  }

  mark(step: LogStep, state: StepState, detail?: string): void {
    // A grouped step stays "running" until its last sub-step finishes; failures stick.
    if (this.status.get(step) === 'failed' && state !== 'failed') return;
    this.status.set(step, STATUS_FOR[state]);
    if (detail) this.detail.set(step, detail);
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ProgressSnapshot {
    const costs = this.logger.costs();
    return {
      steps: VISIBLE_STEPS.map(({ id, label }) => ({
        id,
        label,
        status: this.status.get(id) ?? 'pending',
        costUsd: costs[id] || undefined,
        detail: this.detail.get(id),
      })),
      logs: this.logger.lines().map(l => l.message),
      totalCostUsd: this.logger.totalCost(),
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
