import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useState } from 'react';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface ProgressStep {
  id: string;
  label: string;
  status: StepStatus;
  costUsd?: number;
  detail?: string;
}

export interface ProgressSnapshot {
  steps: ProgressStep[];
  /** Recent log lines, oldest first. */
  logs: string[];
  totalCostUsd?: number;
}

/** What the progress view needs from the run logger: a change notification and the current state. */
export interface ProgressSource {
  subscribe(listener: () => void): () => void;
  snapshot(): ProgressSnapshot;
}

export interface ReviewProgressProps {
  source: ProgressSource;
  title?: string;
  logLines?: number;
}

const ICONS: Record<Exclude<StepStatus, 'running'>, { icon: string; color?: string }> = {
  pending: { icon: '○', color: 'gray' },
  done: { icon: '✔', color: 'green' },
  failed: { icon: '✖', color: 'red' },
  skipped: { icon: '–', color: 'gray' },
};

function formatCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function ReviewProgress({ source, title, logLines = 5 }: ReviewProgressProps) {
  const [snap, setSnap] = useState<ProgressSnapshot>(() => source.snapshot());
  useEffect(() => {
    setSnap(source.snapshot());
    return source.subscribe(() => setSnap(source.snapshot()));
  }, [source]);

  const logs = snap.logs.slice(-logLines);
  return (
    <Box flexDirection="column">
      {title ? <Text bold>{title}</Text> : null}
      {snap.steps.map(step => (
        <Box key={step.id}>
          {step.status === 'running' ? (
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
          ) : (
            <Text color={ICONS[step.status].color}>{ICONS[step.status].icon}</Text>
          )}
          <Text bold={step.status === 'running'}> {step.label}</Text>
          {step.detail ? <Text dimColor> {step.detail}</Text> : null}
          {step.costUsd ? <Text dimColor> {formatCost(step.costUsd)}</Text> : null}
        </Box>
      ))}
      {logs.length ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
          {logs.map((line, i) => (
            <Text key={i} dimColor wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      {snap.totalCostUsd !== undefined ? <Text>Cost so far: {formatCost(snap.totalCostUsd)}</Text> : null}
    </Box>
  );
}
