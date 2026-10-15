import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import { cachedSessions, Explorer } from '../../src/app/interactive';
import { ChatSession, type ChatModel } from '../../src/chat';
import type { InteractiveIssue } from '../../src/issues';
import { FakeLLM } from '../helpers';

const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));
afterEach(() => cleanup());

const issue: InteractiveIssue = {
  id: 'ISSUE-1',
  title: 'Issue number 1',
  severity: 'high',
  type: 'bug',
  files: ['src/a.ts'],
  lines: [1],
  description: 'd',
  chatTier: 'standard',
};
const model: ChatModel = { stream: async () => ({ text: 'ok', inputTokens: 0, outputTokens: 0 }) };

describe('cachedSessions', () => {
  test('reuses a session but drops a failed one so the next open retries', async () => {
    let calls = 0;
    const open = cachedSessions(async i => {
      if (++calls === 1) throw new Error('model offline');
      return ChatSession.create({ issue: i, model, llm: new FakeLLM({}) });
    });
    await expect(open(issue)).rejects.toThrow('model offline');
    const session = await open(issue);
    expect(await open(issue)).toBe(session);
    expect(calls).toBe(2);
  });

  test('a synchronous throw becomes a rejection', async () => {
    const open = cachedSessions(() => {
      throw new Error('boom');
    });
    await expect(open(issue)).rejects.toThrow('boom');
  });
});

describe('Explorer', () => {
  test('shows an error line when a chat cannot be opened, reports it, and opens on retry', async () => {
    let calls = 0;
    const onError = mock();
    const openSession = cachedSessions(async i => {
      if (++calls === 1) throw new Error('model offline');
      return ChatSession.create({ issue: i, model, llm: new FakeLLM({}) });
    });
    const r = render(
      <Explorer issues={[issue]} openSession={openSession} onLeave={() => {}} onExit={() => {}} onError={onError} />,
    );
    await tick();
    r.stdin.write('\r');
    await tick(50);
    expect(r.lastFrame()).toContain('Could not open the chat for ISSUE-1: model offline');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe(issue);

    r.stdin.write('\r');
    await tick(50);
    expect(r.lastFrame()).not.toContain('Could not open');
    expect(r.lastFrame()).toContain('Esc back');
  });
});
