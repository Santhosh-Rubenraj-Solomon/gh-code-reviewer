export type CallStatus = 'success' | 'partial' | 'timeout' | 'error';

/** One model attempt. A call that falls back to another model produces one entry per model tried. */
export interface TimingEntry {
  callId: string;
  stage: string;
  model: string;
  /** Epoch milliseconds when the attempt started. */
  startedAt: number;
  /** Time to first streamed chunk; null for non-streaming attempts or when nothing arrived. */
  ttfcMs: number | null;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  status: CallStatus;
  streamed: boolean;
  error?: string;
}

export interface Spread {
  count: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

export interface StageTimingSummary {
  stage: string;
  calls: number;
  failures: number;
  /** Null when no attempt in this stage produced a first chunk. */
  ttfc: Spread | null;
  duration: Spread;
  inputTokens: number;
  outputTokens: number;
}

function spread(values: number[]): Spread | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, v) => sum + v, 0);
  return {
    count: values.length,
    avgMs: Math.round(total / values.length),
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
  };
}

export function summarizeTimings(entries: readonly TimingEntry[]): Record<string, StageTimingSummary> {
  const byStage = new Map<string, TimingEntry[]>();
  for (const entry of entries) {
    const list = byStage.get(entry.stage) ?? [];
    list.push(entry);
    byStage.set(entry.stage, list);
  }
  const summary: Record<string, StageTimingSummary> = {};
  for (const [stage, list] of byStage) {
    summary[stage] = {
      stage,
      calls: list.length,
      failures: list.filter(e => e.status === 'error' || e.status === 'timeout').length,
      ttfc: spread(list.flatMap(e => (e.ttfcMs === null ? [] : [e.ttfcMs]))),
      duration: spread(list.map(e => e.durationMs))!,
      inputTokens: list.reduce((sum, e) => sum + e.inputTokens, 0),
      outputTokens: list.reduce((sum, e) => sum + e.outputTokens, 0),
    };
  }
  return summary;
}

export type TimingListener = (entry: TimingEntry) => void;

/** In-memory record of model call timings for one run; the store persists them per session. */
export class TimingCollector {
  private entries: TimingEntry[] = [];
  private listeners = new Set<TimingListener>();

  record(entry: TimingEntry): void {
    this.entries.push(entry);
    for (const listener of this.listeners) listener(entry);
  }

  list(): TimingEntry[] {
    return [...this.entries];
  }

  reset(): void {
    this.entries = [];
  }

  summary(): Record<string, StageTimingSummary> {
    return summarizeTimings(this.entries);
  }

  /** Lets the store persist entries as they arrive. Returns an unsubscribe function. */
  onRecord(listener: TimingListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function formatTimingSummary(summary: Record<string, StageTimingSummary>): string {
  const rows = Object.values(summary);
  if (rows.length === 0) return 'No model calls were recorded.';
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  return rows
    .map(s => {
      const ttfc = s.ttfc ? `first chunk avg ${secs(s.ttfc.avgMs)} (${secs(s.ttfc.minMs)}-${secs(s.ttfc.maxMs)})` : 'no streamed chunks';
      return (
        `${s.stage}: ${s.calls} call(s), ${s.failures} failed, duration avg ${secs(s.duration.avgMs)} ` +
        `(${secs(s.duration.minMs)}-${secs(s.duration.maxMs)}), ${ttfc}, tokens ${s.inputTokens} in / ${s.outputTokens} out`
      );
    })
    .join('\n');
}
