import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Box, Text, useInput, useStdout } from 'ink';
import { useState } from 'react';
import type { Severity } from '../types';

export const SEVERITY_COLORS: Record<Severity, string> = {
  critical: 'red',
  high: 'magenta',
  medium: 'yellow',
  low: 'blue',
};

export function defaultRcPath(home: string = homedir()): string {
  return join(home, '.ghreviewrc.json');
}

export type RcObject = Record<string, unknown>;
export type RcReader = (path: string) => RcObject | null;
export type RcWriter = (path: string, text: string) => void | Promise<void>;

export const readRcFile: RcReader = path => {
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as RcObject) : null;
};

/** The rc file holds API keys, so it is only ever readable by its owner (chmod also fixes files created earlier). */
export const writeRcFile: RcWriter = (path, text) => {
  writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
};

export function serialiseRc(config: RcObject): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Visible rows for a scrolling list, leaving room for headers and footers. */
export function useListHeight(reserved: number, rows?: number): number {
  const { stdout } = useStdout();
  const total = rows ?? stdout?.rows ?? 24;
  return Math.max(3, total - reserved);
}

/** The slice of a list to render so that `selected` stays visible. */
export function scrollWindow(length: number, selected: number, height: number): { start: number; end: number } {
  if (length <= height) return { start: 0, end: length };
  const start = Math.min(Math.max(0, selected - Math.floor(height / 2)), length - height);
  return { start, end: start + height };
}

/** Arrow keys and j/k move a cursor through `length` items. */
export function useCursor(length: number, active = true, initial = 0): [number, (n: number) => void] {
  const [index, setIndex] = useState(Math.min(initial, Math.max(0, length - 1)));
  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') setIndex(i => Math.max(0, i - 1));
      if (key.downArrow || input === 'j') setIndex(i => Math.min(length - 1, i + 1));
    },
    { isActive: active },
  );
  return [Math.min(index, Math.max(0, length - 1)), setIndex];
}

export interface SelectItem<T> {
  label: string;
  value: T;
  hint?: string;
}

/** A minimal single-choice menu: arrows or j/k to move, Enter to choose, Esc to go back. */
export function SelectList<T>(props: {
  items: SelectItem<T>[];
  onSelect: (value: T) => void;
  onBack?: () => void;
  initialIndex?: number;
  height?: number;
}) {
  const [index] = useCursor(props.items.length, true, props.initialIndex ?? 0);
  useInput((_input, key) => {
    if (key.return && props.items[index]) props.onSelect(props.items[index]!.value);
    if (key.escape) props.onBack?.();
  });
  const { start, end } = scrollWindow(props.items.length, index, props.height ?? 12);
  return (
    <Box flexDirection="column">
      {props.items.slice(start, end).map((item, offset) => {
        const selected = start + offset === index;
        return (
          <Text key={`${start + offset}`} color={selected ? 'cyan' : undefined}>
            {selected ? '› ' : '  '}
            {item.label}
            {item.hint ? <Text dimColor> {item.hint}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

export function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
