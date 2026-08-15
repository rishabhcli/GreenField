/**
 * Image generation adapter — logo, packaging concept, product render and ad
 * creative image generation via the OpenAI Images API. Structured like
 * `../stripe/index.ts`: narrow zod schemas, one adapter class, comments that
 * explain *why*. Every method makes a real HTTP call; with no
 * `OPENAI_API_KEY` configured, `requireSecret` raises a typed
 * `CredentialsMissingError`.
 */

import { FoundryError, ValidationError } from '@foundry/core';
import { ProviderAdapter, type AdapterContext, type ProbeResult } from '../http/adapter.js';
import { bearerAuth, type ProviderHttpClient } from '../http/client.js';
import { SECRETS, OPENAI_IMAGES_MANIFEST } from '../manifests.js';
import { OpenAiImageGenerationResponse, OpenAiModelListResponse, extractOpenAiError } from './schemas.js';

/**
 * Terminal by construction (`category: 'validation'`, not in the platform's
 * retryable set) — a rejected prompt will be rejected identically on retry,
 * so `generateImage` never re-attempts one and instead returns it as a
 * structured result rather than letting it propagate as a thrown error.
 */
export class ImageContentPolicyError extends FoundryError {
  constructor(message: string, context?: Record<string, unknown>) {
    super({
      category: 'validation',
      code: 'openai_images.content_policy_violation',
      message: `Content policy rejected the prompt: ${message}`,
      context,
    });
  }
}

export interface GenerateImageInput {
  readonly prompt: string;
  /** Model-dependent (`1024x1024`, `1536x1024`, `1024x1536`, `auto` for `gpt-image-1`; `1024x1792`/`1792x1024` for `dall-e-3`). Kept as a plain string rather than a hard-coded enum. */
  readonly size?: string;
  /** Model-dependent (`standard`/`hd` for `dall-e-3`; `low`/`medium`/`high`/`auto` for `gpt-image-1`). */
  readonly quality?: string;
  readonly n?: number;
  readonly model?: string;
  /**
   * Sent through if provided. OpenAI's public Images API does not document
   * seed-based determinism the way some self-hosted/OSS image models do, so
   * this is never presented as a guarantee — "reproducibility" here means
   * "the seed you would need to resend to try to reproduce this," echoed
   * back on the result, not a value OpenAI has confirmed it honoured.
   */
  readonly seed?: number;
}

export interface GeneratedImage {
  readonly url: string | null;
  readonly base64: string | null;
  readonly revisedPrompt: string | null;
}

export type ImageGenerationResult =
  | { readonly kind: 'ok'; readonly images: readonly GeneratedImage[]; readonly prompt: string; readonly seed: number | null }
  | { readonly kind: 'rejected'; readonly reason: string; readonly prompt: string; readonly seed: number | null };

export class ImageGenerationAdapter extends ProviderAdapter {
  override readonly manifest = OPENAI_IMAGES_MANIFEST;
  #client: ProviderHttpClient | undefined;

  constructor(ctx: AdapterContext) {
    super(ctx);
  }

  #httpClient(): ProviderHttpClient {
    if (!this.#client) {
      const secret = this.requireSecret(SECRETS.openaiImagesApiKey);
      this.#client = this.http(bearerAuth(secret), {
        classifyError: (status, body) => this.#classifyError(status, body),
      });
    }
    return this.#client;
  }

  #classifyError(_status: number, body: unknown): FoundryError | undefined {
    const error = extractOpenAiError(body);
    if (!error) return undefined;
    if (error.code === 'content_policy_violation' || /content policy|safety system/i.test(error.message)) {
      return new ImageContentPolicyError(error.message, { code: error.code ?? null, param: error.param ?? null });
    }
    return undefined;
  }

  override async probe(): Promise<ProbeResult> {
    const res = await this.#httpClient().request({ method: 'GET', path: '/models', operation: 'models.list' }, OpenAiModelListResponse);
    return {
      succeeded: true,
      detail: `GET /v1/models returned ${res.body.data.length} model(s)`,
      evidence: { endpoint: 'GET /v1/models', modelCount: res.body.data.length },
    };
  }

  /**
   * `POST /v1/images/generations`. A content-policy rejection is caught here
   * and returned as a structured `{ kind: 'rejected', reason }` result rather
   * than thrown — it is terminal and it is a business-meaningful outcome
   * (the creative agent needs to try a different prompt), not a transport
   * failure. Every other error (auth, rate limit, provider outage) still
   * propagates as a thrown `FoundryError`, unchanged.
   */
  async generateImage(input: GenerateImageInput): Promise<ImageGenerationResult> {
    this.assertActivated();
    if (!input.prompt.trim()) throw new ValidationError('generateImage requires a non-empty prompt');
    if (input.n !== undefined && input.n < 1) throw new ValidationError('generateImage requires n >= 1', { n: input.n });

    try {
      const res = await this.#httpClient().request(
        {
          method: 'POST',
          path: '/images/generations',
          operation: 'images.generate',
          body: {
            model: input.model ?? 'gpt-image-1',
            prompt: input.prompt,
            n: input.n ?? 1,
            ...(input.size ? { size: input.size } : {}),
            ...(input.quality ? { quality: input.quality } : {}),
            ...(input.seed !== undefined ? { seed: input.seed } : {}),
          },
        },
        OpenAiImageGenerationResponse,
      );
      return {
        kind: 'ok',
        images: res.body.data.map((d) => ({ url: d.url ?? null, base64: d.b64_json ?? null, revisedPrompt: d.revised_prompt ?? null })),
        prompt: input.prompt,
        seed: input.seed ?? null,
      };
    } catch (error) {
      if (error instanceof ImageContentPolicyError) {
        return { kind: 'rejected', reason: error.message, prompt: input.prompt, seed: input.seed ?? null };
      }
      throw error;
    }
  }
}

export * from './schemas.js';
