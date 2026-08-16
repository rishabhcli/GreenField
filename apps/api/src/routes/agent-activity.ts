/**
 * The agent interaction feed — message-level shaping for the operator console.
 *
 * `/api/agent-runs` answers "which runs exist and what did they cost". This
 * module answers the question an observer actually asks: *what is the company
 * doing right now* — which specialist spoke, which tool it reached for, what
 * came back, and what failed.
 *
 * The functions here are pure and exported so the redaction rules are testable
 * without a database. Three rules are load-bearing:
 *
 *   1. **Never emit a `thinking` signature.** Those blocks are opaque
 *      base64 attestations; they are not readable, they are large, and pasting
 *      one into a browser is how a "live dashboard" becomes a log dump.
 *   2. **Never emit a secret.** Tool inputs are model-authored and a model can
 *      put anything in them. Key-name redaction plus token-shape redaction runs
 *      over every string that leaves this module.
 *   3. **Truncation is announced, not hidden.** A clipped step carries
 *      `truncated: true` so the console can say so rather than implying the
 *      agent said only that much.
 */

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AgentActivityRow } from '@foundry/db';
import type { AppContext } from '@foundry/runtime';
import { requireOperator } from '../auth.js';

/** Per-step character budget. Long enough to read, short enough to scan. */
const MAX_TEXT = 420;
/** Per-value budget inside a summarised tool input. */
const MAX_VALUE = 90;

export const AgentActivityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(60),
  runs: z.coerce.number().int().min(1).max(25).default(6),
  runId: z.string().min(1).max(64).optional(),
});

export type AgentStepKind =
  | 'system'
  | 'prompt'
  | 'thinking'
  | 'assistant_text'
  | 'tool_call'
  | 'tool_result'
  | 'tool_error';

export interface AgentStep {
  id: string;
  /** The stored row this step came from. Several steps share one. */
  messageId: string;
  runId: string;
  sequence: number;
  kind: AgentStepKind;
  roleKey: string;
  runStatus: string;
  model: string;
  objective: string;
  toolName: string | null;
  toolUseId: string | null;
  /** Redacted and truncated. `null` for markers that deliberately carry no body. */
  text: string | null;
  /** A short factual annotation, e.g. how much content was withheld. */
  note: string | null;
  truncated: boolean;
  occurredAt: string;
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Ordered because the specific patterns must win: a `data:` URI would otherwise
 * be swallowed by the generic base64 run and lose the fact that it was binary.
 */
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[binary omitted]'],
  [/\b(?:sk|rk|pk|whsec|xoxb|xoxp|ghp|gho|glpat)[-_][A-Za-z0-9_-]{6,}/g, '[redacted secret]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, '[redacted token]'],
  // A long unbroken run of base64 alphabet. Ordinary prose has spaces; a
  // thinking signature, a PEM body and an inlined image do not.
  [/[A-Za-z0-9+/]{100,}={0,2}/g, '[binary omitted]'],
];

/** Field names whose value is never shown, whatever the value looks like. */
const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|apikey|credential|authorization|signature|private[_-]?key)/i;

export function redactText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, ' ').trim();
}

function clip(value: string, max = MAX_TEXT): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: `${value.slice(0, max)}…`, truncated: true };
}

/** Best-effort plain text out of whatever shape a content field holds. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
    return (value as { text: string }).text;
  }
  return JSON.stringify(value);
}

/**
 * A one-line, redacted rendering of a tool call's arguments.
 *
 * The arguments are the most interesting part of the feed — "searched for
 * *freelancer invoicing complaints*" is the observable act — so they are shown,
 * but a model-authored object is untrusted input and is flattened key by key.
 */
export function summariseToolInput(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    return clip(redactText(asText(input))).text || null;
  }
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      parts.push(`${key}=[redacted]`);
      continue;
    }
    const rendered = typeof raw === 'string' ? raw : JSON.stringify(raw) ?? String(raw);
    parts.push(`${key}=${clip(redactText(rendered), MAX_VALUE).text}`);
  }
  const joined = parts.join(' · ');
  return joined ? clip(joined).text : null;
}

function step(
  row: AgentActivityRow,
  suffix: string,
  kind: AgentStepKind,
  body: { text?: string | null; note?: string | null; toolName?: string | null; toolUseId?: string | null },
): AgentStep {
  const raw = body.text ?? null;
  const clipped = raw === null ? null : clip(redactText(raw));
  return {
    id: `${row.id}#${suffix}`,
    messageId: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    kind,
    roleKey: row.role_key,
    runStatus: row.run_status,
    model: row.model,
    objective: row.objective,
    toolName: body.toolName ?? row.tool_name ?? null,
    toolUseId: body.toolUseId ?? row.tool_use_id ?? null,
    text: clipped === null ? null : clipped.text || null,
    note: body.note ?? null,
    truncated: clipped?.truncated ?? false,
    occurredAt: row.created_at.toISOString(),
  };
}

/**
 * Expands one stored message into the steps an observer should see.
 *
 * An assistant turn holds several blocks — prose, thinking, and one or more
 * tool calls — and collapsing them into a single row is what makes existing
 * agent dashboards unreadable. Each block becomes its own step.
 */
export function toSteps(row: AgentActivityRow): AgentStep[] {
  const content = row.content;

  if (row.role === 'system') {
    // The system prompt is the role definition, not an interaction, and it is
    // long. Its presence is reported; its body is not rendered.
    const chars = asText(content).length;
    return [step(row, 'sys', 'system', { text: null, note: `role briefing · ${chars} characters` })];
  }

  if (row.role === 'user') {
    return [step(row, 'usr', 'prompt', { text: asText(content) })];
  }

  if (row.role === 'tool_result') {
    const holder = (content ?? {}) as { content?: unknown; toolUseId?: string };
    const text = asText(holder.content ?? content);
    return [
      step(row, 'res', row.is_error ? 'tool_error' : 'tool_result', {
        text,
        ...(typeof holder.toolUseId === 'string' ? { toolUseId: holder.toolUseId } : {}),
      }),
    ];
  }

  // assistant
  const blocks = Array.isArray(content) ? content : [content];
  const steps: AgentStep[] = [];
  blocks.forEach((block, i) => {
    if (typeof block === 'string') {
      steps.push(step(row, `a${i}`, 'assistant_text', { text: block }));
      return;
    }
    if (!block || typeof block !== 'object') return;
    const b = block as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; id?: unknown; input?: unknown };

    if (b.type === 'text') {
      steps.push(step(row, `a${i}`, 'assistant_text', { text: asText(b.text) }));
      return;
    }
    if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      // `signature` is never read. The thinking body is prose and is shown;
      // the attestation blob beside it is not.
      const thought = typeof b.thinking === 'string' ? b.thinking : '';
      steps.push(
        step(row, `a${i}`, 'thinking', {
          text: thought.trim() ? thought : null,
          note: thought.trim() ? null : 'extended thinking · not disclosed by the model',
        }),
      );
      return;
    }
    if (b.type === 'tool_use') {
      steps.push(
        step(row, `a${i}`, 'tool_call', {
          text: summariseToolInput(b.input),
          toolName: typeof b.name === 'string' ? b.name : null,
          toolUseId: typeof b.id === 'string' ? b.id : null,
        }),
      );
      return;
    }
    steps.push(step(row, `a${i}`, 'assistant_text', { text: asText(b.text ?? block) }));
  });
  return steps;
}

/**
 * Flattens rows into steps and names each tool result after the call it answers.
 *
 * `agent_messages.tool_name` is nullable and in practice unset for results —
 * the name only exists on the `tool_use` block. Pairing by `tool_use_id`
 * inside the page turns "tool result" into "research_run_collection returned".
 *
 * Ordering is deliberate and mixed: **messages descend** (newest turn at the
 * top, which is what a panel that refreshes under your eyes needs) while
 * **blocks inside one message ascend** (thinking → prose → the tool calls it
 * decided on). Reversing the blocks too would show an agent reaching for a
 * tool before the sentence that explains why.
 */
export function buildFeed(rows: readonly AgentActivityRow[]): AgentStep[] {
  const steps = rows.flatMap(toSteps);
  const nameByUseId = new Map<string, string>();
  for (const s of steps) {
    if (s.kind === 'tool_call' && s.toolUseId && s.toolName) nameByUseId.set(s.toolUseId, s.toolName);
  }
  for (const s of steps) {
    if (s.toolName === null && s.toolUseId) s.toolName = nameByUseId.get(s.toolUseId) ?? null;
  }
  return steps;
}

/* -------------------------------------------------------------------------- */
/* Route                                                                       */
/* -------------------------------------------------------------------------- */

export async function registerAgentActivityRoute(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Querystring: { limit?: string; runs?: string; runId?: string } }>(
    '/api/agent-activity',
    async (request) => {
      await requireOperator(request as never, ctx.config.operatorApiToken);
      const query = AgentActivityQuery.parse(request.query);
      const companyRow = await ctx.repos.companies.first();
      if (!companyRow) return { configured: false, steps: [], runs: [] };

      const rows = await ctx.repos.agents.messages.recentForCompany(companyRow.id, {
        limit: query.limit,
        runLimit: query.runs,
        ...(query.runId ? { runId: query.runId } : {}),
      });

      const steps = buildFeed(rows);
      const runs = new Map<string, { id: string; roleKey: string; status: string; objective: string; model: string }>();
      for (const row of rows) {
        if (!runs.has(row.run_id)) {
          runs.set(row.run_id, {
            id: row.run_id,
            roleKey: row.role_key,
            status: row.run_status,
            objective: row.objective,
            model: row.model,
          });
        }
      }

      return {
        configured: true,
        /**
         * `limit` bounds stored messages; `steps` are the blocks they expand
         * into, so one is not a ceiling on the other. Both are echoed because
         * "144 steps" with no context reads like the whole history, and
         * `messagesRead === limit` is the only honest signal that the window
         * is full and older activity exists above it.
         */
        limit: query.limit,
        messagesRead: rows.length,
        steps,
        runs: [...runs.values()],
      };
    },
  );
}
