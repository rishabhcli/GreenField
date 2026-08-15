import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerCompanyRoutes } from '../src/routes/company.js';
import type { AppContext, Services } from '@foundry/runtime';

const EXISTING_ID = 'co_01M03F7RQW2M6540BY2GZHCFBW';

const validBody = {
  name: 'GreenField',
  mission: 'Operate an autonomous company loop without fabricated revenue or evidence.',
  ownerName: 'GreenField Operator',
  ownerEmail: 'operator@greenfield.local',
};

function ctxWithCompany(existing: { id: string } | undefined): AppContext {
  return {
    repos: {
      companies: {
        first: async () => existing,
      },
    },
    queues: {
      enqueue: async () => {
        throw new Error('enqueue must not run when a company already exists');
      },
    },
    capabilities: {
      resolveCapability: () => {
        throw new Error('prize-track snapshot must not run on conflict');
      },
    },
  } as unknown as AppContext;
}

describe('POST /api/companies', () => {
  it('returns 409 with the existing company id instead of 500', async () => {
    const app = Fastify();
    await registerCompanyRoutes(app, ctxWithCompany({ id: EXISTING_ID }), {} as Services);

    const response = await app.inject({
      method: 'POST',
      url: '/api/companies',
      payload: validBody,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: 'conflict',
      message: `A company already exists (${EXISTING_ID}). PUT /api/companies/${EXISTING_ID}/config to update it.`,
    });
    await app.close();
  });

  it('returns 400 for an invalid payload instead of 500', async () => {
    const app = Fastify();
    await registerCompanyRoutes(app, ctxWithCompany(undefined), {} as Services);

    const response = await app.inject({
      method: 'POST',
      url: '/api/companies',
      payload: { name: '', mission: 'x', ownerName: 'x', ownerEmail: 'not-an-email' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation');
    expect(response.json().error.message).toBe('Invalid company payload');
    await app.close();
  });
});

describe('PUT /api/companies/:id/config', () => {
  it('returns 200 when the config parses and the row updates', async () => {
    const { defaultHackathonCompanyConfig } = await import('@foundry/services');
    const config = defaultHackathonCompanyConfig({
      ownerName: 'GreenField Operator',
      ownerEmail: 'operator@greenfield.local',
    });
    const app = Fastify();
    const ctx = {
      repos: {
        companies: {
          first: async () => ({ id: EXISTING_ID }),
          updateConfig: async (id: string, next: unknown) => ({ id, config: next }),
        },
      },
      queues: { enqueue: async () => 'job' },
      capabilities: { resolveCapability: () => ({}) },
    } as unknown as AppContext;
    await registerCompanyRoutes(app, ctx, {} as Services);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/companies/${EXISTING_ID}/config`,
      payload: { config },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ companyId: EXISTING_ID, updated: true });
    await app.close();
  });
});
