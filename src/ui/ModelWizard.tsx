import { Box, Text } from 'ink';
import { useState } from 'react';
import { missingKeys, type ProviderKeys } from '../models';
import type { Stage, Tier } from '../types';
import { readRcFile, SelectList, serialiseRc, writeRcFile, type RcObject, type RcReader, type RcWriter } from './shared';

export interface CatalogueModel {
  id: string;
  label: string;
}

export interface ModelSettings {
  tiers: Record<Tier, string>;
  stageTiers: Record<Stage, Tier>;
}

export interface ModelWizardProps {
  /** The effective current settings; the wizard edits these rather than the defaults. */
  current: ModelSettings;
  catalogue: CatalogueModel[];
  keys: ProviderKeys;
  rcPath: string;
  readConfig?: RcReader;
  writeConfig?: RcWriter;
  onDone: (saved: ModelSettings) => void;
  onCancel: () => void;
}

const TIER_ORDER: Tier[] = ['deep', 'balanced', 'cheap'];

type Screen =
  | { name: 'menu' }
  | { name: 'tiers' }
  | { name: 'tierModel'; tier: Tier }
  | { name: 'stages' }
  | { name: 'stageTier'; stage: Stage };

type MenuAction = 'tiers' | 'stages' | 'save' | 'cancel';

export function ModelWizard(props: ModelWizardProps) {
  const [tiers, setTiers] = useState<Record<Tier, string>>({ ...props.current.tiers });
  const [stageTiers, setStageTiers] = useState<Record<Stage, Tier>>({ ...props.current.stageTiers });
  const [screen, setScreen] = useState<Screen>({ name: 'menu' });
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const read = props.readConfig ?? readRcFile;
  const write = props.writeConfig ?? writeRcFile;
  const label = (id: string) => props.catalogue.find(m => m.id === id)?.label ?? id;
  const stages = Object.keys(stageTiers) as Stage[];

  const save = async () => {
    const used = [...new Set(stages.map(s => tiers[stageTiers[s]]))];
    const missing = missingKeys(used, props.keys);
    if (missing.length) {
      setMessage({ text: `Set ${missing.join(' and ')} before using these models.`, error: true });
      return;
    }
    try {
      let existing: RcObject = {};
      try {
        existing = read(props.rcPath) ?? {};
      } catch {
        existing = {};
      }
      await write(props.rcPath, serialiseRc({ ...existing, tiers, stageTiers }));
      props.onDone({ tiers, stageTiers });
    } catch (error) {
      setMessage({ text: `Could not write ${props.rcPath}: ${(error as Error).message}`, error: true });
    }
  };

  let body;
  switch (screen.name) {
    case 'menu':
      body = (
        <SelectList<MenuAction>
          items={[
            { label: 'Choose the model for each tier', value: 'tiers' },
            { label: 'Choose the tier for each pipeline stage', value: 'stages' },
            { label: 'Save and exit', value: 'save' },
            { label: 'Exit without saving', value: 'cancel' },
          ]}
          onSelect={action => {
            setMessage(null);
            if (action === 'save') void save();
            else if (action === 'cancel') props.onCancel();
            else setScreen(action === 'tiers' ? { name: 'tiers' } : { name: 'stages' });
          }}
          onBack={props.onCancel}
        />
      );
      break;
    case 'tiers':
      body = (
        <SelectList<Tier>
          items={TIER_ORDER.map(t => ({ label: t, value: t, hint: label(tiers[t]) }))}
          onSelect={tier => setScreen({ name: 'tierModel', tier })}
          onBack={() => setScreen({ name: 'menu' })}
        />
      );
      break;
    case 'tierModel': {
      const ids = props.catalogue.map(m => m.id);
      body = (
        <SelectList<string>
          key={`tier-${screen.tier}`}
          items={props.catalogue.map(m => ({ label: m.label, value: m.id, hint: m.id }))}
          initialIndex={Math.max(0, ids.indexOf(tiers[screen.tier]))}
          onSelect={id => {
            setTiers(t => ({ ...t, [screen.tier]: id }));
            setScreen({ name: 'tiers' });
          }}
          onBack={() => setScreen({ name: 'tiers' })}
        />
      );
      break;
    }
    case 'stages':
      body = (
        <SelectList<Stage>
          items={stages.map(s => ({ label: s, value: s, hint: `${stageTiers[s]} · ${label(tiers[stageTiers[s]])}` }))}
          onSelect={stage => setScreen({ name: 'stageTier', stage })}
          onBack={() => setScreen({ name: 'menu' })}
        />
      );
      break;
    case 'stageTier':
      body = (
        <SelectList<Tier>
          key={`stage-${screen.stage}`}
          items={TIER_ORDER.map(t => ({ label: t, value: t, hint: label(tiers[t]) }))}
          initialIndex={TIER_ORDER.indexOf(stageTiers[screen.stage])}
          onSelect={tier => {
            setStageTiers(s => ({ ...s, [screen.stage]: tier }));
            setScreen({ name: 'stages' });
          }}
          onBack={() => setScreen({ name: 'stages' })}
        />
      );
      break;
  }

  const title: Record<Screen['name'], string> = {
    menu: 'Model settings',
    tiers: 'Pick a tier to change its model',
    tierModel: screen.name === 'tierModel' ? `Model for the ${screen.tier} tier` : '',
    stages: 'Pick a stage to change its tier',
    stageTier: screen.name === 'stageTier' ? `Tier for the ${screen.stage} stage` : '',
  };

  return (
    <Box flexDirection="column">
      <Text bold>{title[screen.name]}</Text>
      <Box key={screen.name}>{body}</Box>
      {message ? <Text color={message.error ? 'red' : 'green'}>{message.text}</Text> : null}
      <Text dimColor>↑/↓ move · Enter choose · Esc back</Text>
    </Box>
  );
}
