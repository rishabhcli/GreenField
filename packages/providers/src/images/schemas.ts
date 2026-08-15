/**
 * Zod schemas for the OpenAI Images API objects this adapter reads and
 * writes. Narrow by design, same philosophy as `../stripe/schemas.ts`: only
 * the fields actually consumed.
 */

import { z } from 'zod';

export const OpenAiModel = z.object({
  id: z.string(),
  object: z.string().optional(),
  owned_by: z.string().optional(),
});
export type OpenAiModel = z.infer<typeof OpenAiModel>;

export const OpenAiModelListResponse = z.object({
  object: z.string().optional(),
  data: z.array(OpenAiModel).default([]),
});
export type OpenAiModelListResponse = z.infer<typeof OpenAiModelListResponse>;

export const OpenAiImageDatum = z.object({
  url: z.string().optional(),
  b64_json: z.string().optional(),
  revised_prompt: z.string().optional(),
});
export type OpenAiImageDatum = z.infer<typeof OpenAiImageDatum>;

export const OpenAiImageGenerationResponse = z.object({
  created: z.number().optional(),
  data: z.array(OpenAiImageDatum).default([]),
});
export type OpenAiImageGenerationResponse = z.infer<typeof OpenAiImageGenerationResponse>;

export const OpenAiErrorEnvelope = z.object({
  error: z
    .object({
      message: z.string(),
      type: z.string().optional(),
      param: z.string().nullable().optional(),
      code: z.string().nullable().optional(),
    })
    .passthrough(),
});
export type OpenAiErrorEnvelope = z.infer<typeof OpenAiErrorEnvelope>;

export function extractOpenAiError(body: unknown): OpenAiErrorEnvelope['error'] | undefined {
  const parsed = OpenAiErrorEnvelope.safeParse(body);
  return parsed.success ? parsed.data.error : undefined;
}
