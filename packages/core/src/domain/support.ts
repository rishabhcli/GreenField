/**
 * Customer support domain: tickets, conversations and escalation policy.
 */

import { z } from 'zod';

export const MessageChannel = z.enum(['imessage', 'rcs', 'sms', 'voice', 'email', 'web_form']);
export type MessageChannel = z.infer<typeof MessageChannel>;

export const MessageDirection = z.enum(['inbound', 'outbound']);
export type MessageDirection = z.infer<typeof MessageDirection>;

export const MessageDeliveryStatus = z.enum([
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'blocked_opt_out',
  'rejected',
]);
export type MessageDeliveryStatus = z.infer<typeof MessageDeliveryStatus>;

export const SupportMessage = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  ticketId: z.string().nullable(),
  customerId: z.string().nullable(),
  channel: MessageChannel,
  direction: MessageDirection,
  provider: z.string().min(1),
  /** Provider conversation id, so replies land in the same thread. */
  externalChatId: z.string().nullable(),
  externalMessageId: z.string().nullable(),
  fromHandle: z.string().min(1),
  toHandle: z.string().min(1),
  body: z.string(),
  attachments: z.array(z.object({ url: z.string().url(), mimeType: z.string(), name: z.string().nullable() })).default([]),
  status: MessageDeliveryStatus,
  failureCode: z.string().nullable(),
  failureReason: z.string().nullable(),
  /** Which agent run produced an outbound message, for accountability. */
  authoredByRunId: z.string().nullable(),
  authoredByHuman: z.string().nullable(),
  sentAt: z.string().datetime().nullable(),
  deliveredAt: z.string().datetime().nullable(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type SupportMessage = z.infer<typeof SupportMessage>;

export const TicketIntent = z.enum([
  'order_status',
  'shipping_delay',
  'delivery_issue',
  'product_question',
  'dropship_request',
  'product_defect',
  'return_request',
  'refund_request',
  'cancel_order',
  'address_change',
  'billing_question',
  'chargeback_threat',
  'safety_incident',
  'injury_report',
  'legal_threat',
  'regulator_or_media',
  'suspected_fraud',
  'marketing_opt_out',
  'general_enquiry',
  'spam',
  'unknown',
]);
export type TicketIntent = z.infer<typeof TicketIntent>;

/**
 * Intents that must never be handled autonomously. Matches the sensitive
 * categories in the operating plan; the support agent has no tool that can
 * bypass this list.
 */
export const ALWAYS_ESCALATE_INTENTS: ReadonlySet<TicketIntent> = new Set<TicketIntent>([
  'chargeback_threat',
  'safety_incident',
  'injury_report',
  'legal_threat',
  'regulator_or_media',
  'suspected_fraud',
]);

export const TicketStatus = z.enum([
  'open',
  'awaiting_customer',
  'awaiting_internal',
  'escalated_to_human',
  'resolved',
  'closed',
]);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const TicketPriority = z.enum(['low', 'normal', 'high', 'urgent']);
export type TicketPriority = z.infer<typeof TicketPriority>;

export const Ticket = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  customerId: z.string().nullable(),
  orderId: z.string().nullable(),
  channel: MessageChannel,
  externalChatId: z.string().nullable(),
  subject: z.string().min(1),
  intent: TicketIntent,
  intentConfidence: z.number().min(0).max(1),
  status: TicketStatus,
  priority: TicketPriority,
  escalationReason: z.string().nullable(),
  escalatedAt: z.string().datetime().nullable(),
  assignedRoleKey: z.string().nullable(),
  assignedHuman: z.string().nullable(),
  resolution: z.string().nullable(),
  /** Refund/credit issued while resolving, for cost-to-serve reporting. */
  resolutionCostMinor: z.number().int().nonnegative().default(0),
  currency: z.string().length(3).nullable(),
  firstResponseAt: z.string().datetime().nullable(),
  resolvedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Ticket = z.infer<typeof Ticket>;

export interface EscalationDecision {
  readonly escalate: boolean;
  readonly reason: string | null;
  readonly priority: TicketPriority;
}

export interface EscalationInput {
  readonly intent: TicketIntent;
  readonly intentConfidence: number;
  readonly requestedRefundMinor: number | null;
  readonly agentRefundLimitMinor: number;
  readonly orderFound: boolean;
  readonly customerMessageCount: number;
  /** True when the answer would require asserting something we cannot verify. */
  readonly requiresUnverifiableClaim: boolean;
}

/**
 * The escalation rule. Conservative by design: the cost of escalating an easy
 * ticket is a few minutes of human time; the cost of an agent improvising a
 * refund policy or a safety response is much higher.
 */
export function decideEscalation(input: EscalationInput): EscalationDecision {
  if (ALWAYS_ESCALATE_INTENTS.has(input.intent)) {
    const urgent = input.intent === 'safety_incident' || input.intent === 'injury_report';
    return {
      escalate: true,
      reason: `intent "${input.intent}" is in the always-escalate set`,
      priority: urgent ? 'urgent' : 'high',
    };
  }
  if (input.requiresUnverifiableClaim) {
    return {
      escalate: true,
      reason: 'answering would require asserting something not present in verified order, carrier or policy data',
      priority: 'high',
    };
  }
  if (input.requestedRefundMinor !== null && input.requestedRefundMinor > input.agentRefundLimitMinor) {
    return {
      escalate: true,
      reason: `requested refund ${input.requestedRefundMinor} exceeds the agent limit of ${input.agentRefundLimitMinor}`,
      priority: 'high',
    };
  }
  if (input.intentConfidence < 0.6) {
    return {
      escalate: true,
      reason: `intent classification confidence ${input.intentConfidence.toFixed(2)} is too low to act on`,
      priority: 'normal',
    };
  }
  if (
    !input.orderFound &&
    input.intent !== 'general_enquiry' &&
    input.intent !== 'product_question' &&
    input.intent !== 'dropship_request'
  ) {
    return {
      escalate: true,
      reason: 'no matching order was found for an order-specific request',
      priority: 'normal',
    };
  }
  if (input.customerMessageCount >= 5) {
    return {
      escalate: true,
      reason: 'conversation has run five or more customer messages without resolution',
      priority: 'high',
    };
  }
  return { escalate: false, reason: null, priority: 'normal' };
}

/** Opt-out keywords the messaging provider enforces; we check before sending. */
export const OPT_OUT_KEYWORDS: readonly string[] = ['STOP', 'UNSUBSCRIBE', 'OPTOUT', 'OPT OUT', 'CANCEL', 'END', 'QUIT'];

export function isOptOutMessage(body: string): boolean {
  const normalised = body.trim().toUpperCase().replace(/\s+/g, ' ');
  return OPT_OUT_KEYWORDS.includes(normalised);
}
