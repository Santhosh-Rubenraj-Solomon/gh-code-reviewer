import type { z } from 'zod';
import { defaultConfig, type Config } from '../src/config';
import { CostTracker } from '../src/cost';
import type { LLMClient, ObjectResult, TextResult } from '../src/llm';
import type { StageDeps } from '../src/pipeline/deps';
import type { ChangedFile, ChangeSet, Finding, Stage } from '../src/types';

type Handler = (prompt: string) => unknown;

/** Scripted LLM: each stage returns whatever its handler returns, or throws if the handler throws. */
export class FakeLLM implements LLMClient {
  calls: { stage: Stage; prompt: string }[] = [];

  constructor(
    private readonly handlers: Partial<Record<Stage, Handler>>,
    private readonly model = 'anthropic:claude-haiku-5-5',
  ) {}

  private run(stage: Stage, prompt: string): unknown {
    this.calls.push({ stage, prompt });
    const handler = this.handlers[stage];
    if (!handler) throw new Error(`FakeLLM: no handler for stage "${stage}"`);
    return handler(prompt);
  }

  async generateText(stage: Stage, prompt: string): Promise<TextResult> {
    const text = String(this.run(stage, prompt));
    return { text, usage: { inputTokens: 100, outputTokens: 10 }, model: this.model };
  }

  async generateObject<T>(stage: Stage, prompt: string, schema: z.ZodType<T>): Promise<ObjectResult<T>> {
    const object = schema.parse(this.run(stage, prompt));
    return { object, usage: { inputTokens: 1_000, outputTokens: 200 }, model: this.model };
  }

  callsFor(stage: Stage) {
    return this.calls.filter(c => c.stage === stage);
  }
}

export function makeDeps(llm: LLMClient): StageDeps & { logs: string[] } {
  const logs: string[] = [];
  return { llm, cost: new CostTracker(), log: m => logs.push(m), logs };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...defaultConfig('/tmp/ghr-test-home'), ...overrides };
}

export const SQL_PATCH = [
  '@@ -1,4 +1,5 @@',
  " import { db } from './db';",
  ' export async function findUser(name: string) {',
  '-  return db.query("SELECT * FROM users WHERE name = ?", [name]);',
  '+  const sql = "SELECT * FROM users WHERE name = \'" + name + "\'";',
  '+  return db.query(sql);',
  ' }',
].join('\n');

export const SQL_CONTENT = [
  "import { db } from './db';",
  'export async function findUser(name: string) {',
  '  const sql = "SELECT * FROM users WHERE name = \'" + name + "\'";',
  '  return db.query(sql);',
  '}',
  '',
].join('\n');

export function file(overrides: Partial<ChangedFile> & { path: string }): ChangedFile {
  return { status: 'modified', patch: SQL_PATCH, additions: 2, deletions: 1, ...overrides };
}

export function changeSet(files: ChangedFile[], overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    source: 'github',
    title: 'Look up users by name',
    description: 'Adds a helper used by the admin page.',
    baseRef: 'main',
    headSha: 'abc1234def5678',
    files,
    pull: { owner: 'santhosh', repo: 'demo', number: 7 },
    ...overrides,
  };
}

export function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: 'src/users.ts',
    line: 3,
    severity: 'critical',
    category: 'security',
    title: 'SQL injection in findUser',
    explanation: 'The name is concatenated into the SQL string, so a crafted name can run arbitrary SQL.',
    evidence: 'const sql = "SELECT * FROM users WHERE name = \'" + name + "\'";',
    suggestion: 'Use a parameterised query: db.query("... WHERE name = ?", [name]).',
    ...overrides,
  };
}

interface Route {
  method: string;
  match: RegExp;
  respond: (url: URL, body: unknown) => { status?: number; json?: unknown; text?: string };
}

/** Minimal fetch stand-in that records requests and answers from a route table. */
export function fakeFetch(routes: Route[]) {
  const requests: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url: url.toString(), body, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes.find(r => r.method === method && r.match.test(url.pathname));
    if (!route) return new Response(`no route for ${method} ${url.pathname}`, { status: 404 });
    const { status = 200, json, text } = route.respond(url, body);
    if (status === 204) return new Response(null, { status });
    return new Response(text ?? JSON.stringify(json ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch: impl as unknown as typeof fetch, requests };
}
