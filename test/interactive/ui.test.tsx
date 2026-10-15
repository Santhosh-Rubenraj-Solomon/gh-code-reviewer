import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import { ChatSession, type ChatModel } from '../../src/chat';
import type { InteractiveIssue } from '../../src/issues';
import { DEFAULT_STAGE_TIERS, DEFAULT_TIERS } from '../../src/config';
import {
  CommitSelector,
  ConfigWizard,
  IssueChat,
  IssueNavigator,
  ModelWizard,
  ReviewProgress,
  RunPicker,
  type ProgressSnapshot,
} from '../../src/ui';
import { FakeLLM } from '../helpers';

const KEY = { down: '\u001B[B', up: '\u001B[A', enter: '\r', esc: '\u001B' };
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));

async function press(stdin: { write: (s: string) => void }, ...keys: string[]) {
  for (const k of keys) {
    stdin.write(k);
    await tick();
  }
}

afterEach(() => cleanup());

function issues(n: number): InteractiveIssue[] {
  const sev = ['critical', 'high', 'medium', 'low'] as const;
  return Array.from({ length: n }, (_, i) => ({
    id: `ISSUE-${i + 1}`,
    title: `Issue number ${i + 1}`,
    severity: sev[i % 4]!,
    type: 'bug',
    files: [`src/f${i}.ts`],
    lines: [i + 1],
    description: 'd',
    chatTier: 'standard' as const,
  }));
}

describe('IssueNavigator', () => {
  test('shows severity counts, navigates with arrows and j/k, opens with Enter', async () => {
    const onOpen = mock();
    const r = render(<IssueNavigator issues={issues(4)} onOpen={onOpen} onExit={() => {}} rows={30} />);
    await tick();
    expect(r.lastFrame()).toContain('4 issues');
    expect(r.lastFrame()).toContain('1 critical');
    expect(r.lastFrame()).toContain('1 low');
    await press(r.stdin, KEY.down, 'j', 'k');
    expect(r.lastFrame()).toContain('› [high] Issue number 2');
    await press(r.stdin, KEY.enter);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]![0].id).toBe('ISSUE-2');
  });

  test('scrolls a window sized to the terminal', async () => {
    const r = render(<IssueNavigator issues={issues(30)} onOpen={() => {}} onExit={() => {}} rows={15} />);
    await tick();
    expect(r.lastFrame()).toContain('Issue number 1 ');
    expect(r.lastFrame()).not.toContain('Issue number 20 ');
    expect(r.lastFrame()).toContain('more');
    await press(r.stdin, ...Array(20).fill('j'));
    expect(r.lastFrame()).toContain('› [critical] Issue number 21');
    expect(r.lastFrame()).not.toContain('Issue number 1 ');
  });

  test('q and Esc exit; empty list renders a message', async () => {
    const onExit = mock();
    const r = render(<IssueNavigator issues={issues(2)} onOpen={() => {}} onExit={onExit} />);
    await tick();
    await press(r.stdin, 'q', KEY.esc);
    await tick(50);
    expect(onExit).toHaveBeenCalledTimes(2);
    const e = render(<IssueNavigator issues={[]} onOpen={() => {}} onExit={() => {}} />);
    await tick();
    expect(e.lastFrame()).toContain('No issues');
  });
});

describe('IssueChat', () => {
  const model: ChatModel = {
    async stream(_m, _model, onChunk) {
      const parts = ['Guard ', 'it.', '<route tier="advanced" reason="x"/>'];
      for (const p of parts) onChunk?.(p);
      return { text: parts.join(''), inputTokens: 1, outputTokens: 1 };
    },
  };

  test('sends input, shows the stripped reply and updates the tier status line', async () => {
    const session = await ChatSession.create({ issue: issues(1)[0]!, model, llm: new FakeLLM({}) });
    const r = render(<IssueChat issue={session.issue} session={session} onBack={() => {}} />);
    await tick();
    expect(r.lastFrame()).toContain('tier standard');
    await press(r.stdin, 'why?', KEY.enter);
    await tick(50);
    const frame = r.lastFrame()!;
    expect(frame).toContain('you: why?');
    expect(frame).toContain('reviewer: Guard it.');
    expect(frame).not.toContain('<route');
    expect(frame).toContain('tier advanced');
  });

  test('commands show their output; /exit and Esc go back', async () => {
    const onBack = mock();
    const session = await ChatSession.create({ issue: issues(1)[0]!, model, llm: new FakeLLM({}) });
    const r = render(<IssueChat issue={session.issue} session={session} onBack={onBack} />);
    await tick();
    await press(r.stdin, '/model basic', KEY.enter);
    await tick(50);
    expect(r.lastFrame()).toContain('Using the basic tier');
    expect(r.lastFrame()).toContain('fixed');
    await press(r.stdin, '/exit', KEY.enter);
    await tick(50);
    expect(onBack).toHaveBeenCalledTimes(1);
    await press(r.stdin, KEY.esc);
    await tick(50);
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  test('a resumed session shows its earlier turns', async () => {
    const session = await ChatSession.create({
      issue: issues(1)[0]!,
      model,
      llm: new FakeLLM({}),
      initialTranscript: [
        { role: 'user', content: 'is this safe?' },
        { role: 'assistant', content: 'Not with untrusted input.' },
      ],
    });
    const r = render(<IssueChat issue={session.issue} session={session} onBack={() => {}} />);
    await tick();
    expect(r.lastFrame()).toContain('you: is this safe?');
    expect(r.lastFrame()).toContain('reviewer: Not with untrusted input.');
  });

  test('shows context warnings', async () => {
    const big: ChatModel = { stream: async () => ({ text: 'y'.repeat(104_000), inputTokens: 0, outputTokens: 0 }) };
    const session = await ChatSession.create({ issue: issues(1)[0]!, model: big, llm: new FakeLLM({}), autoCompact: false });
    const r = render(<IssueChat issue={session.issue} session={session} onBack={() => {}} visibleEntries={0} />);
    await tick();
    await press(r.stdin, 'hi', KEY.enter);
    await tick(50);
    expect(r.lastFrame()).toContain('Context is getting large');
  });
});

describe('CommitSelector', () => {
  const commits = [
    { sha: 'aaaaaaa1', subject: 'first' },
    { sha: 'bbbbbbb2', subject: 'second' },
    { sha: 'ccccccc3', subject: 'third' },
  ];

  test('all preselected; space toggles; confirm returns shas in the given order', async () => {
    const onConfirm = mock();
    const r = render(<CommitSelector commits={commits} onConfirm={onConfirm} onCancel={() => {}} />);
    await tick();
    expect(r.lastFrame()).toContain('3/3 selected');
    await press(r.stdin, KEY.down, ' ', KEY.enter);
    expect(onConfirm).toHaveBeenCalledWith(['aaaaaaa1', 'ccccccc3']);
  });

  test('n selects none and Enter then refuses; a selects all; q cancels', async () => {
    const onConfirm = mock();
    const onCancel = mock();
    const r = render(<CommitSelector commits={commits} onConfirm={onConfirm} onCancel={onCancel} />);
    await tick();
    await press(r.stdin, 'n', KEY.enter);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(r.lastFrame()).toContain('Select at least one commit');
    await press(r.stdin, 'a', KEY.enter);
    expect(onConfirm).toHaveBeenCalledWith(['aaaaaaa1', 'bbbbbbb2', 'ccccccc3']);
    await press(r.stdin, 'q');
    expect(onCancel).toHaveBeenCalled();
  });

  test('shows the date and, when present, the author', async () => {
    const r = render(
      <CommitSelector
        commits={[
          { sha: 'aaaaaaa1', subject: 'first', date: '2 days ago' },
          { sha: 'bbbbbbb2', subject: 'second', date: '3 hours ago', author: 'Ada' },
          { sha: 'ccccccc3', subject: 'third' },
        ]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await tick();
    const frame = r.lastFrame()!;
    expect(frame).toContain('first — 2 days ago');
    expect(frame).toContain('second — 3 hours ago · Ada');
    expect(frame).not.toContain('third —');
  });
});

describe('ReviewProgress', () => {
  test('renders steps, costs and the latest log lines, and updates on events', async () => {
    let snap: ProgressSnapshot = {
      steps: [
        { id: 'fetch', label: 'Fetch', status: 'done', costUsd: 0 },
        { id: 'review', label: 'Review', status: 'running', costUsd: 0.1234 },
        { id: 'publish', label: 'Publish', status: 'pending' },
      ],
      logs: ['l1', 'l2', 'l3'],
      totalCostUsd: 0.12,
    };
    const listeners = new Set<() => void>();
    const source = {
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      snapshot: () => snap,
    };
    const r = render(<ReviewProgress source={source} logLines={2} title="Reviewing" />);
    await tick();
    const frame = r.lastFrame()!;
    expect(frame).toContain('✔ Fetch');
    expect(frame).toContain('Review $0.12');
    expect(frame).toContain('○ Publish');
    expect(frame).toContain('l3');
    expect(frame).not.toContain('l1');
    snap = { ...snap, steps: snap.steps.map(s => ({ ...s, status: s.id === 'review' ? 'failed' : s.status })), logs: ['boom'] };
    listeners.forEach(l => l());
    await tick();
    expect(r.lastFrame()).toContain('✖ Review');
    expect(r.lastFrame()).toContain('boom');
    r.unmount();
    expect(listeners.size).toBe(0);
  });
});

describe('RunPicker', () => {
  test('picks an entry with relative time; Esc cancels', async () => {
    const onPick = mock();
    const onCancel = mock();
    const now = Date.parse('2026-06-01T12:00:00Z');
    const entries = [
      { id: '1', label: 'PR #7', createdAt: now - 2 * 3_600_000 },
      { id: '2', label: 'local: fix bug', createdAt: new Date(now - 120_000).toISOString(), detail: 'mentor' },
    ];
    const r = render(<RunPicker entries={entries} onPick={onPick} onCancel={onCancel} now={() => now} />);
    await tick();
    expect(r.lastFrame()).toContain('PR #7 · 2h ago');
    expect(r.lastFrame()).toContain('2m ago · mentor');
    await press(r.stdin, KEY.down, KEY.enter);
    expect(onPick.mock.calls[0]![0].id).toBe('2');
    await press(r.stdin, KEY.esc);
    await tick(50);
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('ConfigWizard', () => {
  test('walks Anthropic setup, validates keys, and merges into the existing rc file', async () => {
    const writes: { path: string; text: string }[] = [];
    const onDone = mock();
    const validate = async (k: string) => (k === 'bad' ? 'Anthropic API key was rejected' : null);
    const r = render(
      <ConfigWizard
        rcPath="/home/x/.ghreviewrc.json"
        readConfig={() => ({ maxRetries: 7, githubToken: 'old-token', persona: 'terse' })}
        writeConfig={(path, text) => void writes.push({ path, text })}
        validateAnthropicKey={validate}
        personas={['neutral', 'mentor', 'terse']}
        onDone={onDone}
        onCancel={() => {}}
      />,
    );
    await tick();
    expect(r.lastFrame()).toContain('Which model provider');
    await press(r.stdin, KEY.enter); // Anthropic
    expect(r.lastFrame()).toContain('Anthropic API key');
    await press(r.stdin, KEY.enter);
    expect(r.lastFrame()).toContain('is required');
    await press(r.stdin, 'bad', KEY.enter);
    await tick();
    expect(r.lastFrame()).toContain('rejected');
    await press(r.stdin, '\u007F', '\u007F', '\u007F', 'sk-good', KEY.enter);
    await tick();
    expect(r.lastFrame()).toContain('GitHub token');
    await press(r.stdin, KEY.enter); // keep existing token
    expect(r.lastFrame()).toContain('› terse');
    await press(r.stdin, KEY.up, KEY.enter); // mentor
    expect(r.lastFrame()).toContain('Editor');
    await press(r.stdin, KEY.enter); // default "code"
    await tick();
    expect(writes).toHaveLength(1);
    const saved = JSON.parse(writes[0]!.text);
    expect(saved).toEqual({ maxRetries: 7, githubToken: 'old-token', persona: 'mentor', anthropicApiKey: 'sk-good', editor: 'code' });
    expect(onDone).toHaveBeenCalledWith(saved);
    expect(r.lastFrame()).toContain('Saved');
  });

  test('Google-only setup asks for the Google key and sets Google tiers; Esc cancels', async () => {
    const writes: string[] = [];
    const onCancel = mock();
    const r = render(
      <ConfigWizard
        rcPath="/rc"
        readConfig={() => null}
        writeConfig={(_p, t) => void writes.push(t)}
        onDone={() => {}}
        onCancel={onCancel}
      />,
    );
    await tick();
    await press(r.stdin, KEY.down, KEY.enter);
    expect(r.lastFrame()).toContain('Google AI');
    await press(r.stdin, 'g-key', KEY.enter, 'ghp_x', KEY.enter, KEY.enter, KEY.enter);
    await tick();
    const saved = JSON.parse(writes[0]!);
    expect(saved.googleApiKey).toBe('g-key');
    expect(saved.githubToken).toBe('ghp_x');
    expect(saved.anthropicApiKey).toBeUndefined();
    expect(saved.tiers.deep).toStartWith('google:');

    const c = render(<ConfigWizard rcPath="/rc" readConfig={() => null} writeConfig={() => {}} onDone={() => {}} onCancel={onCancel} />);
    await tick();
    await press(c.stdin, KEY.esc);
    await tick(50);
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('ModelWizard', () => {
  const catalogue = [
    { id: 'anthropic:claude-opus-5-5', label: 'Opus' },
    { id: 'anthropic:claude-sonnet-5-5', label: 'Sonnet' },
    { id: 'google:gemini-3-flash-preview', label: 'Flash' },
  ];

  test('starts from the current config, edits a tier and a stage, and merges into the rc file', async () => {
    const writes: string[] = [];
    const onDone = mock();
    const current = { tiers: { ...DEFAULT_TIERS, cheap: 'anthropic:claude-sonnet-5-5' }, stageTiers: { ...DEFAULT_STAGE_TIERS } };
    const r = render(
      <ModelWizard
        current={current}
        catalogue={catalogue}
        keys={{ anthropicApiKey: 'a' }}
        rcPath="/rc"
        readConfig={() => ({ persona: 'mentor' })}
        writeConfig={(_p, t) => void writes.push(t)}
        onDone={onDone}
        onCancel={() => {}}
      />,
    );
    await tick();
    await press(r.stdin, KEY.enter); // tiers
    expect(r.lastFrame()).toContain('cheap Sonnet');
    await press(r.stdin, KEY.enter); // deep
    expect(r.lastFrame()).toContain('› Opus');
    await press(r.stdin, KEY.down, KEY.enter); // deep -> Sonnet
    expect(r.lastFrame()).toContain('deep Sonnet');
    await press(r.stdin, KEY.esc); // back to menu
    await press(r.stdin, KEY.down, KEY.enter); // stages
    await press(r.stdin, KEY.enter); // identify (cheap)
    await press(r.stdin, KEY.up, KEY.up, KEY.enter); // deep
    expect(r.lastFrame()).toContain('identify deep');
    await press(r.stdin, KEY.esc, KEY.down, KEY.down, KEY.enter); // save
    await tick();
    const saved = JSON.parse(writes[0]!);
    expect(saved.persona).toBe('mentor');
    expect(saved.tiers.deep).toBe('anthropic:claude-sonnet-5-5');
    expect(saved.tiers.cheap).toBe('anthropic:claude-sonnet-5-5');
    expect(saved.stageTiers.identify).toBe('deep');
    expect(onDone).toHaveBeenCalled();
  });

  test('refuses to save models whose API key is missing', async () => {
    const writes: string[] = [];
    const r = render(
      <ModelWizard
        current={{ tiers: { ...DEFAULT_TIERS }, stageTiers: { ...DEFAULT_STAGE_TIERS } }}
        catalogue={catalogue}
        keys={{}}
        rcPath="/rc"
        readConfig={() => null}
        writeConfig={(_p, t) => void writes.push(t)}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    await tick();
    await press(r.stdin, KEY.down, KEY.down, KEY.enter);
    await tick();
    expect(r.lastFrame()).toContain('ANTHROPIC_API_KEY');
    expect(writes).toHaveLength(0);
  });
});
