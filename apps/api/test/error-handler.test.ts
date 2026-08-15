import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  FoundryError,
  InternalError,
  ValidationError,
} from '@foundry/core';
import { z } from 'zod';
import type { AppContext, Services } from '@foundry/runtime';
import { httpStatusForError, registerErrorHandler, stampFastifyStatusCode } from '../src/errors.js';
import { registerCompanyRoutes } from '../src/routes/company.js';

const COMPANY_ID = 'co_01M03F7RQW2M6540BY2GZHCFBW';

async function appWithHandler() {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  return app;
}

describe('httpStatus → statusCode mapping', () => {
  it('stamps ValidationError.httpStatus onto statusCode', () => {
    const error = new ValidationError('Invalid company config');
    expect((error as { statusCode?: number }).statusCode).toBeUndefined();
    expect(stampFastifyStatusCode(error)).toBe(400);
    expect((error as { statusCode?: number }).statusCode).toBe(400);
  });

  it('prefers Foundry httpStatus over a Fastify-stamped 500', () => {
    const error = new ConflictError('duplicate');
    (error as { statusCode?: number }).statusCode = 500;
    expect(httpStatusForError(error)).toBe(409);
    expect(stampFastifyStatusCode(error)).toBe(409);
    expect((error as { statusCode?: number }).statusCode).toBe(409);
  });

  it('leaves unclassified errors as 500', () => {
    expect(httpStatusForError(new Error('bug'))).toBe(500);
    expect(httpStatusForError(new InternalError('bug'))).toBe(500);
  });
});

describe('foundry error handler', () => {
  it('maps ValidationError.httpStatus onto Fastify statusCode as 400, not 500', async () => {
    const app = await appWithHandler();
    app.put('/throw-validation', async () => {
      throw new ValidationError('Invalid company config');
    });

    const response = await app.inject({ method: 'PUT', url: '/throw-validation', payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'validation',
      message: 'Invalid company config',
    });
    await app.close();
  });

  it('maps ConflictError to 409 even when Fastify already stamped statusCode 500', async () => {
    const app = await appWithHandler();
    app.post('/throw-conflict', async () => {
      const error = new ConflictError('A company already exists (co_1).');
      (error as { statusCode?: number }).statusCode = 500;
      throw error;
    });

    const response = await app.inject({ method: 'POST', url: '/throw-conflict' });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('conflict');
    expect(response.json().error.message).toContain('already exists');
    await app.close();
  });

  it('maps an explicit Foundry httpStatus 422 instead of 500', async () => {
    const app = await appWithHandler();
    app.put('/throw-422', async () => {
      throw new FoundryError({
        category: 'validation',
        message: 'Config is semantically unprocessable',
        httpStatus: 422,
      });
    });

    const response = await app.inject({ method: 'PUT', url: '/throw-422' });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('validation');
    await app.close();
  });

  it('maps ZodError to 400 validation, not 500', async () => {
    const app = await appWithHandler();
    app.put('/throw-zod', async () => {
      z.object({ config: z.object({ owner: z.string() }) }).parse({});
    });

    const response = await app.inject({ method: 'PUT', url: '/throw-zod', payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation');
    expect(response.json().error.message).not.toBe('Internal error');
    await app.close();
  });

  it('uses Foundry httpStatus on error.cause when the wrapper is a 500 Fastify error', async () => {
    const app = await appWithHandler();
    app.put('/wrapped', async () => {
      const cause = new ValidationError('bad field');
      throw Object.assign(new Error('wrapped'), { statusCode: 500, cause });
    });

    const response = await app.inject({ method: 'PUT', url: '/wrapped' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'validation', message: 'bad field' });
    await app.close();
  });

  it('does not swallow unclassified failures: still 500 Internal error', async () => {
    const app = await appWithHandler();
    app.put('/bug', async () => {
      throw new Error('disk is on fire');
    });

    const response = await app.inject({ method: 'PUT', url: '/bug' });

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toMatchObject({
      code: 'internal',
      message: 'Internal error',
    });
    await app.close();
  });

  it('keeps InternalError as 500 and does not leak the message', async () => {
    const app = await appWithHandler();
    app.get('/internal', async () => {
      throw new InternalError('connection string leaked here');
    });

    const response = await app.inject({ method: 'GET', url: '/internal' });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.message).toBe('Internal error');
    expect(JSON.stringify(response.json())).not.toContain('connection string');
    await app.close();
  });
});

describe('POST /api/companies', () => {
  it('keeps duplicate create as 409 after the handler maps httpStatus', async () => {
    const app = await appWithHandler();
    await registerCompanyRoutes(
      app,
      {
        repos: {
          companies: { first: async () => ({ id: COMPANY_ID }) },
        },
        queues: { enqueue: async () => 'job' },
        capabilities: { resolveCapability: () => ({}) },
      } as unknown as AppContext,
      {} as Services,
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/companies',
      payload: {
        name: 'GreenField',
        mission: 'Operate an autonomous company loop without fabricated revenue or evidence.',
        ownerName: 'GreenField Operator',
        ownerEmail: 'operator@greenfield.local',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('conflict');
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
    const app = await appWithHandler();
    await registerCompanyRoutes(
      app,
      {
        repos: {
          companies: {
            updateConfig: async (id: string, next: unknown) => ({ id, config: next }),
          },
        },
      } as unknown as AppContext,
      {} as Services,
    );

    const response = await app.inject({
      method: 'PUT',
      url: `/api/companies/${COMPANY_ID}/config`,
      payload: { config },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ companyId: COMPANY_ID, updated: true });
    await app.close();
  });

  it('returns 400 for an invalid config instead of 500', async () => {
    const app = await appWithHandler();
    await registerCompanyRoutes(
      app,
      {
        repos: {
          companies: {
            updateConfig: async () => {
              throw new Error('updateConfig must not run on invalid body');
            },
          },
        },
      } as unknown as AppContext,
      {} as Services,
    );

    const response = await app.inject({
      method: 'PUT',
      url: `/api/companies/${COMPANY_ID}/config`,
      payload: { config: { owner: { email: 'not-an-email' } } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation');
    expect(response.json().error.message).not.toBe('Internal error');
    await app.close();
  });

  it('returns 409 when updateConfig throws ConflictError, not 500', async () => {
    const { defaultHackathonCompanyConfig } = await import('@foundry/services');
    const config = defaultHackathonCompanyConfig({
      ownerName: 'GreenField Operator',
      ownerEmail: 'operator@greenfield.local',
    });
    const app = await appWithHandler();
    await registerCompanyRoutes(
      app,
      {
        repos: {
          companies: {
            updateConfig: async () => {
              throw new ConflictError('Config write collided with another update');
            },
          },
        },
      } as unknown as AppContext,
      {} as Services,
    );

    const response = await app.inject({
      method: 'PUT',
      url: `/api/companies/${COMPANY_ID}/config`,
      payload: { config },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: 'conflict',
      message: 'Config write collided with another update',
    });
    await app.close();
  });
});
