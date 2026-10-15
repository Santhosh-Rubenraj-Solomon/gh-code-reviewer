import { z } from 'zod';

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);

export const FindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  severity: SeveritySchema,
  category: z.string().min(1),
  title: z.string().min(1),
  explanation: z.string().min(1),
  evidence: z.string().min(1),
  suggestion: z.string().optional(),
});

export const ReviewBatchSchema = z.object({
  findings: z.array(FindingSchema),
});

export const TriageSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      review: z.boolean(),
      reason: z.string(),
      summary: z.string(),
    }),
  ),
});

export const OverviewSchema = z.object({
  overview: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
  highlights: z.array(z.string()),
});

export const VerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      keep: z.boolean(),
      reason: z.string(),
    }),
  ),
});
