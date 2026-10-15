import { PERSONA_VOICES } from '../prompts';
import type { Finding, PersonaName } from '../types';
import type { StageDeps } from './deps';
import type { Overview } from './consolidator';

/** An optional opening paragraph in a chosen voice. Purely cosmetic, so failures are ignored. */
export async function personaIntro(
  deps: StageDeps,
  persona: PersonaName,
  overview: Overview,
  findings: Finding[],
): Promise<string | undefined> {
  if (persona === 'neutral') return undefined;
  const prompt = [
    `Voice: ${PERSONA_VOICES[persona]}`,
    '',
    `Review summary: ${overview.overview}`,
    `Merge risk: ${overview.risk}. Verified findings: ${findings.length}.`,
    '',
    'Write the opening paragraph (max 80 words). Do not mention any issue that is not in the summary.',
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
