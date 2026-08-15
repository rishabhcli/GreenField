/**
 * Pioneer by Fastino Labs — open-weight inference, GLiNER2/GLiGuard, fine-tune.
 *
 * Auth is `X-API-Key` against `https://api.pioneer.ai` (native inference and
 * catalog) and `https://api.pioneer.ai/v1` (OpenAI-compatible chat). Missing
 * `PIONEER_API_KEY` raises `CredentialsMissingError`. Nothing here substitutes
 * a stub completion or a fabricated entity list.
 *
 * Prize-track usage is concrete:
 *   - GLiNER2-PII on support/legal text (`compliance.pii_scan`)
 *   - GLiGuard on inbound prompts (`compliance.prompt_guard`)
 *   - Nemotron / Fastino-Nemotron chat for specialist open-weight generation
 *   - Optional `POST /felix/training-jobs` when a fine-tune is explicitly requested
 */

import { ValidationError } from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { apiKeyHeaderAuth, type ProviderHttpClient } from '../http/client.js';
import { PIONEER_MANIFEST, SECRETS } from '../manifests.js';
import {
  PIONEER_FASTINO_FINANCE_MODEL,
  PIONEER_GLIGUARD_MODEL,
  PIONEER_GLINER2_BASE_MODEL,
  PIONEER_GLINER2_PII_MODEL,
  PIONEER_OPEN_WEIGHT_CHAT_MODEL,
  PioneerBaseModelList,
  PioneerChatCompletion,
  PioneerInferenceResult,
  PioneerTrainingJob,
  type PioneerBaseModel,
} from './schemas.js';

export {
  PIONEER_FASTINO_FINANCE_MODEL,
  PIONEER_GLIGUARD_MODEL,
  PIONEER_GLINER2_BASE_MODEL,
  PIONEER_GLINER2_PII_MODEL,
  PIONEER_OPEN_WEIGHT_CHAT_MODEL,
};

export interface PioneerChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface PioneerPiiSpan {
  readonly label: string;
  readonly text: string;
  readonly score: number | null;
}

export class PioneerAdapter extends ProviderAdapter {
  override readonly manifest = PIONEER_MANIFEST;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #client(): ProviderHttpClient {
    const secret = this.requireSecret(SECRETS.pioneerApiKey);
    return this.http(apiKeyHeaderAuth('X-API-Key', secret), {
      defaultHeaders: { accept: 'application/json' },
    });
  }

  override async probe(): Promise<ProbeResult> {
    const models = await this.listInferenceModels();
    const ids = models.map((m) => m.id);
    const hasGliner = ids.some((id) => id.includes('gliner2') || id.includes('gliguard'));
    return {
      succeeded: true,
      detail: `GET /base-models?supports_inference=true returned ${models.length} model(s)`,
      evidence: {
        endpoint: 'GET /base-models?supports_inference=true',
        count: models.length,
        hasGlinerOrGliguard: hasGliner,
        sampleIds: ids.slice(0, 8),
      },
    };
  }

  async listInferenceModels(): Promise<readonly PioneerBaseModel[]> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'GET',
        path: '/base-models',
        query: { supports_inference: true },
        operation: 'base-models.list',
      },
      PioneerBaseModelList,
    );
    return response.body;
  }

  /**
   * Native encoder inference. Used for GLiNER2 NER/PII and GLiGuard classifications.
   */
  async infer(input: {
    readonly modelId: string;
    readonly text: string;
    readonly schema: Record<string, unknown>;
    readonly threshold?: number;
  }): Promise<PioneerInferenceResult> {
    this.assertActivated();
    if (input.text.trim().length === 0) throw new ValidationError('Pioneer infer requires non-empty text');
    const response = await this.#client().request(
      {
        method: 'POST',
        path: '/inference',
        operation: 'inference.run',
        body: {
          model_id: input.modelId,
          text: input.text,
          schema: input.schema,
          ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
        },
      },
      PioneerInferenceResult,
    );
    return response.body;
  }

  async scanPii(text: string): Promise<{ readonly modelId: string; readonly spans: readonly PioneerPiiSpan[]; readonly raw: unknown }> {
    const result = await this.infer({
      modelId: PIONEER_GLINER2_PII_MODEL,
      text,
      schema: {
        entities: ['person', 'email', 'phone_number', 'address', 'credit_card', 'ssn', 'date_of_birth'],
      },
      threshold: 0.5,
    });
    return { modelId: PIONEER_GLINER2_PII_MODEL, spans: extractPiiSpans(result.result), raw: result.result };
  }

  async guardPrompt(text: string): Promise<{ readonly modelId: string; readonly raw: unknown }> {
    const result = await this.infer({
      modelId: PIONEER_GLIGUARD_MODEL,
      text,
      schema: {
        classifications: [
          { task: 'risk', labels: ['safe', 'jailbreak', 'pii_leak', 'toxic', 'prompt_injection'] },
        ],
      },
      threshold: 0.5,
    });
    return { modelId: PIONEER_GLIGUARD_MODEL, raw: result.result };
  }

  async extractEntities(text: string, entities: readonly string[]): Promise<PioneerInferenceResult> {
    return this.infer({
      modelId: PIONEER_GLINER2_BASE_MODEL,
      text,
      schema: { entities: [...entities] },
    });
  }

  async chat(input: {
    readonly model?: string;
    readonly messages: readonly PioneerChatMessage[];
    readonly maxTokens?: number;
  }): Promise<{ readonly model: string; readonly text: string; readonly raw: PioneerChatCompletion }> {
    this.assertActivated();
    if (input.messages.length === 0) throw new ValidationError('Pioneer chat requires at least one message');
    const model = input.model ?? PIONEER_OPEN_WEIGHT_CHAT_MODEL;
    const response = await this.#client().request(
      {
        method: 'POST',
        path: '/v1/chat/completions',
        operation: 'chat.completions',
        body: {
          model,
          messages: input.messages,
          ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
        },
      },
      PioneerChatCompletion,
    );
    const text = response.body.choices[0]?.message?.content ?? response.body.choices[0]?.text ?? '';
    return { model, text, raw: response.body };
  }

  /**
   * LoRA fine-tune. Never called from a retrying worker without an idempotency
   * ledger entry — a duplicate POST bills a second job.
   */
  async createTrainingJob(input: {
    readonly baseModelId: string;
    readonly idempotencyKey: string;
    readonly body: Record<string, unknown>;
  }): Promise<PioneerTrainingJob> {
    this.assertActivated();
    const response = await this.#client().request(
      {
        method: 'POST',
        path: '/felix/training-jobs',
        operation: 'felix.training-jobs.create',
        idempotencyKey: input.idempotencyKey,
        body: { model_id: input.baseModelId, ...input.body },
      },
      PioneerTrainingJob,
    );
    return response.body;
  }
}

function extractPiiSpans(raw: unknown): readonly PioneerPiiSpan[] {
  const entities = lookupEntities(raw);
  if (!entities) return [];
  const out: PioneerPiiSpan[] = [];
  for (const item of entities) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const label = stringOf(rec['label'] ?? rec['entity'] ?? rec['type']);
    const text = stringOf(rec['text'] ?? rec['span'] ?? rec['value']);
    if (!label || !text) continue;
    const scoreRaw = rec['score'] ?? rec['confidence'];
    out.push({
      label,
      text,
      score: typeof scoreRaw === 'number' ? scoreRaw : null,
    });
  }
  return out;
}

function lookupEntities(raw: unknown): readonly unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  if (Array.isArray(rec['entities'])) return rec['entities'];
  if (Array.isArray(rec['result'])) return rec['result'];
  return undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
