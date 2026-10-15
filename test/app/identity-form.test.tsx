import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import { IdentityForm, type ChangeDescription } from '../../src/ui/IdentityForm';

const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));
const DOWN = '\u001B[B';
const ENTER = '\r';

async function press(stdin: { write(s: string): void }, ...keys: string[]) {
  for (const k of keys) {
    stdin.write(k);
    await tick();
  }
}

afterEach(() => cleanup());

describe('IdentityForm', () => {
  test('starts by asking for a title when there is none, then proceeds', async () => {
    let done = null as ChangeDescription | null;
    const { stdin, lastFrame } = render(
      <IdentityForm initial={{ title: '', problem: '', solution: '' }} onDone={v => (done = v)} onCancel={() => {}} />,
    );
    await tick();
    expect(lastFrame()).toContain('Enter to save the field.');
    await press(stdin, 'Fix login', ENTER);
    expect(lastFrame()).toContain('Fix login');
    await press(stdin, ENTER);
    expect(done).toEqual({ title: 'Fix login', problem: '', solution: '' });
  });

  test('refuses to proceed without a title', async () => {
    let done = false;
    const { stdin, lastFrame } = render(
      <IdentityForm initial={{ title: ' ', problem: '', solution: '' }} onDone={() => (done = true)} onCancel={() => {}} />,
    );
    await tick();
    await press(stdin, ENTER); // saves the (blank) title field
    await press(stdin, ENTER); // "Review it"
    expect(done).toBe(false);
    expect(lastFrame()).toContain('A title is required.');
  });

  test('edits a field and can ask the model to describe the change', async () => {
    let done = null as ChangeDescription | null;
    const generated = { title: 'Model title', problem: 'Model problem', solution: 'Model solution' };
    const { stdin, lastFrame } = render(
      <IdentityForm
        initial={{ title: 'Draft', problem: '', solution: '' }}
        onGenerate={async () => generated}
        onDone={v => (done = v)}
        onCancel={() => {}}
      />,
    );
    await tick();
    await press(stdin, DOWN, DOWN, ENTER, 'Users could not log in', ENTER); // Edit problem
    expect(lastFrame()).toContain('Users could not log in');
    await press(stdin, DOWN, DOWN, DOWN, DOWN, ENTER); // Let a model describe it
    await tick(50);
    expect(lastFrame()).toContain('Model title');
    await press(stdin, ENTER); // cursor is back on "Review it"
    expect(done).toEqual(generated);
  });

  test('Esc cancels', async () => {
    let cancelled = false;
    const { stdin } = render(
      <IdentityForm initial={{ title: 'x', problem: '', solution: '' }} onDone={() => {}} onCancel={() => (cancelled = true)} />,
    );
    await tick();
    await press(stdin, '\u001B');
    await tick(50);
    expect(cancelled).toBe(true);
  });
});
