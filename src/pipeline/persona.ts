import { resolvePersona, type Persona } from '../personas';
import type { Finding, PersonaName } from '../types';
import type { Overview } from './consolidator';
import type { StageDeps } from './deps';

/**
 * A short opening paragraph in a persona's voice. Kept for callers that do not build a full
 * presentation; with a presentation, use `presentation.intro` instead. Purely cosmetic, so
 * failures are ignored. Neutral and `none` make no model call.
 */
export async function personaIntro(
  deps: StageDeps,
  persona: PersonaName | Persona | null,
  overview: Overview,
  findings: Finding[],
  options: { dir?: string; rng?: () => number } = {},
): Promise<string | undefined> {
  const resolved = typeof persona === 'string' ? resolvePersona(persona, { ...options, warn: deps.log }) : persona;
  if (!resolved || resolved.key === 'neutral') return undefined;
  const prompt = [
    `Voice (${resolved.name}): ${resolved.voice}`,
    '',
    `Review summary: ${overview.overview}`,
    `Merge risk: ${overview.risk}. Verified findings: ${findings.length}.`,
    '',
    'Write the opening paragraph (max 80 words). Mention nothing that is not in the summary. State facts only.',
  ].join('\n');
  try {
    const result = await deps.llm.generateText('persona', prompt);
    deps.cost.record('persona', result.model, result.usage);
    return result.text.trim() || undefined;
  } catch (error) {
    deps.log(`persona intro skipped: ${(error as Error).message}`);
    return undefined;
  }
}
