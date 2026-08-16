/**
 * The agent interaction feed.
 *
 * Two things are being defended here, and neither is cosmetic.
 *
 * The first is the gate: this route reads what the company's agents said to
 * each other, which is strictly more sensitive than the run listing beside it.
 * It fails closed like every other read on the control plane.
 *
 * The second is what leaves the process. A stored assistant turn contains a
 * `thinking` block whose `signature` is a multi-kilobyte base64 attestation,
 * and tool inputs are model-authored — a model can put a key in one. Rendering
 * either in a browser is how a dashboard becomes a leak. The redaction tests
 * below use the real shapes taken from the live `agent_messages` table.
 */

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AgentActivityRow } from '@foundry/db';
import type { AppContext } from '@foundry/runtime';
import { registerErrorHandler } from '../src/errors.js';
import {
  AgentActivityQuery,
  buildFeed,
  redactText,
  summariseToolInput,
  registerAgentActivityRoute,
} from '../src/routes/agent-activity.js';

const OPERATOR = 'correct-token';
const COMPANY_ID = 'co_01M03F7RQW2M6540BY2GZHCFBW';
const RUN_ID = 'run_01M03Y7KS5ZJSN7T7A94GW1QZ1';

/** The exact signature shape the Anthropic API returns on a thinking block. */
const SIGNATURE =
  'CAIS1wMKhwEIEBgCKkDkrCRC2OuLC9PUEMK1WQ4q7s7282ibxpiE+MoDpixJgf3KO+eufjM4NAy5bFy2LNgD2mRdLtWwAk/eqgDqbCwGMg1jbGF1ZGUtb3B1cy01OAFCCHRoaW5raW5nWiQ2NDgxNWQyMS1jNTFkLTRiYjEtOWUyMy1jNmYwNGMzYTA2NjMSDFJ6ysSCkMppCI7ARhoM';

function row(over: Partial<AgentActivityRow> = {}): AgentActivityRow {
  return {
    id: 'amsg_01',
    run_id: RUN_ID,
    sequence: 2,
    role: 'assistant',
    content: [],
    tool_name: null,
    tool_use_id: null,
    is_error: false,
    created_at: new Date('2026-08-16T00:06:07.480Z'),
    role_key: 'research_manager',
    run_status: 'running',
    objective: 'Collect real market evidence.',
    model: 'claude-opus-5',
    run_started_at: new Date('2026-08-16T00:06:00.000Z'),
    ...over,
  } as AgentActivityRow;
}

function ctxWith(rows: readonly AgentActivityRow[], token: string | undefined = OPERATOR): AppContext {
  const captured: { limit?: number; runLimit?: number; runId?: string } = {};
  return {
    captured,
    config: { operatorApiToken: token },
    repos: {
      companies: { first: async () => ({ id: COMPANY_ID }) },
      agents: {
        messages: {
          recentForCompany: async (_companyId: string, opts: Record<string, unknown>) => {
            Object.assign(captured, opts);
            return rows;
          },
        },
      },
    },
  } as unknown as AppContext;
}

async function appWith(rows: readonly AgentActivityRow[], token?: string) {
  const ctx = ctxWith(rows, token);
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await registerAgentActivityRoute(app, ctx);
  return { app, ctx: ctx as AppContext & { captured: Record<string, unknown> } };
}

describe('GET /api/agent-activity', () => {
  it('fails closed with no token configured and refuses a wrong one', async () => {
    const nothingConfigured = await appWith([], undefined);
    const refused = await nothingConfigured.app.inject({ method: 'GET', url: '/api/agent-activity' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('policy_denied');
    await nothingConfigured.app.close();

    const { app } = await appWith([]);
    const anonymous = await app.inject({ method: 'GET', url: '/api/agent-activity' });
    expect(anonymous.statusCode).toBe(403);

    const wrong = await app.inject({
      method: 'GET',
      url: '/api/agent-activity',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(403);
    await app.close();
  });

  it('bounds limit and runs, and defaults both', async () => {
    const { app, ctx } = await appWith([]);
    const headers = { authorization: `Bearer ${OPERATOR}` };

    const defaults = await app.inject({ method: 'GET', url: '/api/agent-activity', headers });
    expect(defaults.statusCode).toBe(200);
    expect(ctx.captured.limit).toBe(60);
    expect(ctx.captured.runLimit).toBe(6);

    const max = await app.inject({ method: 'GET', url: '/api/agent-activity?limit=200&runs=25', headers });
    expect(max.statusCode).toBe(200);
    expect(ctx.captured.limit).toBe(200);

    for (const url of ['/api/agent-activity?limit=201', '/api/agent-activity?limit=0', '/api/agent-activity?runs=26']) {
      const response = await app.inject({ method: 'GET', url, headers });
      expect(response.statusCode, url).toBe(400);
      expect(response.json().error.code).toBe('validation');
    }
    // The rejected values never reached the repository.
    expect(ctx.captured.limit).toBe(200);
    await app.close();
  });

  it('passes runId through only when supplied', async () => {
    const { app, ctx } = await appWith([]);
    const headers = { authorization: `Bearer ${OPERATOR}` };
    await app.inject({ method: 'GET', url: '/api/agent-activity', headers });
    expect(ctx.captured.runId).toBeUndefined();
    await app.inject({ method: 'GET', url: `/api/agent-activity?runId=${RUN_ID}`, headers });
    expect(ctx.captured.runId).toBe(RUN_ID);
    await app.close();
  });

  it('reports an unconfigured company as configured:false, not as an empty company', async () => {
    const ctx = {
      config: { operatorApiToken: OPERATOR },
      repos: { companies: { first: async () => null }, agents: { messages: {} } },
    } as unknown as AppContext;
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    await registerAgentActivityRoute(app, ctx);
    const response = await app.inject({
      method: 'GET',
      url: '/api/agent-activity',
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: false, steps: [], runs: [] });
    await app.close();
  });

  /**
   * `limit` bounds messages, not steps: one assistant turn can be four blocks.
   * The console needs both numbers or it will report a full window off a step
   * count the API never capped.
   */
  it('reports messages read separately from steps emitted', async () => {
    const { app } = await appWith([
      row({
        content: [
          { type: 'text', text: 'one' },
          { type: 'tool_use', id: 't1', name: 'a_tool', input: {} },
          { type: 'tool_use', id: 't2', name: 'b_tool', input: {} },
        ],
      }),
    ]);
    const body = (
      await app.inject({
        method: 'GET',
        url: '/api/agent-activity?limit=1',
        headers: { authorization: `Bearer ${OPERATOR}` },
      })
    ).json();
    expect(body.limit).toBe(1);
    expect(body.messagesRead).toBe(1);
    expect(body.steps).toHaveLength(3);
    await app.close();
  });

  it('serves the feed and the runs it came from', async () => {
    const { app } = await appWith([
      row({
        id: 'amsg_02',
        sequence: 3,
        role: 'tool_result',
        content: { content: '{"inserted":15,"duplicates":0}', toolUseId: 'toolu_1' },
      }),
      row({
        content: [
          { type: 'text', text: 'Collecting across independent queries.' },
          { type: 'tool_use', id: 'toolu_1', name: 'research_run_collection', input: { query: 'invoicing pain' } },
        ],
      }),
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/api/agent-activity',
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.configured).toBe(true);
    expect(body.runs).toEqual([
      {
        id: RUN_ID,
        roleKey: 'research_manager',
        status: 'running',
        objective: 'Collect real market evidence.',
        model: 'claude-opus-5',
      },
    ]);
    expect(body.steps.map((s: { kind: string }) => s.kind)).toEqual([
      'tool_result',
      'assistant_text',
      'tool_call',
    ]);
    // A result is named after the call it answers, even though the stored row
    // carries no tool_name.
    expect(body.steps[0].toolName).toBe('research_run_collection');
    await app.close();
  });
});

describe('the feed never leaks a signature, a secret or a blob', () => {
  it('drops the thinking signature and keeps the thought', () => {
    const steps = buildFeed([
      row({ content: [{ type: 'thinking', thinking: 'Only two clusters cleared.', signature: SIGNATURE }] }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe('thinking');
    expect(steps[0]?.text).toBe('Only two clusters cleared.');
    expect(JSON.stringify(steps)).not.toContain(SIGNATURE.slice(0, 40));
    expect(JSON.stringify(steps)).not.toContain('signature');
  });

  it('says so rather than showing nothing when a model withholds its thinking', () => {
    const steps = buildFeed([row({ content: [{ type: 'thinking', thinking: '', signature: SIGNATURE }] })]);
    expect(steps[0]?.text).toBeNull();
    expect(steps[0]?.note).toContain('not disclosed');
  });

  it('replaces long base64 runs and data URIs wherever they appear', () => {
    expect(redactText(`prefix ${SIGNATURE} suffix`)).toBe('prefix [binary omitted] suffix');
    expect(redactText('img data:image/png;base64,iVBORw0KGgoAAAANSUhEUg== end')).toBe(
      'img [binary omitted] end',
    );
    const steps = buildFeed([
      row({ role: 'tool_result', content: { content: `screenshot: ${SIGNATURE}`, toolUseId: 't1' } }),
    ]);
    expect(steps[0]?.text).toBe('screenshot: [binary omitted]');
  });

  it('redacts token shapes and secret-named fields in a model-authored input', () => {
    expect(redactText('use sk_live_51HxyzABCDEFGH now')).toBe('use [redacted secret] now');
    expect(redactText('Authorization: Bearer abcdefghijklmnop.qrstuv')).toContain('Bearer [redacted]');
    expect(summariseToolInput({ url: 'https://x.test', apiKey: 'plainlooking', query: 'desks' })).toBe(
      'url=https://x.test · apiKey=[redacted] · query=desks',
    );
    expect(summariseToolInput({ authorization: 'anything' })).toBe('authorization=[redacted]');
  });

  it('clips long content and admits that it clipped', () => {
    const long = 'Collect real market evidence and cite every source. '.repeat(200);
    const steps = buildFeed([row({ role: 'user', content: long })]);
    expect(steps[0]?.truncated).toBe(true);
    expect((steps[0]?.text ?? '').length).toBeLessThan(500);
    expect(steps[0]?.text?.endsWith('…')).toBe(true);
  });

  /**
   * A 100-character unbroken run of the base64 alphabet does not occur in
   * prose — every sentence has spaces and every URL has punctuation — so the
   * rule is safe, but it is a rule about shape rather than about type, and
   * that trade is worth pinning.
   */
  it('treats any long unbroken alphanumeric run as binary', () => {
    expect(redactText('x'.repeat(120))).toBe('[binary omitted]');
    expect(redactText('a normal sentence with ninety-nine perfectly ordinary words in it')).toBe(
      'a normal sentence with ninety-nine perfectly ordinary words in it',
    );
    expect(redactText('https://api.example.test/v1/search?q=standing+desks&limit=20')).toContain('example.test');
  });

  it('reports the system briefing without rendering it', () => {
    const steps = buildFeed([
      row({ role: 'system', content: { text: 'You are the Research Manager. Secret ops detail follows…' } }),
    ]);
    expect(steps[0]?.kind).toBe('system');
    expect(steps[0]?.text).toBeNull();
    expect(steps[0]?.note).toMatch(/^role briefing · \d+ characters$/);
  });

  it('splits one assistant turn into ordered blocks and keeps them in one group', () => {
    const steps = buildFeed([
      row({
        content: [
          { type: 'thinking', thinking: 'Two singleton clusters.', signature: SIGNATURE },
          { type: 'text', text: 'Retrying verification.' },
          { type: 'tool_use', id: 'toolu_a', name: 'research_verify_evidence', input: { limit: 10 } },
          { type: 'tool_use', id: 'toolu_b', name: 'research_cluster_pain_points', input: { minClusterSize: 2 } },
        ],
      }),
    ]);
    expect(steps.map((s) => s.kind)).toEqual(['thinking', 'assistant_text', 'tool_call', 'tool_call']);
    expect(new Set(steps.map((s) => s.messageId)).size).toBe(1);
    expect(new Set(steps.map((s) => s.id)).size).toBe(4);
    expect(steps[2]?.text).toBe('limit=10');
  });

  it('marks a failed tool result as an error rather than a result', () => {
    const steps = buildFeed([
      row({
        role: 'tool_result',
        is_error: true,
        content: { content: '"research.run_collection" failed: circuit breaker is open', toolUseId: 't9' },
      }),
    ]);
    expect(steps[0]?.kind).toBe('tool_error');
    expect(steps[0]?.text).toContain('circuit breaker is open');
  });

  it('bounds the query schema itself', () => {
    expect(AgentActivityQuery.parse({}).limit).toBe(60);
    expect(AgentActivityQuery.safeParse({ limit: 201 }).success).toBe(false);
    expect(AgentActivityQuery.safeParse({ runs: 0 }).success).toBe(false);
    expect(AgentActivityQuery.safeParse({ runId: 'x'.repeat(65) }).success).toBe(false);
  });
});
