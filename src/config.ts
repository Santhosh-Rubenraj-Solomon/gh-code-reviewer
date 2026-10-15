import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseModelId } from './models';
import type { SecurityContextRule } from './security-context';
import type { PersonaName, Stage, Tier } from './types';

export interface Config {
  anthropicApiKey?: string;
  googleApiKey?: string;
  githubToken?: string;
  /** REST base URL; GitHub Actions sets GITHUB_API_URL, which also covers GitHub Enterprise. */
  githubApiUrl: string;
  tiers: Record<Tier, string>;
  stageTiers: Record<Stage, Tier>;
  persona: PersonaName;
  maxBatchTokens: number;
  maxFilesPerBatch: number;
  reviewConcurrency: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  /** Root of everything the tool keeps between runs: store, memory, history, logs, reports. */
  dataDir: string;
  storePath: string;
  impact: { enabled: boolean; maxDepth: number; maxRepoFiles: number; timeoutMs: number };
  /** Skip the evidence check of the consolidated review (summary, security concerns, tests). */
  skipValidation: boolean;
  /** Directory of extra persona JSON files. */
  personaDir: string;
  /** Add a short note to the PR when code changed but no docs did. */
  docsNotice: boolean;
  /** Command used to open local markdown reports; empty to not open them. */
  editor: string;
  /** Exact repo-root paths that are never reviewed. */
  rootConfigFiles?: string[];
  rules: { maxFileChars: number; maxTotalChars: number };
  /** Extra review emphasis by path; replaces the built-in defaults when set. */
  securityContexts?: SecurityContextRule[];
  /** Where to look for new releases, e.g. "santhosh/gh-code-reviewer". Unset disables the check. */
  updateRepo?: string;
}

export const DEFAULT_TIERS: Record<Tier, string> = {
  deep: 'anthropic:claude-opus-5-5',
  balanced: 'anthropic:claude-sonnet-5-5',
  cheap: 'anthropic:claude-haiku-5-5',
};

export const DEFAULT_STAGE_TIERS: Record<Stage, Tier> = {
  identify: 'cheap',
  triage: 'cheap',
  docs: 'cheap',
  batching: 'cheap',
  review: 'deep',
  critic: 'balanced',
  consolidate: 'deep',
  validate: 'balanced',
  persona: 'deep',
  chat: 'balanced',
  memory: 'cheap',
};

export function defaultConfig(home: string = homedir()): Config {
  return {
    githubApiUrl: 'https://api.github.com',
    tiers: { ...DEFAULT_TIERS },
    stageTiers: { ...DEFAULT_STAGE_TIERS },
    persona: 'neutral',
    maxBatchTokens: 60_000,
    maxFilesPerBatch: 15,
    reviewConcurrency: 2,
    maxRetries: 3,
    retryBaseDelayMs: 2_000,
    dataDir: join(home, '.gh-code-reviewer'),
    storePath: join(home, '.gh-code-reviewer', 'store'),
    impact: { enabled: true, maxDepth: 3, maxRepoFiles: 10_000, timeoutMs: 30_000 },
    skipValidation: false,
    personaDir: join(home, '.gh-code-reviewer', 'personas'),
    docsNotice: false,
    editor: process.env.REVIEW_EDITOR ?? '',
    rules: { maxFileChars: 10_000, maxTotalChars: 50_000 },
  };
}

export interface LoadConfigOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  rcPath?: string;
  readText?: (path: string) => string | null;
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * Builds the effective config. Precedence, lowest to highest:
 * built-in defaults, then ~/.ghreviewrc.json, then environment variables.
 * Environment wins so CI secrets always override a developer's local file.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const rcPath = options.rcPath ?? env.GHR_CONFIG ?? join(home, '.ghreviewrc.json');
  const read = options.readText ?? readIfExists;

  const base = defaultConfig(home);
  if (env.GHR_DATA_DIR) {
    // Everything the tool keeps moves with the data directory unless the rc file says otherwise.
    base.dataDir = env.GHR_DATA_DIR;
    base.storePath = join(env.GHR_DATA_DIR, 'store');
    base.personaDir = join(env.GHR_DATA_DIR, 'personas');
  }
  let rc: Partial<Config> = {};
  const rcText = read(rcPath);
  if (rcText) {
    try {
      rc = JSON.parse(rcText);
    } catch (error) {
      throw new Error(`Invalid JSON in ${rcPath}: ${(error as Error).message}`);
    }
  }

  const config: Config = {
    ...base,
    ...rc,
    tiers: { ...base.tiers, ...rc.tiers },
    stageTiers: { ...base.stageTiers, ...rc.stageTiers },
    impact: { ...base.impact, ...rc.impact },
    rules: { ...base.rules, ...rc.rules },
  };

  config.anthropicApiKey = env.ANTHROPIC_API_KEY || config.anthropicApiKey;
  config.googleApiKey = env.GOOGLE_GENERATIVE_AI_API_KEY || env.GEMINI_API_KEY || config.googleApiKey;
  config.githubToken = env.GITHUB_TOKEN || env.GH_TOKEN || config.githubToken;
  if (env.GITHUB_API_URL) config.githubApiUrl = env.GITHUB_API_URL;
  if (env.GHR_PERSONA) config.persona = env.GHR_PERSONA as PersonaName;
  if (env.GHR_MODEL_DEEP) config.tiers.deep = env.GHR_MODEL_DEEP;
  if (env.GHR_MODEL_BALANCED) config.tiers.balanced = env.GHR_MODEL_BALANCED;
  if (env.GHR_MODEL_CHEAP) config.tiers.cheap = env.GHR_MODEL_CHEAP;
  if (env.GHR_EDITOR) config.editor = env.GHR_EDITOR;
  if (env.GHR_UPDATE_REPO) config.updateRepo = env.GHR_UPDATE_REPO;

  validateConfig(config);
  return config;
}

export function validateConfig(config: Config): void {
  if (!/^[a-z0-9-]+$/.test(config.persona)) {
    throw new Error(`The persona "${config.persona}" must be lowercase letters, digits and dashes`);
  }
  for (const id of Object.values(config.tiers)) parseModelId(id);
  for (const [stage, tier] of Object.entries(config.stageTiers)) {
    if (!(tier in config.tiers)) {
      throw new Error(`Stage "${stage}" uses unknown tier "${tier}"`);
    }
  }
  for (const key of ['maxBatchTokens', 'maxFilesPerBatch', 'reviewConcurrency'] as const) {
    if (!(config[key] > 0)) throw new Error(`${key} must be a positive number`);
  }
}

export function modelForStage(config: Config, stage: Stage): string {
  return config.tiers[config.stageTiers[stage]];
}
