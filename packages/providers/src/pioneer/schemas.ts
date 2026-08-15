/**
 * Pioneer response shapes.
 *
 * Catalog and inference envelopes are documented at the field-family level
 * (model id, supports_inference, chat `choices[].message.content`). Extra
 * fields are accepted so a catalog expansion does not fail the probe.
 */

import { z } from 'zod';

export const PioneerBaseModel = z
  .object({
    id: z.string(),
    label: z.string().optional(),
    supports_inference: z.boolean().optional(),
    supports_training: z.boolean().optional(),
    task_type: z.string().optional(),
  })
  .passthrough();
export type PioneerBaseModel = z.infer<typeof PioneerBaseModel>;

export const PioneerBaseModelList = z.union([
  z.array(PioneerBaseModel),
  z.object({ models: z.array(PioneerBaseModel) }).transform((body) => body.models),
  z.object({ data: z.array(PioneerBaseModel) }).transform((body) => body.data),
]);

export const PioneerInferenceResult = z
  .object({
    result: z.unknown().optional(),
    model_id: z.string().optional(),
  })
  .passthrough();
export type PioneerInferenceResult = z.infer<typeof PioneerInferenceResult>;

export const PioneerChatCompletion = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                role: z.string().optional(),
                content: z.string().nullable().optional(),
              })
              .passthrough()
              .optional(),
            text: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type PioneerChatCompletion = z.infer<typeof PioneerChatCompletion>;

export const PioneerTrainingJob = z
  .object({
    id: z.string(),
    status: z.string().optional(),
  })
  .passthrough();
export type PioneerTrainingJob = z.infer<typeof PioneerTrainingJob>;

/** Documented Fastino encoder ids used as product defaults. Live catalog wins. */
export const PIONEER_GLINER2_PII_MODEL = 'fastino/gliner2-privacy-filter-PII-multi';
export const PIONEER_GLIGUARD_MODEL = 'fastino/gliguard-LLMGuardrails-300M';
export const PIONEER_GLINER2_BASE_MODEL = 'fastino/gliner2-base-v1';
export const PIONEER_OPEN_WEIGHT_CHAT_MODEL = 'nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16';
export const PIONEER_FASTINO_FINANCE_MODEL = 'fastino/Fastino-Nemotron-3.5-Lightning-Finance';
