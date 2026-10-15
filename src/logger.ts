import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatTimingSummary, summarizeTimings, type TimingCollector } from './timing';

export const LOG_STEPS = [
  'init',
  'fetch',
  'impact',
  'triage',
  'batch',
  'review',
  'validate',
  'persona',
  'publish',
  'complete',
] as const;
export type LogStep = (typeof LOG_STEPS)[number];
export type LogLevel = 'info' | 'warn' | 'error';

export interface LogLine {
  at: number;
  step: LogStep;
  level: LogLevel;
  message: string;
}

export type LoggerEvent =
  | { type: 'line'; line: LogLine }
  | { type: 'step'; step: LogStep; previous: LogStep }
  | { type: 'cost'; step: LogStep; usd: number };

export type LoggerListener = (event: LoggerEvent) => void;

export interface StepLoggerOptions {
  maxLinesPerStep?: number;
  /** Mirror every line to `write` (stderr by default). CI has no Ink UI, so it turns this on. */
  console?: boolean;
  write?: (text: string) => void;
  now?: () => number;
  timings?: TimingCollector;
}

interface StepState {
  lines: LogLine[];
  /** Lines dropped once the cap was hit, so the dump can say the log was trimmed. */
  dropped: number;
  costUsd: number;
  startedAt?: number;
  endedAt?: number;
}

/** Collects progress per pipeline step for the interactive UI, CI output and a post-run log file. */
export class StepLogger {
  private readonly steps = new Map<LogStep, StepState>();
  private readonly listeners = new Set<LoggerListener>();
  private readonly maxLines: number;
  private readonly write: (text: string) => void;
  private readonly now: () => number;
  private readonly timings?: TimingCollector;
  private consoleOn: boolean;
  private current: LogStep = 'init';

  constructor(options: StepLoggerOptions = {}) {
    this.maxLines = options.maxLinesPerStep ?? 500;
    this.consoleOn = options.console ?? false;
    this.write = options.write ?? (text => process.stderr.write(`${text}\n`));
    this.now = options.now ?? Date.now;
    this.timings = options.timings;
    for (const step of LOG_STEPS) this.steps.set(step, { lines: [], dropped: 0, costUsd: 0 });
    this.steps.get('init')!.startedAt = this.now();
  }

  get currentStep(): LogStep {
    return this.current;
  }

  setConsolePassthrough(on: boolean): void {
    this.consoleOn = on;
  }

  setStep(step: LogStep): void {
    if (step === this.current) return;
    const previous = this.current;
    const now = this.now();
    this.state(previous).endedAt = now;
    const next = this.state(step);
    next.startedAt ??= now;
    next.endedAt = undefined;
    this.current = step;
    this.emit({ type: 'step', step, previous });
  }

  info(message: string, step?: LogStep): void {
    this.add('info', message, step);
  }

  warn(message: string, step?: LogStep): void {
    this.add('warn', message, step);
  }

  error(message: string, step?: LogStep): void {
    this.add('error', message, step);
  }

  /** A plain `(message) => void` for code that takes a log function, such as StageDeps. */
  readonly log = (message: string): void => this.info(message);

  addCost(usd: number, step: LogStep = this.current): void {
    const state = this.state(step);
    state.costUsd += usd;
    this.emit({ type: 'cost', step, usd: state.costUsd });
  }

  lines(step: LogStep = this.current): LogLine[] {
    return [...this.state(step).lines];
  }

  costs(): Record<LogStep, number> {
    return Object.fromEntries(LOG_STEPS.map(s => [s, this.state(s).costUsd])) as Record<LogStep, number>;
  }

  totalCost(): number {
    return LOG_STEPS.reduce((sum, s) => sum + this.state(s).costUsd, 0);
  }

  subscribe(listener: LoggerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Writes `review-log-<timestamp>.txt` into `dir` and returns its path. */
  dumpToFile(dir: string, now: Date = new Date(this.now())): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `review-log-${now.toISOString().replace(/[:.]/g, '-')}.txt`);
    writeFileSync(path, this.render(now));
    return path;
  }

  render(now: Date = new Date(this.now())): string {
    const out: string[] = [`Review log written ${now.toISOString()}`, ''];
    for (const step of LOG_STEPS) {
      const state = this.state(step);
      if (state.lines.length === 0 && state.costUsd === 0 && state.startedAt === undefined) continue;
      const took =
        state.startedAt === undefined ? '' : `, ${(((state.endedAt ?? now.getTime()) - state.startedAt) / 1000).toFixed(1)}s`;
      out.push(`== ${step} (${state.lines.length} line(s), $${state.costUsd.toFixed(4)}${took}) ==`);
      if (state.dropped > 0) out.push(`(${state.dropped} earlier line(s) dropped)`);
      for (const line of state.lines) {
        out.push(`${new Date(line.at).toISOString()} ${line.level.toUpperCase().padEnd(5)} ${line.message}`);
      }
      out.push('');
    }
    out.push('== cost ==');
    for (const step of LOG_STEPS) {
      const usd = this.state(step).costUsd;
      if (usd > 0) out.push(`${step}: $${usd.toFixed(4)}`);
    }
    out.push(`total: $${this.totalCost().toFixed(4)}`, '');
    out.push('== model timing ==');
    out.push(formatTimingSummary(summarizeTimings(this.timings?.list() ?? [])), '');
    return out.join('\n');
  }

  private state(step: LogStep): StepState {
    return this.steps.get(step)!;
  }

  private add(level: LogLevel, message: string, step: LogStep = this.current): void {
    const line: LogLine = { at: this.now(), step, level, message };
    const state = this.state(step);
    state.lines.push(line);
    if (state.lines.length > this.maxLines) {
      state.lines.shift();
      state.dropped++;
    }
    if (this.consoleOn) this.write(`[${step}] ${level === 'info' ? '' : `${level}: `}${message}`);
    this.emit({ type: 'line', line });
  }

  private emit(event: LoggerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
