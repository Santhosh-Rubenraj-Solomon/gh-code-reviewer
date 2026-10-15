import type { CredentialValidator } from './ConfigWizard';

type Fetch = typeof fetch;

async function check(fetchImpl: Fetch, url: string, init: RequestInit, what: string): Promise<string | null> {
  try {
    const res = await fetchImpl(url, init);
    if (res.ok || res.status === 429) return null; // rate limited still proves the credential is accepted
    if (res.status === 401 || res.status === 403) return `${what} was rejected (HTTP ${res.status}).`;
    return `Could not verify the ${what} (HTTP ${res.status}).`;
  } catch (error) {
    return `Could not verify the ${what}: ${(error as Error).message}`;
  }
}

/** Lists models, which needs a valid key but costs nothing. */
export function anthropicKeyValidator(fetchImpl: Fetch = fetch): CredentialValidator {
  return key =>
    check(
      fetchImpl,
      'https://api.anthropic.com/v1/models?limit=1',
      { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } },
      'Anthropic API key',
    );
}

export function googleKeyValidator(fetchImpl: Fetch = fetch): CredentialValidator {
  return key =>
    check(
      fetchImpl,
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      { headers: { 'x-goog-api-key': key } },
      'Google API key',
    );
}

export function githubTokenValidator(fetchImpl: Fetch = fetch, apiUrl = 'https://api.github.com'): CredentialValidator {
  return token =>
    check(
      fetchImpl,
      `${apiUrl.replace(/\/$/, '')}/user`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
      'GitHub token',
    );
}
