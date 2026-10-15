const SECRET_KEY = /key|token|secret|password/i;

/** Long secrets keep their first and last four characters so the user can tell which one is set. */
export function maskSecret(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function maskDeep(value: unknown, key = ''): unknown {
  if (typeof value === 'string') return SECRET_KEY.test(key) ? maskSecret(value) : value;
  if (Array.isArray(value)) return value.map(v => maskDeep(v, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, k)]));
  }
  return value;
}

/** `ghr config`: prints the rc file with secrets masked. */
export function configShowCommand(deps: { rcPath: string; readText: (path: string) => string | null }): string {
  const text = deps.readText(deps.rcPath);
  if (text === null) return `No config file at ${deps.rcPath}. Settings come from defaults and environment variables.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return `${deps.rcPath} is not valid JSON: ${(error as Error).message}`;
  }
  return [`Config file: ${deps.rcPath}`, JSON.stringify(maskDeep(parsed), null, 2)].join('\n');
}
