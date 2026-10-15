const cache = new Map<string, RegExp>();

function escapeChar(ch: string): string {
  return /[.+^$()|[\]\\{}]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Converts a path glob to an anchored RegExp.
 * `**` spans any number of directories (and `**\/` may match none), `*` stays within one
 * segment, `?` is one non-slash character, and `{a,b}` is a non-nested alternation.
 */
export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;

  let out = '';
  let inBraces = false;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/';
        if (atSegmentStart && glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{' && !inBraces && glob.indexOf('}', i) !== -1) {
      inBraces = true;
      out += '(?:';
    } else if (ch === '}' && inBraces) {
      inBraces = false;
      out += ')';
    } else if (ch === ',' && inBraces) {
      out += '|';
    } else {
      out += escapeChar(ch);
    }
  }
  const re = new RegExp(`^${out}$`);
  cache.set(glob, re);
  return re;
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some(glob => globToRegExp(glob).test(path));
}

/** Why a glob cannot be used as a repo-relative pattern, or null when it is fine. */
export function globProblem(glob: string): string | null {
  if (!glob.trim()) return 'empty pattern';
  if (glob.startsWith('/')) return 'patterns are relative to the repository root and must not start with "/"';
  if (glob.split('/').includes('..')) return 'patterns must not contain ".." segments';
  let depth = 0;
  for (const ch of glob) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth > 1) return 'nested {} alternations are not supported';
    if (depth < 0) return 'unbalanced "}"';
  }
  if (depth !== 0) return 'unbalanced "{"';
  return null;
}
