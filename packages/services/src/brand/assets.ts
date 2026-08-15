/**
 * Brand asset generation.
 *
 * Images are persisted only when the image adapter returned a durable URL.
 * A content-policy rejection is a structured outcome, not an approved asset.
 * A base64 payload is not stored — the asset schema forbids data URIs.
 */

import {
  CapabilityUnsupportedError,
  CredentialsMissingError,
  type AssetKind,
  type Capability,
} from '@foundry/core';
import { ImageGenerationAdapter, type ImageGenerationResult } from '@foundry/providers';
import { optionalCapability, type ServiceDeps, type ServiceOutcome } from '../deps.js';

export interface GenerateAssetInput {
  readonly companyId: string;
  readonly brandId: string;
  readonly assetKind: AssetKind;
  readonly prompt: string;
  readonly variants?: number;
}

export interface GeneratedAssetRecord {
  readonly assetId: string | null;
  readonly status: 'generated' | 'rejected' | 'unpersisted';
  readonly reason?: string;
  readonly url?: string | null;
}

export class BrandAssetService {
  constructor(private readonly deps: ServiceDeps) {}

  async generate(input: GenerateAssetInput): Promise<ServiceOutcome<readonly GeneratedAssetRecord[]>> {
    const adapter = optionalCapability<ImageGenerationAdapter>(this.deps, 'asset.image_generation');
    if (!adapter || typeof adapter.generateImage !== 'function') {
      return blocked('asset.image_generation', this.#reason('asset.image_generation'));
    }

    const variants = Math.min(4, Math.max(1, Math.trunc(input.variants ?? 1)));

    try {
      const result = await adapter.generateImage({ prompt: input.prompt, n: variants });
      return { ok: true, data: await this.#persist(input, result, adapter) };
    } catch (error) {
      return this.#fromProviderError('asset.image_generation', error);
    }
  }

  async #persist(
    input: GenerateAssetInput,
    result: ImageGenerationResult,
    adapter: ImageGenerationAdapter,
  ): Promise<GeneratedAssetRecord[]> {
    if (result.kind === 'rejected') {
      return [{ assetId: null, status: 'rejected', reason: result.reason }];
    }

    const records: GeneratedAssetRecord[] = [];
    const model = adapter.manifest?.id ?? 'openai_images';
    for (const image of result.images) {
      if (!image.url || image.url.startsWith('data:')) {
        records.push({
          assetId: null,
          status: 'unpersisted',
          reason: 'Adapter returned no durable object-storage URL. Base64/data URIs are not stored.',
          url: null,
        });
        continue;
      }
      const assetId = await this.deps.repos.build.assets.create({
        companyId: input.companyId,
        brandId: input.brandId,
        kind: input.assetKind,
        url: image.url,
        mimeType: 'image/png',
        generation: {
          provider: model,
          model: 'gpt-image-1',
          prompt: result.prompt,
          seed: result.seed === null ? null : String(result.seed),
          humanAuthored: false,
        },
        altText: input.prompt.slice(0, 200),
      });
      records.push({ assetId, status: 'generated', url: image.url });
    }
    return records;
  }

  #reason(capability: Capability): string {
    const status = this.deps.providers.forCapability(capability).status;
    return status.remediation ?? `capability state is ${status.state}`;
  }

  #fromProviderError<T>(capability: Capability, error: unknown): ServiceOutcome<T> {
    if (error instanceof CredentialsMissingError || error instanceof CapabilityUnsupportedError) {
      return blocked(capability, error.message);
    }
    throw error;
  }
}

function blocked<T>(capability: Capability, reason: string): ServiceOutcome<T> {
  return { ok: false, blockedOn: { capability, reason } };
}
