import { Box, render, Text } from 'ink';
import { useState } from 'react';
import type { ChatSession } from '../chat';
import type { HistoryEntry } from '../history';
import { labelFor } from '../history';
import type { InteractiveIssue } from '../issues';
import type { CommitInfo } from '../sources/local-git';
import {
  CommitSelector,
  ConfigWizard,
  IdentityForm,
  type ChangeDescription,
  IssueChat,
  IssueNavigator,
  ModelWizard,
  ReviewProgress,
  RunPicker,
  type ConfigWizardProps,
  type ModelWizardProps,
  type ProgressSource,
} from '../ui';

/** Renders one Ink screen and resolves with whatever it reports back. */
function prompt<T>(build: (done: (value: T) => void) => React.ReactElement): Promise<T> {
  return new Promise(resolve => {
    let finish: (value: T) => void = () => {};
    const app = render(build(value => finish(value)));
    finish = value => {
      app.unmount();
      resolve(value);
    };
  });
}

/** Commits are offered oldest first so the selection reads as a range. */
export function pickCommits(commits: CommitInfo[]): Promise<string[] | null> {
  const options = [...commits]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(c => ({ sha: c.sha, subject: c.subject, date: c.relativeDate }));
  return prompt<string[] | null>(done => (
    <CommitSelector commits={options} onConfirm={shas => done(shas)} onCancel={() => done(null)} />
  ));
}

export function pickRun(entries: HistoryEntry[]): Promise<HistoryEntry | null> {
  const runs = entries.map((entry, i) => ({ id: String(i), label: labelFor(entry), createdAt: entry.at, entry }));
  return prompt<HistoryEntry | null>(done => (
    <RunPicker entries={runs} onPick={run => done(run.entry)} onCancel={() => done(null)} />
  ));
}

export function confirmIdentity(
  draft: ChangeDescription,
  generate: () => Promise<ChangeDescription>,
): Promise<ChangeDescription | null> {
  return prompt<ChangeDescription | null>(done => (
    <IdentityForm initial={draft} onGenerate={generate} onDone={done} onCancel={() => done(null)} />
  ));
}

export function runConfigWizard(props: Omit<ConfigWizardProps, 'onDone' | 'onCancel'>): Promise<boolean> {
  return prompt<boolean>(done => <ConfigWizard {...props} onDone={() => done(true)} onCancel={() => done(false)} />);
}

export function runModelWizard(props: Omit<ModelWizardProps, 'onDone' | 'onCancel'>): Promise<boolean> {
  return prompt<boolean>(done => <ModelWizard {...props} onDone={() => done(true)} onCancel={() => done(false)} />);
}

/** Live step list while a review runs; returns a function that removes it. */
export function showProgress(source: ProgressSource, title: string): () => void {
  const app = render(<ReviewProgress source={source} title={title} />);
  return () => app.unmount();
}

export interface ExplorerProps {
  issues: InteractiveIssue[];
  openSession: (issue: InteractiveIssue) => Promise<ChatSession>;
  onLeave: (issue: InteractiveIssue, session: ChatSession) => void;
  onExit: () => void;
  /** Called when a chat could not be opened (the error is also shown above the list). */
  onError?: (issue: InteractiveIssue, error: unknown) => void;
}

export function Explorer(props: ExplorerProps) {
  const [open, setOpen] = useState<{ issue: InteractiveIssue; session: ChatSession; index: number } | null>(null);
  const [lastIndex, setLastIndex] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);

  if (open) {
    return (
      <IssueChat
        issue={open.issue}
        session={open.session}
        onBack={() => {
          props.onLeave(open.issue, open.session);
          setLastIndex(open.index);
          setOpen(null);
        }}
      />
    );
  }
  return (
    <Box flexDirection="column">
      {failure ? <Text color="red">{failure}</Text> : null}
      <IssueNavigator
        issues={props.issues}
        initialIndex={lastIndex}
        onExit={props.onExit}
        onOpen={(issue, index) => {
          setFailure(null);
          setLastIndex(index);
          props.openSession(issue).then(
            session => setOpen({ issue, session, index }),
            (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              setFailure(`Could not open the chat for ${issue.id}: ${message}. Press Enter to try again.`);
              props.onError?.(issue, error);
            },
          );
        }}
      />
    </Box>
  );
}

/**
 * One session promise per issue, so going back and forth keeps the conversation. A failed promise is dropped,
 * so opening the issue again retries instead of replaying the same error forever.
 */
export function cachedSessions(
  createSession: (issue: InteractiveIssue) => Promise<ChatSession>,
): (issue: InteractiveIssue) => Promise<ChatSession> {
  const sessions = new Map<string, Promise<ChatSession>>();
  return issue => {
    let session = sessions.get(issue.id);
    if (!session) {
      // Async wrapper: a synchronous throw from createSession becomes a rejection like any other failure.
      session = (async () => createSession(issue))();
      sessions.set(issue.id, session);
      const created = session;
      created.catch(() => {
        if (sessions.get(issue.id) === created) sessions.delete(issue.id);
      });
    }
    return session;
  };
}

/** Issue list with a per-issue chat; one chat session per issue survives going back and forth. */
export function exploreIssues(
  issues: InteractiveIssue[],
  createSession: (issue: InteractiveIssue) => Promise<ChatSession>,
  /** Called when the person leaves a chat, e.g. to save its transcript. */
  onLeave: (issue: InteractiveIssue, session: ChatSession) => void = () => {},
  /** Called when a chat session could not be created; the person can retry from the list. */
  onError?: (issue: InteractiveIssue, error: unknown) => void,
): Promise<void> {
  const openSession = cachedSessions(createSession);
  return prompt<void>(done => (
    <Explorer issues={issues} openSession={openSession} onLeave={onLeave} onExit={() => done()} onError={onError} />
  ));
}
