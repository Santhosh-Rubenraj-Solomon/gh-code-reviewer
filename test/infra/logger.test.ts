import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { StepLogger, type LoggerEvent } from '../../src/logger';
import { TimingCollector } from '../../src/timing';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

test('lines go to the current step, are capped per step, and notify listeners', () => {
  const logger = new StepLogger({ maxLinesPerStep: 3, now: () => 0 });
  const events: LoggerEvent[] = [];
  const off = logger.subscribe(e => events.push(e));
  logger.info('starting');
  logger.setStep('review');
  for (let i = 1; i <= 5; i++) logger.info(`line ${i}`);
  logger.warn('for fetch', 'fetch');

  expect(logger.currentStep).toBe('review');
  expect(logger.lines('init').map(l => l.message)).toEqual(['starting']);
  expect(logger.lines('review').map(l => l.message)).toEqual(['line 3', 'line 4', 'line 5']);
  expect(logger.lines('fetch')[0]).toMatchObject({ level: 'warn', step: 'fetch' });
  expect(events.filter(e => e.type === 'step')).toEqual([{ type: 'step', step: 'review', previous: 'init' }]);
  expect(events.filter(e => e.type === 'line')).toHaveLength(7);

  off();
  logger.info('unheard');
  expect(events.filter(e => e.type === 'line')).toHaveLength(7);
});

test('the default cap is 500 lines per step', () => {
  const logger = new StepLogger();
  for (let i = 0; i < 600; i++) logger.log(`l${i}`);
  expect(logger.lines()).toHaveLength(500);
  expect(logger.lines()[0]!.message).toBe('l100');
});

test('console passthrough mirrors lines only when enabled', () => {
  const written: string[] = [];
  const logger = new StepLogger({ write: t => written.push(t) });
  logger.info('quiet');
  logger.setConsolePassthrough(true);
  logger.setStep('publish');
  logger.error('loud');
  expect(written).toEqual(['[publish] error: loud']);
});

test('costs accumulate per step', () => {
  const logger = new StepLogger();
  logger.setStep('review');
  logger.addCost(0.5);
  logger.addCost(0.25);
  logger.addCost(0.1, 'triage');
  expect(logger.costs().review).toBe(0.75);
  expect(logger.totalCost()).toBeCloseTo(0.85);
});

test('dumpToFile writes step logs, costs and the timing summary', () => {
  dir = mkdtempSync(join(tmpdir(), 'ghr-logger-'));
  let clock = Date.UTC(2026, 0, 2, 3, 4, 5);
  const timings = new TimingCollector();
  timings.record({
    callId: 'review-1',
    stage: 'review',
    model: 'm',
    startedAt: clock,
    ttfcMs: 1200,
    durationMs: 4000,
    inputTokens: 100,
    outputTokens: 20,
    status: 'success',
    streamed: true,
  });
  const logger = new StepLogger({ now: () => (clock += 1000), timings, maxLinesPerStep: 1 });
  logger.setStep('review');
  logger.info('dropped');
  logger.info('reviewing batch 1');
  logger.addCost(0.0123);

  const path = logger.dumpToFile(join(dir, 'nested'), new Date(Date.UTC(2026, 0, 2, 3, 5, 0)));
  expect(basename(path)).toBe('review-log-2026-01-02T03-05-00-000Z.txt');
  const text = readFileSync(path, 'utf8');
  expect(text).toContain('== review (1 line(s), $0.0123');
  expect(text).toContain('(1 earlier line(s) dropped)');
  expect(text).toContain('reviewing batch 1');
  expect(text).not.toContain(' dropped\n');
  expect(text).toContain('review: $0.0123');
  expect(text).toContain('review: 1 call(s), 0 failed, duration avg 4.0s');
  expect(text).toContain('first chunk avg 1.2s');
});
