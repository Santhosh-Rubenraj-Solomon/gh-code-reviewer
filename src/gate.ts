import { SEVERITY_ORDER, type Finding, type Severity } from './types';

export function parseSeverity(value: string): Severity {
  const severity = value.toLowerCase() as Severity;
  if (!SEVERITY_ORDER.includes(severity)) {
    throw new Error(`--fail-on must be one of ${SEVERITY_ORDER.join(', ')}`);
  }
  return severity;
}

/** True when any finding is at or above the threshold, so CI can block the merge. */
export function breachesThreshold(findings: Finding[], threshold: Severity): boolean {
  const limit = SEVERITY_ORDER.indexOf(threshold);
  return findings.some(f => SEVERITY_ORDER.indexOf(f.severity) <= limit);
}
