/** Runs `git <args>` and resolves to trimmed stdout, or null when git fails or prints nothing. */
export type GitRunner = (args: string[]) => Promise<string | null>;

export const defaultGitRunner: GitRunner = async args => {
  try {
    const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'ignore' });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out.trim() || null : null;
  } catch {
    return null;
  }
};

/** Makes an identity safe to use as a file name: lowercase, no path separators or shell-special characters. */
export function sanitizeDeveloperId(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._]+|[._]+$/g, '');
  return cleaned.slice(0, 100) || 'anonymous';
}

/** Identifies the developer by git email, then git name, so memories follow a person across repositories. */
export async function resolveDeveloperId(git: GitRunner = defaultGitRunner): Promise<string> {
  const email = await git(['config', 'user.email']);
  if (email) return sanitizeDeveloperId(email);
  const name = await git(['config', 'user.name']);
  if (name) return sanitizeDeveloperId(name);
  return 'anonymous';
}
