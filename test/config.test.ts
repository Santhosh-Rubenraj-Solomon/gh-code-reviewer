import { describe, expect, test } from 'bun:test';
import { DEFAULT_TIERS, loadConfig, modelForStage, validateConfig } from '../src/config';
import { testConfig } from './helpers';

const noFile = () => null;

describe('loadConfig', () => {
  test('uses defaults when there is no rc file and no env', () => {
    const config = loadConfig({ env: {}, home: '/home/s', readText: noFile });
    expect(config.tiers).toEqual(DEFAULT_TIERS);
    expect(config.persona).toBe('neutral');
    expect(config.githubApiUrl).toBe('https://api.github.com');
    expect(config.storePath).toBe('/home/s/.gh-code-reviewer/store');
  });

  test('reads ~/.ghreviewrc.json and merges tiers instead of replacing them', () => {
    const rc = JSON.stringify({ persona: 'mentor', tiers: { cheap: 'google:gemini-3-flash-preview' } });
    let readPath = '';
    const config = loadConfig({
      env: {},
      home: '/home/s',
      readText: p => {
        readPath = p;
        return rc;
      },
    });
    expect(readPath).toBe('/home/s/.ghreviewrc.json');
    expect(config.persona).toBe('mentor');
    expect(config.tiers.cheap).toBe('google:gemini-3-flash-preview');
    expect(config.tiers.deep).toBe(DEFAULT_TIERS.deep);
  });

  test('environment variables beat the rc file', () => {
    const rc = JSON.stringify({ anthropicApiKey: 'from-file', persona: 'mentor' });
    const config = loadConfig({
      env: {
        ANTHROPIC_API_KEY: 'from-env',
        GEMINI_API_KEY: 'gem',
        GH_TOKEN: 'gh',
        GITHUB_API_URL: 'https://ghe.example.com/api/v3',
        GHR_PERSONA: 'terse',
        GHR_MODEL_DEEP: 'anthropic:claude-sonnet-5-5',
      },
      readText: () => rc,
    });
    expect(config.anthropicApiKey).toBe('from-env');
    expect(config.googleApiKey).toBe('gem');
    expect(config.githubToken).toBe('gh');
    expect(config.githubApiUrl).toBe('https://ghe.example.com/api/v3');
    expect(config.persona).toBe('terse');
    expect(config.tiers.deep).toBe('anthropic:claude-sonnet-5-5');
  });

  test('GHR_CONFIG points at a different rc file', () => {
    let readPath = '';
    loadConfig({ env: { GHR_CONFIG: '/etc/ghr.json' }, readText: p => ((readPath = p), null) });
    expect(readPath).toBe('/etc/ghr.json');
  });

  test('reports broken JSON with the file name', () => {
    expect(() => loadConfig({ env: {}, rcPath: '/x.json', readText: () => '{nope' })).toThrow(/Invalid JSON in \/x.json/);
  });
});

describe('validateConfig', () => {
  test('rejects an unknown persona', () => {
    expect(() => validateConfig(testConfig({ persona: 'pirate' as never }))).toThrow(/persona/);
  });

  test('rejects a malformed model id', () => {
    expect(() => validateConfig(testConfig({ tiers: { ...DEFAULT_TIERS, deep: 'opus' } }))).toThrow(/provider:model/);
  });

  test('rejects a stage mapped to a missing tier', () => {
    const config = testConfig();
    config.stageTiers.review = 'turbo' as never;
    expect(() => validateConfig(config)).toThrow(/unknown tier/);
  });

  test('rejects non-positive limits', () => {
    expect(() => validateConfig(testConfig({ maxBatchTokens: 0 }))).toThrow(/maxBatchTokens/);
  });
});

test('modelForStage resolves through the tier table', () => {
  const config = testConfig();
  expect(modelForStage(config, 'review')).toBe(DEFAULT_TIERS.deep);
  expect(modelForStage(config, 'critic')).toBe(DEFAULT_TIERS.balanced);
  expect(modelForStage(config, 'triage')).toBe(DEFAULT_TIERS.cheap);
});
