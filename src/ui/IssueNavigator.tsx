import { Box, Text, useInput } from 'ink';
import { severityCounts, type InteractiveIssue } from '../issues';
import { SEVERITY_ORDER } from '../types';
import { scrollWindow, SEVERITY_COLORS, useCursor, useListHeight } from './shared';

export interface IssueNavigatorProps {
  issues: InteractiveIssue[];
  onOpen: (issue: InteractiveIssue, index: number) => void;
  onExit: () => void;
  initialIndex?: number;
  /** Terminal height override; defaults to the real terminal's rows. */
  rows?: number;
}

export function IssueNavigator({ issues, onOpen, onExit, initialIndex = 0, rows }: IssueNavigatorProps) {
  const [index] = useCursor(issues.length, true, initialIndex);
  const height = useListHeight(10, rows);
  useInput((input, key) => {
    if (input === 'q' || key.escape) onExit();
    else if (key.return && issues[index]) onOpen(issues[index]!, index);
  });

  const counts = severityCounts(issues);
  if (!issues.length) {
    return (
      <Box flexDirection="column">
        <Text color="green">No issues to discuss. Nice work.</Text>
        <Text dimColor>q to exit</Text>
      </Box>
    );
  }

  const { start, end } = scrollWindow(issues.length, index, height);
  const current = issues[index]!;
  return (
    <Box flexDirection="column">
      <Text bold>
        {issues.length} issue{issues.length === 1 ? '' : 's'}:{' '}
        {SEVERITY_ORDER.filter(s => counts[s]).map((s, i) => (
          <Text key={s} color={SEVERITY_COLORS[s]}>
            {i ? ', ' : ''}
            {counts[s]} {s}
          </Text>
        ))}
      </Text>
      {start > 0 ? <Text dimColor>  ↑ {start} more</Text> : null}
      {issues.slice(start, end).map((issue, offset) => {
        const selected = start + offset === index;
        return (
          <Text key={issue.id} color={selected ? 'cyan' : undefined}>
            {selected ? '› ' : '  '}
            <Text color={SEVERITY_COLORS[issue.severity]}>[{issue.severity}]</Text> {issue.title}
            <Text dimColor> {issue.files[0] ?? ''}</Text>
          </Text>
        );
      })}
      {end < issues.length ? <Text dimColor>  ↓ {issues.length - end} more</Text> : null}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {current.id} · {current.type} · {current.files.join(', ') || 'no file'}
          {current.lines.length ? ` · line ${current.lines.join(', ')}` : ''}
        </Text>
        <Text dimColor>↑/↓ or j/k move · Enter discuss · q/Esc exit</Text>
      </Box>
    </Box>
  );
}
