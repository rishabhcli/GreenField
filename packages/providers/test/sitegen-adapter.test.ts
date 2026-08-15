/**
 * Foundry site generator — honesty and contract tests.
 *
 * These tests never contact api.anthropic.com: a fake Messages client is
 * injected through the constructor seam. An empty SecretStore must fail
 * closed with setup instructions. emit_files output is validated, an empty
 * file set is an error (never an empty success), unknown project ids throw
 * rather than inventing files, and deployProject returns { url: null }
 * because this generator has no preview hosting.
 */

import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  CapabilityRegistry,
  CredentialsMissingError,
  ProviderContractError,
  SecretStore,
} from '@foundry/core';
import {
  ALL_MANIFESTS,
  EMIT_FILES_TOOL_NAME,
  FOUNDRY_SITEGEN_MANIFEST,
  FoundrySitegenAdapter,
  LOVABLE_MANIFEST,
  SITEGEN_GENERATION_MODEL,
  SITEGEN_MAX_OUTPUT_TOKENS,
  type SitegenMessagesClient,
} from '../src/index.js';

const FAKE_KEY = 'sk-ant-test-not-a-live-key-0000';

function emptyStore(): SecretStore {
  return new SecretStore({ get: () => undefined });
}

function keyStore(): SecretStore {
  return new SecretStore({ get: (name) => (name === 'ANTHROPIC_API_KEY' ? FAKE_KEY : undefined) });
}

function adapter(secrets: SecretStore, client?: SitegenMessagesClient): FoundrySitegenAdapter {
  return new FoundrySitegenAdapter(
    { secrets, environment: 'preview', publicBaseUrl: 'https://example.test' },
    client ? { client } : {},
  );
}

function toolUseMessage(input: unknown): Anthropic.Message {
  return {
    id: 'msg_test_1',
    type: 'message',
    role: 'assistant',
    model: SITEGEN_GENERATION_MODEL,
    content: [{ type: 'tool_use', id: 'toolu_1', name: EMIT_FILES_TOOL_NAME, input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 500 },
  } as unknown as Anthropic.Message;
}

function textOnlyMessage(text: string): Anthropic.Message {
  return {
    id: 'msg_test_2',
    type: 'message',
    role: 'assistant',
    model: SITEGEN_GENERATION_MODEL,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  } as unknown as Anthropic.Message;
}

function fakeClient(respond: (params: Anthropic.MessageCreateParamsNonStreaming, callIndex: number) => Anthropic.Message): {
  client: SitegenMessagesClient;
  requests: Anthropic.MessageCreateParamsNonStreaming[];
} {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    requests,
    client: {
      messages: {
        create: async (params) => {
          requests.push(params);
          return respond(params, requests.length - 1);
        },
      },
    },
  };
}

const VALID_FILES = {
  files: [
    { path: 'index.html', content: '<!doctype html><html lang="en"><body><main>Store</main></body></html>' },
    { path: 'styles.css', content: 'main { margin: 0 auto; }' },
  ],
};

describe('FoundrySitegenAdapter credentials', () => {
  it('createProject throws CredentialsMissingError naming ANTHROPIC_API_KEY before any call', async () => {
    const client = adapter(emptyStore());
    await expect(
      client.createProject({ initialMessage: 'Build a storefront', idempotencyKey: 'site.generate:site_1', wait: true }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CredentialsMissingError);
      expect((error as CredentialsMissingError).missing).toContain('ANTHROPIC_API_KEY');
      return true;
    });
  });
});

describe('FoundrySitegenAdapter generation via injected client', () => {
  it('createProject returns a project id and listFiles/readFile serve the cached files', async () => {
    const { client, requests } = fakeClient(() => toolUseMessage(VALID_FILES));
    const sitegen = adapter(keyStore(), client);

    const created = await sitegen.createProject({
      initialMessage: 'Generate a storefront from this spec: {"brand":"Ember Candles"}',
      idempotencyKey: 'site.generate:site_1',
      wait: true,
    });
    expect(created.projectId).toMatch(/^sitegen_/);

    expect(await sitegen.listFiles(created.projectId)).toEqual(['index.html', 'styles.css']);
    expect(await sitegen.readFile(created.projectId, 'index.html')).toContain('<main>Store</main>');
    expect(await sitegen.readFile(created.projectId, 'styles.css', 'HEAD')).toBe('main { margin: 0 auto; }');
    expect(requests).toHaveLength(1);
  });

  it('sends one strict emit_files tool-use request on the generation model', async () => {
    const { client, requests } = fakeClient(() => toolUseMessage(VALID_FILES));
    const sitegen = adapter(keyStore(), client);
    await sitegen.createProject({
      initialMessage: 'Generate a storefront from this spec: {"brand":"Ember Candles"}',
      idempotencyKey: 'site.generate:site_1',
      wait: true,
    });

    const params = requests[0]!;
    expect(params.model).toBe(SITEGEN_GENERATION_MODEL);
    expect(params.max_tokens).toBe(SITEGEN_MAX_OUTPUT_TOKENS);
    expect(params.tool_choice).toEqual({ type: 'tool', name: EMIT_FILES_TOOL_NAME });
    expect(params.messages).toEqual([
      { role: 'user', content: 'Generate a storefront from this spec: {"brand":"Ember Candles"}' },
    ]);
    expect(String(params.system)).toMatch(/senior web engineer/i);

    const tool = params.tools?.[0] as Anthropic.Tool;
    expect(params.tools).toHaveLength(1);
    expect(tool.name).toBe(EMIT_FILES_TOOL_NAME);
    expect(tool.strict).toBe(true);
    expect(tool.input_schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['files'],
    });
  });

  it('rejects an emit_files result with zero files — an empty set is not a generated site', async () => {
    const { client, requests } = fakeClient(() => toolUseMessage({ files: [] }));
    const sitegen = adapter(keyStore(), client);
    await expect(
      sitegen.createProject({ initialMessage: 'Build it', idempotencyKey: 'site.generate:site_1', wait: true }),
    ).rejects.toBeInstanceOf(ProviderContractError);
    expect(requests).toHaveLength(1);
  });

  it('rejects path traversal in emitted file paths', async () => {
    const { client } = fakeClient(() =>
      toolUseMessage({ files: [{ path: '../../etc/passwd', content: 'nope' }] }),
    );
    const sitegen = adapter(keyStore(), client);
    await expect(
      sitegen.createProject({ initialMessage: 'Build it', idempotencyKey: 'site.generate:site_1', wait: true }),
    ).rejects.toBeInstanceOf(ProviderContractError);
  });

  it('rejects a text-only reply that never called emit_files', async () => {
    const { client } = fakeClient(() => textOnlyMessage('Here is your site: <html>…</html>'));
    const sitegen = adapter(keyStore(), client);
    await expect(
      sitegen.createProject({ initialMessage: 'Build it', idempotencyKey: 'site.generate:site_1', wait: true }),
    ).rejects.toBeInstanceOf(ProviderContractError);
  });

  it('throws on unknown project ids instead of inventing files', async () => {
    const { client, requests } = fakeClient(() => toolUseMessage(VALID_FILES));
    const sitegen = adapter(keyStore(), client);
    await expect(sitegen.readFile('sitegen_unknown', 'index.html')).rejects.toThrow(/knows no project/);
    await expect(sitegen.listFiles('sitegen_unknown')).rejects.toThrow(/knows no project/);
    await expect(sitegen.sendMessage({ projectId: 'sitegen_unknown', message: 'revise', wait: true })).rejects.toThrow(
      /knows no project/,
    );
    expect(requests).toHaveLength(0);
  });

  it('throws on a path the project does not contain', async () => {
    const { client } = fakeClient(() => toolUseMessage(VALID_FILES));
    const sitegen = adapter(keyStore(), client);
    const created = await sitegen.createProject({
      initialMessage: 'Build it',
      idempotencyKey: 'site.generate:site_1',
      wait: true,
    });
    await expect(sitegen.readFile(created.projectId, 'missing.html')).rejects.toThrow(/has no file "missing.html"/);
  });

  it('deployProject returns { url: null } — no preview hosting exists here', async () => {
    const { client } = fakeClient(() => toolUseMessage(VALID_FILES));
    const sitegen = adapter(keyStore(), client);
    const created = await sitegen.createProject({
      initialMessage: 'Build it',
      idempotencyKey: 'site.generate:site_1',
      wait: true,
    });
    await expect(sitegen.deployProject(created.projectId)).resolves.toEqual({ url: null });
  });

  it('sendMessage revises the project by replacing the cached file set', async () => {
    const revised = {
      files: [
        { path: 'index.html', content: '<!doctype html><html lang="en"><body><main>Store v2</main></body></html>' },
        { path: 'app.js', content: 'document.querySelector("main");' },
      ],
    };
    const { client, requests } = fakeClient((_params, callIndex) =>
      toolUseMessage(callIndex === 0 ? VALID_FILES : revised),
    );
    const sitegen = adapter(keyStore(), client);
    const created = await sitegen.createProject({
      initialMessage: 'Build it',
      idempotencyKey: 'site.generate:site_1',
      wait: true,
    });

    await sitegen.sendMessage({ projectId: created.projectId, message: 'Add a cart script', wait: true });

    expect(await sitegen.listFiles(created.projectId)).toEqual(['index.html', 'app.js']);
    expect(await sitegen.readFile(created.projectId, 'index.html')).toContain('Store v2');

    expect(requests).toHaveLength(2);
    const revision = requests[1]!;
    expect(revision.tool_choice).toEqual({ type: 'tool', name: EMIT_FILES_TOOL_NAME });
    const revisionText = String(revision.messages[0]?.content);
    expect(revisionText).toContain('Add a cart script');
    expect(revisionText).toContain('<main>Store</main>');
  });
});

describe('foundry_sitegen manifest honesty', () => {
  it('is a registered external manifest offering site.generate at priority 2 behind Lovable', () => {
    expect(ALL_MANIFESTS.filter((m) => m.id === 'foundry_sitegen')).toHaveLength(1);
    expect(FOUNDRY_SITEGEN_MANIFEST.tier).toBe('external');
    expect(FOUNDRY_SITEGEN_MANIFEST.secrets.map((s) => s.env)).toEqual(['ANTHROPIC_API_KEY']);

    const binding = FOUNDRY_SITEGEN_MANIFEST.capabilities.find((c) => c.capability === 'site.generate');
    expect(binding?.priority).toBe(2);
    expect(binding?.evidence.kind).toBe('documented_api');

    const lovable = LOVABLE_MANIFEST.capabilities.find((c) => c.capability === 'site.generate');
    expect(lovable?.priority).toBe(1);
  });

  it('unblocks site.generate when only the Anthropic key exists, honestly configured_unverified', () => {
    const registry = new CapabilityRegistry({
      manifests: [LOVABLE_MANIFEST, FOUNDRY_SITEGEN_MANIFEST],
      secrets: keyStore(),
    });
    const status = registry.resolveCapability('site.generate');
    expect(status.provider).toBe('foundry_sitegen');
    expect(status.state).toBe('configured_unverified');
    expect(status.usable).toBe(true);
    expect(status.alternatives).toContain('lovable');
  });

  it('stays blocked when the Anthropic key is also absent', () => {
    const registry = new CapabilityRegistry({
      manifests: [LOVABLE_MANIFEST, FOUNDRY_SITEGEN_MANIFEST],
      secrets: emptyStore(),
    });
    const status = registry.resolveCapability('site.generate');
    expect(status.usable).toBe(false);
    expect(status.state).toBe('blocked_missing_credentials');
  });
});
