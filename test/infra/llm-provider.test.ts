import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { CriticalFailureError, MastraLLM, mastraAgentFactory } from '../../src/llm';
import { testConfig } from '../helpers';

/**
 * These tests run the real request path — Mastra Agent → Vercel AI SDK → Anthropic provider — against a
 * fake Anthropic HTTP endpoint, so request building, SSE parsing, usage and error surfacing are exercised
 * without a network or a key.
 */

const sse = (events: object[]) =>
  events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

function textStream(text: string) {
  return sse([
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 42, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...text.match(/.{1,8}/gs)!.map(part => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: part },
    })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ]);
}

function textMessage(text: string) {
  return {
    id: 'msg_2',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 42, output_tokens: 9 },
  };
}

interface Seen {
  model: string;
  stream: boolean;
  body: Record<string, unknown>;
}

function anthropicServer(respond: (req: Seen) => Response) {
  const seen: Seen[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const req = { model: String(body.model), stream: body.stream === true, body };
    seen.push(req);
    return respond(req);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function llmWith(fetchImpl: typeof fetch, overrides = {}) {
  const config = testConfig({ anthropicApiKey: 'sk-ant-test', maxRetries: 3, retryBaseDelayMs: 1, ...overrides });
  return new MastraLLM(config, {
    agentFactory: mastraAgentFactory(config, fetchImpl),
    sleep: async () => {},
    timeouts: { initMs: 2_000, firstChunkMs: 2_000, betweenChunksMs: 2_000, generateMs: 2_000, settleMs: 500 },
  });
}

describe('real provider path (fake Anthropic HTTP)', () => {
  test('streams text and reports provider usage', async () => {
    const { fetchImpl, seen } = anthropicServer(
      () => new Response(textStream('The query concatenates user input.'), { headers: { 'content-type': 'text/event-stream' } }),
    );
    const result = await llmWith(fetchImpl).generateText('review', 'Review this diff.');
    expect(result.text).toBe('The query concatenates user input.');
    expect(result.model).toBe('anthropic:claude-opus-5-5');
    expect(result.usage.inputTokens).toBe(42);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({ model: 'claude-opus-5-5', stream: true });
  });

  test('structured output parses into the schema', async () => {
    const answer = JSON.stringify({ verdicts: [{ index: 0, keep: true, reason: 'grounded' }] });
    const { fetchImpl } = anthropicServer(req =>
      req.stream
        ? new Response(textStream(answer), { headers: { 'content-type': 'text/event-stream' } })
        : Response.json(textMessage(answer)),
    );
    const schema = z.object({ verdicts: z.array(z.object({ index: z.number(), keep: z.boolean(), reason: z.string() })) });
    const result = await llmWith(fetchImpl).generateObject('critic', 'Judge these findings.', schema);
    expect(result.object.verdicts[0]).toEqual({ index: 0, keep: true, reason: 'grounded' });
  });

  test('a rejected key fails fast: one request, no retries, no other models, clear message', async () => {
    const { fetchImpl, seen } = anthropicServer(() =>
      Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 }),
    );
    const llm = llmWith(fetchImpl);
    const started = Date.now();
    const error = await llm.generateText('triage', 'x').catch(e => e);
    expect(error).toBeInstanceOf(CriticalFailureError);
    expect(error.message).toMatch(/invalid x-api-key/);
    expect(seen).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2_000);

    // Later stages in the same run do not call the provider again.
    const again = await llm.generateText('review', 'y').catch(e => e);
    expect(again).toBeInstanceOf(CriticalFailureError);
    expect(again.message).toMatch(/anthropic rejected the API key/);
    expect(seen).toHaveLength(1);
  });

  test('a bad request is not retried on the same model, but the next model is tried', async () => {
    const { fetchImpl, seen } = anthropicServer(req =>
      req.model === 'claude-opus-5-5'
        ? Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } }, { status: 400 })
        : new Response(textStream('ok'), { headers: { 'content-type': 'text/event-stream' } }),
    );
    const result = await llmWith(fetchImpl).generateText('review', 'z');
    expect(result.text).toBe('ok');
    expect(result.model).toBe('anthropic:claude-sonnet-5-5');
    expect(seen.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
  });
});
