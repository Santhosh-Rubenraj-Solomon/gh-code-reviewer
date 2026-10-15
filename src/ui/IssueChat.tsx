import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { useRef, useState } from 'react';
import type { ChatResult, ChatSession } from '../chat/session';
import type { InteractiveIssue } from '../issues';
import { SEVERITY_COLORS } from './shared';

/** The parts of ChatSession the chat screen uses. `conversation` lets a resumed chat show its earlier turns. */
export type ChatSessionLike = Pick<ChatSession, 'handleInput' | 'currentTier' | 'modelFor' | 'status' | 'routingMode'> &
  Partial<Pick<ChatSession, 'conversation'>>;

interface Entry {
  role: 'user' | 'assistant' | 'note' | 'error';
  text: string;
}

/** Earlier user/assistant turns of a resumed session, so reopening a chat does not look like a fresh one. */
function priorEntries(session: ChatSessionLike): Entry[] {
  return (session.conversation?.() ?? []).flatMap(turn =>
    turn.role === 'user' || turn.role === 'assistant' ? [{ role: turn.role, text: turn.content }] : [],
  );
}

export interface IssueChatProps {
  issue: InteractiveIssue;
  session: ChatSessionLike;
  onBack: () => void;
  /** How many past entries to keep on screen. */
  visibleEntries?: number;
}

const ROLE_STYLE: Record<Entry['role'], { label: string; color?: string }> = {
  user: { label: 'you', color: 'green' },
  assistant: { label: 'reviewer', color: 'cyan' },
  note: { label: '·' },
  error: { label: '!', color: 'red' },
};

export function IssueChat({ issue, session, onBack, visibleEntries = 12 }: IssueChatProps) {
  const [entries, setEntries] = useState<Entry[]>(() => priorEntries(session));
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setVersion] = useState(0);
  const busyRef = useRef(false);

  useInput((_input, key) => {
    if (key.escape && !busyRef.current) onBack();
  });

  const apply = (result: ChatResult) => {
    if (result.kind === 'exit') {
      onBack();
      return;
    }
    if (!result.output) return;
    const role: Entry['role'] = result.kind === 'reply' ? 'assistant' : result.kind === 'error' ? 'error' : 'note';
    setEntries(e => [...e, { role, text: result.output }]);
  };

  const submit = async (value: string) => {
    const text = value.trim();
    if (!text || busyRef.current) return;
    setInput('');
    setEntries(e => [...e, { role: 'user', text }]);
    busyRef.current = true;
    setBusy(true);
    let streamed = '';
    try {
      const result = await session.handleInput(text, chunk => {
        streamed += chunk;
        setStreaming(streamed);
      });
      apply(result);
    } catch (error) {
      setEntries(e => [...e, { role: 'error', text: (error as Error).message }]);
    } finally {
      busyRef.current = false;
      setBusy(false);
      setStreaming(null);
      setVersion(v => v + 1);
    }
  };

  const tier = session.currentTier();
  const status = session.status();
  const statusColor = status.level === 'ok' ? undefined : status.level === 'warning' ? 'yellow' : 'red';

  return (
    <Box flexDirection="column">
      <Text bold>
        <Text color={SEVERITY_COLORS[issue.severity]}>[{issue.severity}]</Text> {issue.title}
      </Text>
      <Text dimColor>{issue.files.join(', ')}</Text>
      <Box flexDirection="column" marginTop={1}>
        {entries.slice(-visibleEntries).map((entry, i) => (
          <Text key={i} color={ROLE_STYLE[entry.role].color}>
            <Text bold>{ROLE_STYLE[entry.role].label}: </Text>
            {entry.text}
          </Text>
        ))}
        {streaming !== null ? (
          <Text color="cyan">
            <Text bold>reviewer: </Text>
            {streaming}
          </Text>
        ) : null}
      </Box>
      {status.message ? <Text color={statusColor}>{status.message}</Text> : null}
      <Text dimColor>
        tier {tier} ({session.modelFor(tier)}) · {session.routingMode()} · ~{status.tokens} tokens
      </Text>
      <Box>
        {busy ? (
          <Text color="cyan">
            <Spinner type="dots" /> thinking…
          </Text>
        ) : (
          <>
            <Text color="green">› </Text>
            <TextInput value={input} onChange={setInput} onSubmit={submit} placeholder="Ask about this issue, or /help" />
          </>
        )}
      </Box>
      <Text dimColor>Enter send · /help commands · Esc back</Text>
    </Box>
  );
}
