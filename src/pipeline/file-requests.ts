import { isAbsolute } from 'node:path';

export interface FileRequest {
  path: string;
  symbol?: string;
}

export interface FileReader {
  readFile(path: string): Promise<string | null>;
}

export interface FetchedFile {
  request: FileRequest;
  content?: string;
  error?: string;
  /** Explains a fallback or truncation. */
  note?: string;
}

export interface FetchOptions {
  maxFiles?: number;
  maxChars?: number;
  /** Returns the source of one named symbol in `code`, or null if it is not found. */
  symbolSource?: (path: string, code: string, name: string) => string | null;
}

/** Splits `path:symbol`, ignoring a Windows-style drive colon and trailing `:line` numbers. */
export function parseRequestLine(line: string): FileRequest | null {
  const text = line.trim().replace(/^[-*]\s+/, '').replace(/^`|`$/g, '');
  if (!text || text.startsWith('#') || text.startsWith('//')) return null;
  const colon = text.lastIndexOf(':');
  if (colon > 0) {
    const path = text.slice(0, colon).trim();
    const symbol = text.slice(colon + 1).trim();
    if (path && symbol && !/^\d+$/.test(symbol)) return { path, symbol };
    if (path) return { path };
  }
  return { path: text };
}

/** Requests listed in a `<file_requests>` block, one `path` or `path:symbol` per line. */
export function parseFileRequests(text: string): FileRequest[] {
  const out: FileRequest[] = [];
  for (const block of text.matchAll(/<file_requests>([\s\S]*?)<\/file_requests>/gi)) {
    for (const line of block[1]!.split('\n')) {
      const request = parseRequestLine(line);
      if (request) out.push(request);
    }
  }
  return dedupeRequests(out);
}

export function requestKey(r: FileRequest): string {
  return r.symbol ? `${r.path}:${r.symbol}` : r.path;
}

export function dedupeRequests(requests: FileRequest[]): FileRequest[] {
  const seen = new Set<string>();
  return requests.filter(r => {
    const key = requestKey(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unsafePath(path: string): string | null {
  if (isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('~')) return 'absolute paths are not allowed';
  if (path.split(/[\\/]/).includes('..')) return 'paths may not leave the repository';
  return null;
}

/** Reads requested repository files, enforcing a request cap, path safety and a size limit. */
export async function fetchRequestedFiles(
  requests: FileRequest[],
  reader: FileReader,
  options: FetchOptions = {},
): Promise<FetchedFile[]> {
  const maxFiles = options.maxFiles ?? 10;
  const maxChars = options.maxChars ?? 8_000;
  const unique = dedupeRequests(requests);
  const results: FetchedFile[] = [];

  for (const request of unique.slice(0, maxFiles)) {
    const problem = unsafePath(request.path);
    if (problem) {
      results.push({ request, error: problem });
      continue;
    }
    let code: string | null;
    try {
      code = await reader.readFile(request.path.replace(/^\.\//, ''));
    } catch (error) {
      results.push({ request, error: `could not read: ${(error as Error).message}` });
      continue;
    }
    if (code === null) {
      results.push({ request, error: 'file not found' });
      continue;
    }

    const notes: string[] = [];
    let content = code;
    if (request.symbol) {
      const symbol = options.symbolSource?.(request.path, code, request.symbol) ?? null;
      if (symbol) content = symbol;
      else notes.push(`symbol "${request.symbol}" not found; showing the whole file`);
    }
    if (content.length > maxChars) {
      notes.push(`truncated to the first ${maxChars} of ${content.length} characters`);
      content = content.slice(0, maxChars);
    }
    results.push({ request, content, note: notes.length ? notes.join('; ') : undefined });
  }

  for (const request of unique.slice(maxFiles)) {
    results.push({ request, error: `over the limit of ${maxFiles} files per round` });
  }
  return results;
}

export function formatRequestedFiles(results: FetchedFile[]): string {
  if (results.length === 0) return '';
  const parts = ['## Files you asked for'];
  for (const r of results) {
    const label = r.request.symbol ? `${r.request.path} (symbol ${r.request.symbol})` : r.request.path;
    parts.push('', `### ${label}`);
    if (r.error) {
      parts.push(`_Not available: ${r.error}_`);
      continue;
    }
    if (r.note) parts.push(`_Note: ${r.note}_`);
    parts.push('```', r.content ?? '', '```');
  }
  return parts.join('\n');
}
