import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import { BUILT_IN_PERSONAS, type Tier } from '../types';
import { readRcFile, SelectList, serialiseRc, writeRcFile, type RcObject, type RcReader, type RcWriter } from './shared';

export type ProviderChoice = 'anthropic' | 'google' | 'both';

/** Resolves to null when the credential works, or to a message explaining why it does not. */
export type CredentialValidator = (value: string) => Promise<string | null>;

export const GOOGLE_TIERS: Record<Tier, string> = {
  deep: 'google:gemini-3.1-pro-preview',
  balanced: 'google:gemini-3-flash-preview',
  cheap: 'google:gemini-3.1-flash-lite-preview',
};

export interface ConfigWizardProps {
  rcPath: string;
  readConfig?: RcReader;
  writeConfig?: RcWriter;
  validateAnthropicKey?: CredentialValidator;
  validateGoogleKey?: CredentialValidator;
  validateGithubToken?: CredentialValidator;
  personas?: readonly string[];
  onDone: (config: RcObject) => void;
  onCancel: () => void;
}

type Step = 'provider' | 'anthropicKey' | 'googleKey' | 'githubToken' | 'persona' | 'editor' | 'saving' | 'done';
type TextStep = 'anthropicKey' | 'googleKey' | 'githubToken' | 'editor';

const TEXT_FIELDS: Record<TextStep, { key: string; prompt: string; secret: boolean; optional: boolean }> = {
  anthropicKey: { key: 'anthropicApiKey', prompt: 'Anthropic API key', secret: true, optional: false },
  googleKey: { key: 'googleApiKey', prompt: 'Google AI (Gemini) API key', secret: true, optional: false },
  githubToken: {
    key: 'githubToken',
    prompt: 'GitHub token (optional, needed to review and comment on pull requests)',
    secret: true,
    optional: true,
  },
  editor: { key: 'editor', prompt: 'Editor command used to open local reviews', secret: false, optional: true },
};

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** First-run setup. Writes only the fields it asks about, merged into whatever the rc file already holds. */
export function ConfigWizard(props: ConfigWizardProps) {
  const read = props.readConfig ?? readRcFile;
  const write = props.writeConfig ?? writeRcFile;
  const personas = props.personas ?? BUILT_IN_PERSONAS;
  const [existing] = useState<RcObject>(() => {
    try {
      return read(props.rcPath) ?? {};
    } catch {
      return {};
    }
  });
  const [step, setStep] = useState<Step>('provider');
  const [provider, setProvider] = useState<ProviderChoice>('anthropic');
  const [values, setValues] = useState<Record<string, string>>({});
  const [input, setInput] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  useInput((_input, key) => {
    if (key.escape && !checking && step !== 'saving' && step !== 'done') props.onCancel();
  });

  const textSteps = (p: ProviderChoice): TextStep[] => [
    ...(p !== 'google' ? (['anthropicKey'] as const) : []),
    ...(p !== 'anthropic' ? (['googleKey'] as const) : []),
    'githubToken',
  ];

  const save = async (finalValues: Record<string, string>) => {
    setStep('saving');
    const merged: RcObject = { ...existing };
    for (const [key, value] of Object.entries(finalValues)) if (value) merged[key] = value;
    if (provider === 'google' && !existing.tiers) merged.tiers = { ...GOOGLE_TIERS };
    try {
      await write(props.rcPath, serialiseRc(merged));
      setStep('done');
      props.onDone(merged);
    } catch (e) {
      setError(`Could not write ${props.rcPath}: ${(e as Error).message}`);
      setStep('editor');
    }
  };

  const advanceFrom = (current: Step, nextValues: Record<string, string>) => {
    const order: Step[] = ['provider', ...textSteps(provider), 'persona', 'editor'];
    const next = order[order.indexOf(current) + 1];
    if (!next) return void save(nextValues);
    setInput(next === 'editor' ? (str(existing.editor) ?? 'code') : '');
    setStep(next);
  };

  const validatorFor = (s: TextStep): CredentialValidator | undefined =>
    s === 'anthropicKey' ? props.validateAnthropicKey : s === 'googleKey' ? props.validateGoogleKey
      : s === 'githubToken' ? props.validateGithubToken : undefined;

  const submitText = async (raw: string) => {
    if (checking) return;
    const s = step as TextStep;
    const field = TEXT_FIELDS[s];
    const value = raw.trim();
    const kept = str(existing[field.key]);
    if (!value) {
      if (!kept && !field.optional) return setError(`${field.prompt} is required.`);
      setError('');
      return advanceFrom(s, values);
    }
    const validate = validatorFor(s);
    if (validate) {
      setChecking(true);
      let problem: string | null;
      try {
        problem = await validate(value);
      } catch (e) {
        problem = (e as Error).message;
      }
      setChecking(false);
      if (problem) return setError(problem);
    }
    setError('');
    const nextValues = { ...values, [field.key]: value };
    setValues(nextValues);
    advanceFrom(s, nextValues);
  };

  const header = <Text bold>gh-code-reviewer setup</Text>;

  if (step === 'provider') {
    return (
      <Box flexDirection="column">
        {header}
        <Text>Which model provider will you use?</Text>
        <SelectList<ProviderChoice>
          items={[
            { label: 'Anthropic (Claude)', value: 'anthropic' },
            { label: 'Google (Gemini)', value: 'google' },
            { label: 'Both', value: 'both' },
          ]}
          onSelect={p => {
            setProvider(p);
            setStep(p === 'google' ? 'googleKey' : 'anthropicKey');
            setInput('');
          }}
        />
        <Text dimColor>Enter choose · Esc cancel</Text>
      </Box>
    );
  }

  if (step === 'persona') {
    const current = str(values.persona) ?? str(existing.persona) ?? 'neutral';
    return (
      <Box flexDirection="column">
        {header}
        <Text>Default review persona</Text>
        <SelectList<string>
          items={personas.map(p => ({ label: p, value: p }))}
          initialIndex={Math.max(0, personas.indexOf(current))}
          onSelect={p => {
            const nextValues = { ...values, persona: p };
            setValues(nextValues);
            advanceFrom('persona', nextValues);
          }}
        />
      </Box>
    );
  }

  if (step === 'saving' || step === 'done') {
    return (
      <Box flexDirection="column">
        {header}
        {step === 'saving' ? <Text>Saving…</Text> : <Text color="green">Saved {props.rcPath}</Text>}
      </Box>
    );
  }

  const field = TEXT_FIELDS[step];
  const kept = str(existing[field.key]);
  const placeholder = kept && field.secret ? 'Enter to keep the current value' : field.optional ? 'Enter to skip' : '';
  return (
    <Box flexDirection="column">
      {header}
      <Text>{field.prompt}</Text>
      <Box>
        <Text color="green">› </Text>
        {checking ? (
          <Text color="cyan">
            <Spinner type="dots" /> checking…
          </Text>
        ) : (
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={value => void submitText(value)}
            mask={field.secret ? '*' : undefined}
            placeholder={placeholder}
          />
        )}
      </Box>
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>Enter continue · Esc cancel</Text>
    </Box>
  );
}
