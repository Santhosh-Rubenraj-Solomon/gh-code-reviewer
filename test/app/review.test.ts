import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProgressTracker } from '../../src/app/progress';
import { reviewCommand, type ReviewCommandOptions, type ReviewServices } from '../../src/app/review';
import { GitHubClient } from '../../src/github/client';
import { ReviewHistory } from '../../src/history';
import { StepLogger } from '../../src/logger';
import { fakeFetch, FakeLLM, SQL_PATCH, testConfig } from '../helpers';

const root = mkdtempSync(join(tmpdir(), 'ghr-app-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const UNSAFE = 'export function findUser(name: string) {\n  return db.query("SELECT * FROM users WHERE name = \'" + name + "\'");\n}\n';
const EVIDENCE = 'return db.query("SELECT * FROM users WHERE name = \'" + name + "\'");';

/** A repo on branch `feature` with one commit after `main` that introduces an injectable query. */
function makeRepo(): string {
  const dir = mkdtempSync(join(root, 'repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/db.ts'), 'export const db = { query: (sql: string) => sql };\n');
  writeFileSync(join(dir, 'src/users.ts'), "import { db } from './db';\nexport function findUser(name: string) {\n  return db.query('SELECT 1');\n}\n");
  writeFileSync(join(dir, 'src/admin.ts'), "import { findUser } from './users';\nexport const show = (n: string) => findUser(n);\n");
  git('add', '.');
  git('commit', '-qm', 'initial');
  git('checkout', '-qb', 'feature');
  writeFileSync(join(dir, 'src/users.ts'), `import { db } from './db';\n${UNSAFE}`);
  git('commit', '-qam', 'Look up users by name');
  return dir;
}

function llm() {
  return new FakeLLM({
    identify: () => ({ title: 'Look up users by name', problem: 'Admins need lookups.', solution: 'Query by name.' }),
    triage: () => {
      throw new Error('triage offline');
    },
    review: prompt =>
      JSON.stringify({
        fileReviews: [
          {
            path: 'src/users.ts',
            whatChanged: 'Query now uses the name.',
            findings: [
              {
                file: 'src/users.ts',
                line: 3,
                severity: 'critical',
                category: 'security',
                title: 'SQL injection in findUser',
                explanation: 'The name is concatenated into SQL.',
                evidence: EVIDENCE,
                suggestion: 'Use a bound parameter.',
              },
            ],
            positives: [],
            testingRecommendations: [],
          },
        ].filter(r => prompt.includes(r.path)),
        additionalFilesNeeded: { files: [], reason: '' },
      }),
    critic: () => ({ verdicts: [{ index: 0, keep: true, reason: 'evidence shows concatenation' }] }),
    consolidate: () => {
      throw new Error('consolidation offline');
    },
  });
}

function services(dir: string, overrides: Partial<ReviewServices> = {}): ReviewServices & { printed: string[] } {
  const printed: string[] = [];
  const logger = new StepLogger();
  return {
    config: testConfig({ persona: 'none', dataDir: join(dir, '.data'), editor: '' }),
    llm: llm(),
    logger,
    progress: new ProgressTracker(logger),
    history: new ReviewHistory({ path: join(dir, '.data', 'history.json') }),
    cwd: dir,
    env: {},
    print: text => printed.push(text),
    openReports: false,
    now: () => new Date('2026-10-15T10:00:00Z'),
    printed,
    ...overrides,
  };
}

describe('reviewCommand (local)', () => {
  test('reviews the branch against its base, writes the report and records history', async () => {
    const dir = makeRepo();
    const s = services(dir);
    const options: ReviewCommandOptions = { mode: 'local', target: 'main', identify: true, failOn: 'high' };
    const outcome = await reviewCommand(options, s);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.changeSet?.title).toBe('Look up users by name');
    expect(outcome.changeSet?.description).toContain('**Problem:** Admins need lookups.');
    expect(outcome.report?.findings.map(f => f.title)).toEqual(['SQL injection in findUser']);
    expect(outcome.report?.impact?.files['src/users.ts']?.impacted.map(i => i.path)).toEqual(['src/admin.ts']);
    expect(outcome.report?.risk).toBe('high');

    const reportPath = outcome.outputs.find(p => p.endsWith('.md'))!;
    expect(readFileSync(reportPath, 'utf8')).toContain('SQL injection in findUser');
    expect(s.printed.join('\n')).toContain('**Merge risk:** HIGH');
    expect(s.history!.latest()).toMatchObject({ kind: 'local', target: 'main', title: 'Look up users by name' });

    const snapshot = s.progress!.snapshot();
    expect(snapshot.steps.find(st => st.id === 'impact')?.status).toBe('done');
    expect(snapshot.steps.find(st => st.id === 'publish')?.status).toBe('skipped');
  });

  test('an explicit title wins over identification, and --fail-on below the findings passes', async () => {
    const dir = makeRepo();
    const s = services(dir);
    const outcome = await reviewCommand({ mode: 'local', target: 'main', title: 'Mine', problem: 'P', failOn: 'low' }, s);
    expect(outcome.changeSet?.title).toBe('Mine');
    expect(outcome.changeSet?.description).toBe('**Problem:** P');
    expect((s.llm as FakeLLM).callsFor('identify')).toHaveLength(0);
    expect(outcome.exitCode).toBe(2);
    const passing = await reviewCommand({ mode: 'local', target: 'main', title: 'Mine', fresh: true }, services(dir));
    expect(passing.exitCode).toBe(0);
  });

  test('a person can confirm, edit or cancel how a local change is described', async () => {
    const dir = makeRepo();
    const drafts: string[] = [];
    const edited = await reviewCommand(
      { mode: 'local', target: 'main', identify: true },
      services(dir, {
        confirmIdentity: async draft => {
          drafts.push(draft.title);
          return { ...draft, title: 'Edited title' };
        },
      }),
    );
    expect(drafts).toEqual(['Look up users by name']);
    expect(edited.changeSet?.title).toBe('Edited title');

    let generated = '';
    const s = services(dir, {
      confirmIdentity: async (draft, generate) => {
        expect(draft.title).toBe('');
        generated = (await generate()).title;
        return null;
      },
    });
    const cancelled = await reviewCommand({ mode: 'local', target: 'main', fresh: true }, s);
    expect(generated).toBe('Look up users by name');
    expect(cancelled.exitCode).toBe(1);
    expect(cancelled.report).toBeUndefined();
    expect(s.printed).toEqual(['Review cancelled.']);
  });

  test('model spend is shown per step as calls finish', async () => {
    const dir = makeRepo();
    const { TimingCollector } = await import('../../src/timing');
    const timings = new TimingCollector();
    const s = services(dir, { timings });
    s.config.tiers.deep = 'anthropic:claude-opus-5-5';
    timings.record({
      callId: '1',
      stage: 'review',
      model: 'anthropic:claude-opus-5-5',
      startedAt: 0,
      ttfcMs: null,
      durationMs: 1,
      inputTokens: 1_000_000,
      outputTokens: 0,
      status: 'success',
      streamed: false,
    } as never);
    // Recorded before the command subscribes: not counted.
    expect(s.logger.totalCost()).toBe(0);
    const run = reviewCommand({ mode: 'local', target: 'main', title: 't' }, s);
    timings.record({
      callId: '2',
      stage: 'review',
      model: 'anthropic:claude-opus-5-5',
      startedAt: 0,
      ttfcMs: null,
      durationMs: 1,
      inputTokens: 1_000_000,
      outputTokens: 0,
      status: 'success',
      streamed: false,
    } as never);
    await run;
    expect(s.logger.costs().review).toBeCloseTo(4);
  });

  test('--fresh reviews again instead of reusing cached file reviews', async () => {
    const dir = makeRepo();
    const { ReviewStore } = await import('../../src/store');
    const store = new ReviewStore({ path: join(dir, '.data', 'store') });
    try {
      const first = services(dir, { store });
      await reviewCommand({ mode: 'local', target: 'main', title: 't' }, first);
      expect((first.llm as FakeLLM).callsFor('review')).toHaveLength(1);

      const fresh = services(dir, { store });
      await reviewCommand({ mode: 'local', target: 'main', title: 't', fresh: true }, fresh);
      expect((fresh.llm as FakeLLM).callsFor('review')).toHaveLength(1);

      const cached = services(dir, { store });
      await reviewCommand({ mode: 'local', target: 'main', title: 't' }, cached);
      expect((cached.llm as FakeLLM).calls).toHaveLength(0);
      expect(cached.progress!.snapshot().steps.find(st => st.id === 'review')).toMatchObject({ status: 'done', detail: 'cached' });
    } finally {
      await store.close();
    }
  });

  test('an aborted run marks the step that was running as failed', async () => {
    const dir = makeRepo();
    const s = services(dir, {
      llm: new FakeLLM({
        triage: () => ({ files: [] }),
        review: () => {
          throw Object.assign(new Error('every model failed'), { name: 'CriticalFailureError' });
        },
      }),
    });
    await expect(reviewCommand({ mode: 'local', target: 'main', title: 't' }, s)).rejects.toThrow('every model failed');
    expect(s.progress!.snapshot().steps.find(st => st.id === 'review')?.status).toBe('failed');
  });

  test('--post outside a pull request is rejected before any model call', async () => {
    const dir = makeRepo();
    const s = services(dir);
    await expect(reviewCommand({ mode: 'local', target: 'main', title: 't', post: true }, s)).rejects.toThrow(/--post only works/);
    expect((s.llm as FakeLLM).calls).toHaveLength(0);
  });

  test('impact-only writes graphs and a test plan without any model call', async () => {
    const dir = makeRepo();
    const s = services(dir);
    const outcome = await reviewCommand({ mode: 'local', target: 'main', title: 'x', impactOnly: true, exportTests: true }, s);
    expect((s.llm as FakeLLM).calls).toHaveLength(0);
    expect(outcome.outputs.map(p => p.split('/').pop())).toEqual([
      'impact-graph.mmd',
      'impact-graph.txt',
      'impact-summary.json',
      'test-plan.json',
    ]);
    expect(readFileSync(outcome.outputs[0]!, 'utf8')).toContain('graph LR');
    expect(s.printed[0]).toContain('src/admin.ts');
  });

  test('uncommitted mode reviews the working tree', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'src/new.ts'), 'export const x = 1;\n');
    const s = services(dir);
    const outcome = await reviewCommand({ mode: 'uncommitted', title: 'wip' }, s);
    expect(outcome.changeSet?.files.map(f => f.path)).toEqual(['src/new.ts']);
    expect(s.history!.latest()).toMatchObject({ kind: 'uncommitted', title: 'wip' });
  });

  test('nothing to review is reported, not treated as an error', async () => {
    const dir = makeRepo();
    const s = services(dir);
    const outcome = await reviewCommand({ mode: 'uncommitted' }, s);
    expect(outcome.exitCode).toBe(0);
    expect(s.printed).toEqual(['No changes to review.']);
  });
});

describe('reviewCommand (pull request)', () => {
  const ref = 'santhosh/demo#7';
  const content = `import { db } from './db';\n${UNSAFE}`;

  function github() {
    return fakeFetch([
      {
        method: 'GET',
        match: /\/pulls\/7$/,
        respond: () => ({ json: { title: 'Lookup', body: 'Adds lookup', base: { ref: 'main' }, head: { sha: 'headsha1' } } }),
      },
      {
        method: 'GET',
        match: /\/pulls\/7\/files$/,
        respond: () => ({
          json: [
            {
              filename: 'src/users.ts',
              status: 'modified',
              additions: 2,
              deletions: 1,
              patch: SQL_PATCH.replace(/SELECT[^\n]*\n\+  return db.query\(sql\);/, `${EVIDENCE.slice(7)}`),
            },
          ],
        }),
      },
      {
        method: 'GET',
        match: /\/contents\/src\/users\.ts$/,
        respond: () => ({ json: { type: 'file', size: 100, encoding: 'base64', content: Buffer.from(content).toString('base64') } }),
      },
      { method: 'GET', match: /\/tarball\//, respond: () => ({ status: 404, json: { message: 'Not Found' } }) },
      { method: 'GET', match: /\/pulls\/7\/comments$/, respond: () => ({ json: [] }) },
      { method: 'POST', match: /\/reviews$/, respond: () => ({ json: {} }) },
      { method: 'GET', match: /\/issues\/7\/comments$/, respond: () => ({ json: [] }) },
      { method: 'POST', match: /\/issues\/7\/comments$/, respond: () => ({ status: 201, json: {} }) },
    ]);
  }

  test('loads the PR, falls back to diff-only review without the tarball, and posts', async () => {
    const dir = mkdtempSync(join(root, 'pr-'));
    const fake = github();
    const s = services(dir, { github: () => new GitHubClient({ token: 't', fetch: fake.fetch }) });
    const outcome = await reviewCommand({ mode: 'pr', target: ref, post: true }, s);

    expect(outcome.changeSet?.pull).toEqual({ owner: 'santhosh', repo: 'demo', number: 7 });
    expect(outcome.report?.impact).toBeUndefined();
    expect(s.logger.lines('fetch').some(l => l.message.includes('reviewing the diff only'))).toBe(true);
    const posted = fake.requests.filter(r => r.method === 'POST').map(r => new URL(r.url).pathname);
    expect(posted).toContain('/repos/santhosh/demo/issues/7/comments');
    expect(s.history!.latest()).toMatchObject({ kind: 'pr', target: ref });
    expect(s.progress!.snapshot().steps.find(st => st.id === 'publish')?.status).toBe('done');
  });

  test('inside a workflow for the same repo, the checkout is used for repository files', async () => {
    const dir = makeRepo();
    const fake = github();
    const s = services(dir, {
      github: () => new GitHubClient({ token: 't', fetch: fake.fetch }),
      env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'santhosh/demo', GITHUB_WORKSPACE: dir },
    });
    const outcome = await reviewCommand({ mode: 'pr', target: ref }, s);
    expect(fake.requests.some(r => r.url.includes('/tarball/'))).toBe(false);
    expect(outcome.report?.impact).toBeDefined();
  });

  test('without a token a PR review fails clearly', async () => {
    const dir = mkdtempSync(join(root, 'pr-'));
    await expect(reviewCommand({ mode: 'pr', target: ref }, services(dir))).rejects.toThrow(/GITHUB_TOKEN/);
  });

  test('--json prints the whole report', async () => {
    const dir = mkdtempSync(join(root, 'pr-'));
    const fake = github();
    const s = services(dir, { github: () => new GitHubClient({ token: 't', fetch: fake.fetch }) });
    await reviewCommand({ mode: 'pr', target: ref, json: true, out: join(dir, 'full.md') }, s);
    expect(JSON.parse(s.printed[0]!).title).toBe('Lookup');
    expect(existsSync(join(dir, 'full.md'))).toBe(true);
  });
});
