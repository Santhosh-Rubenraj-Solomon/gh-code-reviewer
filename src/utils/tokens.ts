import { getEncoding, type Tiktoken } from 'js-tiktoken';

let encoder: Tiktoken | null | undefined;

/**
 * Approximate token count used only for sizing batches. cl100k is not any provider's
 * real tokenizer, so callers keep a safety margin rather than packing to the limit.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  if (encoder === undefined) {
    try {
      encoder = getEncoding('cl100k_base');
    } catch {
      encoder = null;
    }
  }
  if (encoder) return encoder.encode(text).length;
  return Math.ceil(text.length / 4);
}
