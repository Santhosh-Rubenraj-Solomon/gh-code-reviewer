import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BUILT_IN_PERSONAS } from '../types';
import { BUILT_IN_PERSONA_DEFS, NEUTRAL_RENDER } from './built-in';
import type { Persona, PersonaRenderStyle } from './types';

export type { AspectStatus, Persona, PersonaRenderStyle } from './types';
export { BUILT_IN_PERSONA_DEFS, NEUTRAL_RENDER } from './built-in';

export const PERSONA_KEY_PATTERN = /^[a-z0-9-]+$/;
/** Special keys: `none` turns the presentation off, `random` picks a built-in persona per run. */
export const SPECIAL_PERSONA_KEYS = ['none', 'random'] as const;

const text = z.string().trim().min(1);
const SeverityLabels = z.object({ critical: text, high: text, medium: text, low: text }).partial();
const ExternalPersonaSchema = z.object({
  key: z.string().regex(PERSONA_KEY_PATTERN, 'key must be lowercase letters, digits or dashes'),
  name: text,
  description: text,
  voice: text,
  chatInstruction: text,
  cleanRemarks: z.array(text).min(1),
  render: z
    .object({
      headers: z
        .object({ summary: text, issues: text, files: text, cleanFiles: text, verdict: text, testCoverage: text })
        .partial(),
      severityLabels: SeverityLabels,
      issuePrefix: z.string(),
      statusLabels: z.object({ clean: text, warning: text, issue: text, critical: text }).partial(),
    })
    .partial()
    .optional(),
});

function mergeRender(partial: z.infer<typeof ExternalPersonaSchema>['render']): PersonaRenderStyle {
  return {
    headers: { ...NEUTRAL_RENDER.headers, ...partial?.headers },
    severityLabels: { ...NEUTRAL_RENDER.severityLabels, ...partial?.severityLabels },
    issuePrefix: partial?.issuePrefix ?? NEUTRAL_RENDER.issuePrefix,
    statusLabels: { ...NEUTRAL_RENDER.statusLabels, ...partial?.statusLabels },
  };
}

/** Parses one external persona file; returns an error message instead of throwing. */
export function parseExternalPersona(json: string): Persona | string {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    return `invalid JSON: ${(error as Error).message}`;
  }
  const parsed = ExternalPersonaSchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  }
  const { render, ...rest } = parsed.data;
  return { ...rest, render: mergeRender(render), builtIn: false };
}

const cache = new Map<string, Map<string, Persona>>();

export function clearPersonaCache(): void {
  cache.clear();
}

/** Loads `*.json` personas from `dir` once per process. Invalid files are reported and skipped. */
export function loadExternalPersonas(dir: string, warn: (message: string) => void = () => {}): Map<string, Persona> {
  const hit = cache.get(dir);
  if (hit) return hit;
  const found = new Map<string, Persona>();
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
      let result: Persona | string;
      try {
        result = parseExternalPersona(readFileSync(join(dir, name), 'utf8'));
      } catch (error) {
        result = (error as Error).message;
      }
      if (typeof result === 'string') warn(`ignoring persona file ${name}: ${result}`);
      else found.set(result.key, result);
    }
  }
  cache.set(dir, found);
  return found;
}

function allPersonas(dir?: string, warn?: (message: string) => void): Map<string, Persona> {
  const merged = new Map(Object.entries(BUILT_IN_PERSONA_DEFS));
  if (dir) for (const [key, persona] of loadExternalPersonas(dir, warn)) merged.set(key, persona);
  return merged;
}

/** Built-ins first (in their canonical order), then external personas by key. External files may override. */
export function listPersonas(dir?: string): Persona[] {
  const all = allPersonas(dir);
  const builtIns = BUILT_IN_PERSONAS.map(k => all.get(k)!);
  const extra = [...all.values()].filter(p => !(BUILT_IN_PERSONAS as readonly string[]).includes(p.key));
  return [...builtIns, ...extra.sort((a, b) => a.key.localeCompare(b.key))];
}

/** Throws a helpful error for a key that is malformed or names no known persona. */
export function validatePersonaKey(key: string, dir?: string): string {
  const normalized = key.trim().toLowerCase();
  if (!PERSONA_KEY_PATTERN.test(normalized)) {
    throw new Error(`Invalid persona "${key}": use lowercase letters, digits and dashes.`);
  }
  if ((SPECIAL_PERSONA_KEYS as readonly string[]).includes(normalized)) return normalized;
  const all = allPersonas(dir);
  if (!all.has(normalized)) {
    throw new Error(`Unknown persona "${key}". Available: ${[...all.keys(), ...SPECIAL_PERSONA_KEYS].join(', ')}.`);
  }
  return normalized;
}

export interface ResolveOptions {
  dir?: string;
  /** Returns a number in [0, 1); injectable so tests are deterministic. */
  rng?: () => number;
  warn?: (message: string) => void;
}

/** `none` gives null (no presentation). Unknown keys warn and fall back to neutral rather than failing a run. */
export function resolvePersona(key: string, options: ResolveOptions = {}): Persona | null {
  const warn = options.warn ?? (() => {});
  const normalized = key.trim().toLowerCase();
  if (normalized === 'none') return null;
  const all = allPersonas(options.dir, warn);
  if (normalized === 'random') {
    const rng = options.rng ?? Math.random;
    const index = Math.min(BUILT_IN_PERSONAS.length - 1, Math.floor(rng() * BUILT_IN_PERSONAS.length));
    return all.get(BUILT_IN_PERSONAS[index]!)!;
  }
  const persona = all.get(normalized);
  if (persona) return persona;
  warn(`unknown persona "${key}", using neutral`);
  return all.get('neutral')!;
}

/** Looks a persona up by key without warnings; used by renderers that only have `presentation.persona`. */
export function personaByKey(key: string, dir?: string): Persona {
  return allPersonas(dir).get(key) ?? BUILT_IN_PERSONA_DEFS.neutral!;
}
