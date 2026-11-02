import { z } from 'zod';

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

export const VerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      keep: z.boolean(),
      reason: z.string(),
    }),
  ),
});
