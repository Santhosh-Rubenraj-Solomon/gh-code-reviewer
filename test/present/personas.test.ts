import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILT_IN_PERSONA_DEFS,
  clearPersonaCache,
  listPersonas,
  parseExternalPersona,
  resolvePersona,
  validatePersonaKey,
} from '../../src/personas';
import { BUILT_IN_PERSONAS } from '../../src/types';

afterEach(clearPersonaCache);

const external = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    key: 'pirate-free',
    name: 'Gardener',
    description: 'Tends the code.',
    voice: 'Gentle gardener.',
    chatInstruction: 'Speak like a gardener.',
    cleanRemarks: ['Blooming.'],
    render: { headers: { summary: 'The garden' }, issuePrefix: '🌿' },
    ...overrides,
  });

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghr-personas-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe('built-in personas', () => {
  test('every built-in key has a complete definition', () => {
    for (const key of BUILT_IN_PERSONAS) {
      const p = BUILT_IN_PERSONA_DEFS[key]!;
      expect(p.key).toBe(key);
      expect(p.voice.length).toBeGreaterThan(10);
      expect(p.cleanRemarks.length).toBeGreaterThan(0);
      expect(Object.keys(p.render.severityLabels)).toEqual(['critical', 'high', 'medium', 'low']);
    }
    expect(listPersonas().map(p => p.key)).toEqual([...BUILT_IN_PERSONAS]);
  });

  test('resolves built-ins, none, random and unknown keys', () => {
    expect(resolvePersona('captain')!.name).toBe('Captain');
    expect(resolvePersona(' Monk ')!.key).toBe('monk');
    expect(resolvePersona('none')).toBeNull();
    expect(resolvePersona('random', { rng: () => 0 })!.key).toBe('neutral');
    expect(resolvePersona('random', { rng: () => 0.999 })!.key).toBe('monk');
    const warnings: string[] = [];
    expect(resolvePersona('shakespeare', { warn: w => warnings.push(w) })!.key).toBe('neutral');
    expect(warnings[0]).toContain('unknown persona "shakespeare"');
  });

  test('validatePersonaKey accepts known and special keys and throws otherwise', () => {
    expect(validatePersonaKey('Detective')).toBe('detective');
    expect(validatePersonaKey('random')).toBe('random');
    expect(validatePersonaKey('none')).toBe('none');
    expect(() => validatePersonaKey('Bad Key!')).toThrow('Invalid persona');
    expect(() => validatePersonaKey('ghost')).toThrow('Unknown persona "ghost"');
  });
});

describe('external personas', () => {
  test('loads valid files, fills render gaps from neutral, and lists them after the built-ins', () => {
    const dir = dirWith({ 'gardener.json': external(), 'notes.txt': 'ignored' });
    const p = resolvePersona('pirate-free', { dir })!;
    expect(p.builtIn).toBe(false);
    expect(p.render.headers.summary).toBe('The garden');
    expect(p.render.headers.verdict).toBe('Verdict');
    expect(p.render.issuePrefix).toBe('🌿');
    expect(listPersonas(dir).map(x => x.key).at(-1)).toBe('pirate-free');
    expect(validatePersonaKey('pirate-free', dir)).toBe('pirate-free');
  });

  test('an external file may override a built-in', () => {
    const dir = dirWith({ 'mentor.json': external({ key: 'mentor', name: 'House mentor' }) });
    expect(resolvePersona('mentor', { dir })!.name).toBe('House mentor');
    expect(listPersonas(dir)).toHaveLength(BUILT_IN_PERSONAS.length);
  });

  test('invalid files are reported and skipped', () => {
    const dir = dirWith({
      'broken.json': '{ nope',
      'badkey.json': external({ key: 'Bad Key' }),
      'noremarks.json': external({ key: 'quiet', cleanRemarks: [] }),
    });
    const warnings: string[] = [];
    expect(resolvePersona('quiet', { dir, warn: w => warnings.push(w) })!.key).toBe('neutral');
    expect(warnings.filter(w => w.startsWith('ignoring persona file'))).toHaveLength(3);
    expect(warnings.find(w => w.includes('broken.json'))).toContain('invalid JSON');
    expect(warnings.find(w => w.includes('noremarks.json'))).toContain('cleanRemarks');
  });

  test('loaded personas are cached per directory', () => {
    const dir = dirWith({ 'g.json': external() });
    expect(resolvePersona('pirate-free', { dir })!.name).toBe('Gardener');
    writeFileSync(join(dir, 'g.json'), external({ name: 'Changed' }));
    expect(resolvePersona('pirate-free', { dir })!.name).toBe('Gardener');
    clearPersonaCache();
    expect(resolvePersona('pirate-free', { dir })!.name).toBe('Changed');
  });

  test('parseExternalPersona returns an error string for missing fields', () => {
    expect(parseExternalPersona('{"key":"x"}')).toContain('name');
  });

  test('a missing directory just means no external personas', () => {
    expect(listPersonas('/definitely/not/here')).toHaveLength(BUILT_IN_PERSONAS.length);
  });
});
