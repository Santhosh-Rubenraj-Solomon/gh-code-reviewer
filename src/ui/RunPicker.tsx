import { Box, Text, useInput } from 'ink';
import { relativeTime, scrollWindow, useCursor, useListHeight } from './shared';

export interface RunEntry {
  id: string;
  label: string;
  /** Epoch milliseconds or an ISO string. */
  createdAt?: number | string;
  detail?: string;
}

export interface RunPickerProps<T extends RunEntry> {
  entries: T[];
  onPick: (entry: T) => void;
  onCancel: () => void;
  now?: () => number;
  rows?: number;
}

export function RunPicker<T extends RunEntry>({ entries, onPick, onCancel, now = Date.now, rows }: RunPickerProps<T>) {
  const [index] = useCursor(entries.length);
  const height = useListHeight(4, rows);
  useInput((input, key) => {
    if (input === 'q' || key.escape) onCancel();
    else if (key.return && entries[index]) onPick(entries[index]!);
  });

  if (!entries.length) {
    return (
      <Box flexDirection="column">
        <Text>No previous reviews yet.</Text>
        <Text dimColor>q/Esc to go back</Text>
      </Box>
    );
  }

  const { start, end } = scrollWindow(entries.length, index, height);
  const at = now();
  return (
    <Box flexDirection="column">
      <Text bold>Pick a previous review to run again</Text>
      {entries.slice(start, end).map((entry, offset) => {
        const selected = start + offset === index;
        const when = entry.createdAt === undefined ? '' : relativeTime(new Date(entry.createdAt).getTime(), at);
        return (
          <Text key={entry.id} color={selected ? 'cyan' : undefined}>
            {selected ? '› ' : '  '}
            {entry.label}
            {when ? <Text dimColor> · {when}</Text> : null}
            {entry.detail ? <Text dimColor> · {entry.detail}</Text> : null}
          </Text>
        );
      })}
      <Text dimColor>↑/↓ move · Enter choose · q/Esc cancel</Text>
    </Box>
  );
}
