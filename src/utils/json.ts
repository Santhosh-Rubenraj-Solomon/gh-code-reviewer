/**
 * Pulls a JSON value out of model text that may wrap it in prose or a code fence.
 * Tries, in order: the whole text, a ```json fence (or a bare fence), then the first
 * balanced object/array found by scanning while respecting strings and escapes.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('extractJson: the response was empty');

  const direct = tryParse(trimmed);
  if (direct.ok) return direct.value;

  for (const match of trimmed.matchAll(/```(?:json|JSON)?[^\S\n]*\n([\s\S]*?)```/g)) {
    const fenced = tryParse(match[1]!.trim());
    if (fenced.ok) return fenced.value;
  }

  for (let start = 0; start < trimmed.length; start++) {
    const ch = trimmed[start];
    if (ch !== '{' && ch !== '[') continue;
    const end = balancedEnd(trimmed, start);
    if (end === -1) continue;
    const candidate = tryParse(trimmed.slice(start, end + 1));
    if (candidate.ok) return candidate.value;
  }

  throw new Error(`extractJson: no JSON value found in response (${trimmed.length} chars)`);
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Index of the bracket that closes the one at `start`, or -1 if it never closes. */
function balancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}
