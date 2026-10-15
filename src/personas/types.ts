import type { Presentation, Severity } from '../types';

export type AspectStatus = Presentation['aspects'][number]['status'];

/** Everything the renderers need to dress a presentation in a persona's labels. */
export interface PersonaRenderStyle {
  headers: {
    summary: string;
    issues: string;
    files: string;
    cleanFiles: string;
    verdict: string;
    testCoverage: string;
  };
  severityLabels: Record<Severity, string>;
  /** Printed before each issue heading; may be empty. */
  issuePrefix: string;
  statusLabels: Record<AspectStatus, string>;
}

export interface Persona {
  key: string;
  name: string;
  description: string;
  /** How the presentation prompt should sound. */
  voice: string;
  /** System-style instruction for follow-up chat about a finding. */
  chatInstruction: string;
  /** Short remarks shown next to files with no findings. Never empty. */
  cleanRemarks: string[];
  render: PersonaRenderStyle;
  builtIn: boolean;
}
