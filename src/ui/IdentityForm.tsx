import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import { SelectList } from './shared';

export interface ChangeDescription {
  title: string;
  problem: string;
  solution: string;
}

export interface IdentityFormProps {
  initial: ChangeDescription;
  /** Offers "let a model write these" when provided. */
  onGenerate?: () => Promise<ChangeDescription>;
  onDone: (identity: ChangeDescription) => void;
  onCancel: () => void;
}

type Field = keyof ChangeDescription;
type Action = 'proceed' | 'generate' | 'cancel' | Field;

const LABELS: Record<Field, string> = { title: 'Title', problem: 'Problem', solution: 'Solution' };

/**
 * Names a local change before it is reviewed: what it is, what problem it solves and how.
 * The reviewer uses these to judge whether the code does what it claims.
 */
export function IdentityForm({ initial, onGenerate, onDone, onCancel }: IdentityFormProps) {
  const [values, setValues] = useState(initial);
  // With nothing to start from, go straight to typing the (required) title.
  const [editing, setEditing] = useState<Field | null>(initial.title.trim() ? null : 'title');
  const [draft, setDraft] = useState(initial.title);
  const [status, setStatus] = useState('');
  // Remounting the menu puts the cursor back on "Review it" once new values arrive.
  const [menuKey, setMenuKey] = useState(0);

  const startEdit = (field: Field) => {
    setDraft(values[field]);
    setEditing(field);
  };

  const choose = (action: Action) => {
    if (action === 'cancel') onCancel();
    else if (action === 'proceed') {
      if (values.title.trim()) onDone(values);
      else setStatus('A title is required.');
    } else if (action === 'generate' && onGenerate) {
      setStatus('Asking the model to describe the change…');
      onGenerate().then(
        generated => {
          setValues(generated);
          setStatus('');
          setMenuKey(k => k + 1);
        },
        error => setStatus(`Could not describe the change: ${(error as Error).message}`),
      );
    } else if (action !== 'generate') startEdit(action);
  };

  return (
    <Box flexDirection="column">
      <Text bold>Describe this change</Text>
      {(Object.keys(LABELS) as Field[]).map(field => (
        <Text key={field}>
          <Text dimColor>{LABELS[field].padEnd(9)}</Text>
          {editing === field ? (
            <TextInput
              value={draft}
              onChange={setDraft}
              onSubmit={value => {
                setValues(v => ({ ...v, [field]: value.trim() }));
                setEditing(null);
                setStatus('');
              }}
            />
          ) : (
            <Text>{values[field] || <Text dimColor>(empty)</Text>}</Text>
          )}
        </Text>
      ))}
      {status ? <Text color="yellow">{status}</Text> : null}
      {editing ? (
        <Text dimColor>Enter to save the field.</Text>
      ) : (
        <Box marginTop={1}>
          <SelectList<Action>
            key={menuKey}
            items={[
              { label: 'Review it', value: 'proceed' },
              { label: 'Edit title', value: 'title' },
              { label: 'Edit problem', value: 'problem' },
              { label: 'Edit solution', value: 'solution' },
              ...(onGenerate ? [{ label: 'Let a model describe it', value: 'generate' as const }] : []),
              { label: 'Cancel', value: 'cancel' },
            ]}
            onSelect={choose}
            onBack={onCancel}
          />
        </Box>
      )}
    </Box>
  );
}
