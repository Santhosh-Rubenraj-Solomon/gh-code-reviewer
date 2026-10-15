import { SESSION_STAGES, type ReviewStore, type Session, type StageState } from '../store';

export type SessionsStore = Pick<ReviewStore, 'findSessions' | 'getSession' | 'deleteSession' | 'getStageData'>;

const STATE_MARK: Record<StageState, string> = {
  pending: '[ ]',
  running: '[~]',
  completed: '[x]',
  failed: '[!]',
  skipped: '[-]',
};

const SESSIONS_USAGE = [
  'Usage:',
  '  ghr sessions list [filter]   List recent review sessions',
  '  ghr sessions show <id>       Show one session and its stages',
  '  ghr sessions delete <id>     Delete a session and its stored data',
].join('\n');

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function completedCount(session: Session): number {
  return SESSION_STAGES.filter(s => session.stages[s].state === 'completed').length;
}

function fetchedPaths(data: unknown): string[] {
  const files = (data as { files?: unknown } | undefined)?.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap(f =>
    typeof f === 'string' ? [f] : typeof (f as { path?: unknown })?.path === 'string' ? [(f as { path: string }).path] : [],
  );
}

function listSessions(store: SessionsStore, filter?: string): string {
  const sessions = store.findSessions(filter, 20);
  if (sessions.length === 0) return filter ? `No sessions match "${filter}".` : 'No review sessions stored yet.';
  return sessions
    .map(
      s =>
        `${s.id}  ${s.source.type.padEnd(7)}  ${formatDate(s.updatedAt)}  ${cut(s.source.title || s.source.id, 50)}  ` +
        `stages ${completedCount(s)}/${SESSION_STAGES.length} completed`,
    )
    .join('\n');
}

function showSession(store: SessionsStore, id: string): string {
  const session = store.getSession(id);
  if (!session) return `No session with id "${id}".`;
  const out = [
    `Session ${session.id}`,
    `  source:  ${session.source.type} ${session.source.id}`.trimEnd(),
    `  title:   ${session.source.title}`,
    `  target:  ${session.target || '(none)'}`,
    `  created: ${formatDate(session.createdAt)}`,
    `  updated: ${formatDate(session.updatedAt)}`,
    '',
    'Stages:',
  ];
  for (const stage of SESSION_STAGES) {
    const s = session.stages[stage];
    out.push(`  ${STATE_MARK[s.state]} ${stage.padEnd(12)} ${s.state}${s.error ? ` - ${s.error}` : ''}`);
  }
  const files = fetchedPaths(store.getStageData(session.id, 'fetch'));
  if (files.length > 0) {
    out.push('', `Files (${files.length}):`, ...files.slice(0, 10).map(f => `  ${f}`));
    if (files.length > 10) out.push(`  ... and ${files.length - 10} more`);
  }
  return out.join('\n');
}

/** `ghr sessions list [filter] | show <id> | delete <id>`. */
export async function sessionsCommand(args: string[], deps: { store: SessionsStore }): Promise<string> {
  const [action = 'list', target] = args;
  switch (action.toLowerCase()) {
    case 'list':
    case 'ls':
      return listSessions(deps.store, target);
    case 'show':
      return target ? showSession(deps.store, target) : SESSIONS_USAGE;
    case 'delete':
    case 'rm':
      if (!target) return SESSIONS_USAGE;
      return (await deps.store.deleteSession(target)) ? `Deleted session ${target}.` : `No session with id "${target}".`;
    default:
      return SESSIONS_USAGE;
  }
}
