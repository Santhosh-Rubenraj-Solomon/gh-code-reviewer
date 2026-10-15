import { matchesAny } from './utils/glob';

/** How the reviewer should weigh security for files whose path matches `patterns`. */
export interface SecurityContextRule {
  name: string;
  patterns: string[];
  instructions: string;
}

export interface SecurityContext {
  name: string;
  instructions: string;
}

/**
 * Generic defaults. They only add emphasis; none of them tells the reviewer to ignore a
 * class of vulnerability. Teams with a different threat model pass their own rules.
 */
export const DEFAULT_SECURITY_CONTEXT_RULES: SecurityContextRule[] = [
  {
    name: 'entry-point',
    patterns: [
      '**/*controller*',
      '**/*Controller*',
      '**/controllers/**',
      '**/routes/**',
      '**/*route*',
      '**/*router*',
      '**/handlers/**',
      '**/*handler*',
      '**/*Handler*',
      '**/api/**',
      '**/endpoints/**',
      '**/resolvers/**',
      '**/webhooks/**',
    ],
    instructions:
      'This file receives input from outside the process (requests, webhooks, messages). Treat every parameter, ' +
      'header, body field and query value as untrusted: check that it is validated, bounded and encoded before it ' +
      'reaches queries, file paths, shell commands, templates or redirects, and that errors do not leak internals.',
  },
  {
    name: 'access-control',
    patterns: [
      '**/auth/**',
      '**/*auth*',
      '**/*Auth*',
      '**/middleware/**',
      '**/*middleware*',
      '**/*permission*',
      '**/*Permission*',
      '**/*policy*',
      '**/*polic*',
      '**/*session*',
      '**/guards/**',
      '**/*guard*',
    ],
    instructions:
      'This file decides who may do what. Check that authentication and authorization cannot be bypassed: ' +
      'missing checks on some paths, wrong defaults (allow instead of deny), token or session handling mistakes, ' +
      'timing-unsafe comparisons, and privilege escalation through user-controlled identifiers.',
  },
];

const NORMAL_REVIEW: SecurityContext = {
  name: 'general',
  instructions:
    'Review security as usual: report injection, unsafe deserialization, secrets in code and similar problems ' +
    'when the changed code shows them.',
};

export function securityContextFor(
  path: string,
  rules: SecurityContextRule[] = DEFAULT_SECURITY_CONTEXT_RULES,
): SecurityContext {
  const rule = rules.find(r => matchesAny(path, r.patterns));
  return rule ? { name: rule.name, instructions: rule.instructions } : NORMAL_REVIEW;
}
