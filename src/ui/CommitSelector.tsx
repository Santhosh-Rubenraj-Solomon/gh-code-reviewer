import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { scrollWindow, useCursor, useListHeight } from './shared';

export interface CommitOption {
  sha: string;
  subject: string;
  author?: string;
  /** Shown as given, e.g. a relative date like "2 days ago". */
  date?: string;
}

export interface CommitSelectorProps {
  /** Commits in the order the caller wants them back (oldest first for a diff range). */
  commits: CommitOption[];
  /** Selected SHAs, always in the same order as `commits`. */
  onConfirm: (shas: string[]) => void;
  onCancel: () => void;
  rows?: number;
}

/** e.g. "2 days ago · Ada", whichever of the two the caller supplied. */
function meta(commit: CommitOption): string {
  return [commit.date, commit.author].filter(Boolean).join(' · ');
}

export function CommitSelector({ commits, onConfirm, onCancel, rows }: CommitSelectorProps) {
  const [index] = useCursor(commits.length);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(commits.map(c => c.sha)));
  const [error, setError] = useState('');
  const height = useListHeight(6, rows);

  useInput((input, key) => {
    if (input === 'q' || key.escape) return onCancel();
    if (input === ' ' && commits[index]) {
      const sha = commits[index]!.sha;
      setSelected(prev => {
        const next = new Set(prev);
        if (next.has(sha)) next.delete(sha);
        else next.add(sha);
        return next;
      });
      setError('');
    } else if (input === 'a') {
      setSelected(new Set(commits.map(c => c.sha)));
      setError('');
    } else if (input === 'n') {
      setSelected(new Set());
    } else if (key.return) {
      const picked = commits.filter(c => selected.has(c.sha)).map(c => c.sha);
      if (!picked.length) setError('Select at least one commit.');
      else onConfirm(picked);
    }
  });

  const { start, end } = scrollWindow(commits.length, index, height);
  return (
    <Box flexDirection="column">
      <Text bold>
        Select commits to review ({selected.size}/{commits.length} selected)
      </Text>
      {commits.slice(start, end).map((commit, offset) => {
        const i = start + offset;
        return (
          <Text key={commit.sha} color={i === index ? 'cyan' : undefined}>
            {i === index ? '› ' : '  '}
            {selected.has(commit.sha) ? '[x]' : '[ ]'} {commit.sha.slice(0, 7)} {commit.subject}
            {meta(commit) ? <Text dimColor> — {meta(commit)}</Text> : null}
          </Text>
        );
      })}
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>space toggle · a all · n none · Enter confirm · q/Esc cancel</Text>
    </Box>
  );
}
