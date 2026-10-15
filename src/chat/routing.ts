import type { ChatTier } from '../issues';

export interface RouteHint {
  tier: ChatTier;
  reason: string;
}

const TAG_OPEN = '<route';
const TAG_PATTERN = /<route\b[^>]*?\/?>/gi;
const TIER_ATTR = /\btier\s*=\s*"(basic|standard|advanced)"/i;
const REASON_ATTR = /\breason\s*=\s*"([^"]*)"/i;
/** A tag longer than this is not one of ours; flush it as text instead of buffering forever. */
const MAX_TAG_CHARS = 400;

export const ROUTING_INSTRUCTION = [
  'After your answer, on its own final line, say how hard the developer\'s NEXT question is likely to be, using exactly',
  'this tag: <route tier="basic|standard|advanced" reason="a few words"/>',
  'Use basic for quick factual follow-ups, standard for normal discussion, advanced for deep design, security or',
  'multi-file reasoning. The tag is hidden from the developer, so never mention it.',
].join('\n');

/** Reads the last valid routing tag in a reply, if any. */
export function parseRoute(text: string): RouteHint | undefined {
  let hint: RouteHint | undefined;
  for (const match of text.matchAll(TAG_PATTERN)) {
    const tier = TIER_ATTR.exec(match[0])?.[1]?.toLowerCase() as ChatTier | undefined;
    if (tier) hint = { tier, reason: REASON_ATTR.exec(match[0])?.[1] ?? '' };
  }
  return hint;
}

export function stripRoutes(text: string): string {
  return text.replace(TAG_PATTERN, '').replace(/[ \t]+\n/g, '\n').trimEnd();
}

/** Length of the longest suffix of `text` that could be the start of a routing tag. */
function partialTagSuffix(text: string): number {
  for (let len = Math.min(TAG_OPEN.length, text.length); len > 0; len--) {
    if (TAG_OPEN.startsWith(text.slice(-len).toLowerCase())) return len;
  }
  return 0;
}

/**
 * Removes routing tags from a stream of chunks. A tag can arrive split across chunks, so text that might be the
 * beginning of a tag is held back until it is clearly either a tag (dropped) or ordinary text (emitted).
 */
export class RouteTagFilter {
  private buffer = '';

  push(chunk: string): string {
    this.buffer += chunk;
    let out = '';
    for (;;) {
      const start = this.buffer.toLowerCase().indexOf(TAG_OPEN);
      if (start < 0) {
        const hold = partialTagSuffix(this.buffer);
        out += this.buffer.slice(0, this.buffer.length - hold);
        this.buffer = this.buffer.slice(this.buffer.length - hold);
        return out;
      }
      out += this.buffer.slice(0, start);
      this.buffer = this.buffer.slice(start);
      // "<routes" or "<router" is ordinary text; only "<route" followed by whitespace, "/" or ">" opens a tag.
      const next = this.buffer[TAG_OPEN.length];
      if (next !== undefined && !/[\s/>]/.test(next)) {
        out += this.buffer.slice(0, TAG_OPEN.length);
        this.buffer = this.buffer.slice(TAG_OPEN.length);
        continue;
      }
      const end = this.buffer.indexOf('>');
      if (end < 0) {
        if (this.buffer.length > MAX_TAG_CHARS) {
          out += this.buffer;
          this.buffer = '';
        }
        return out;
      }
      this.buffer = this.buffer.slice(end + 1);
    }
  }

  /** Call once the stream ends. An unterminated tag at the very end is dropped; anything else is emitted. */
  flush(): string {
    const rest = this.buffer;
    this.buffer = '';
    return /^<route(\s|$)/i.test(rest) ? '' : rest;
  }
}
