/**
 * Boot the operating company after `wireRuntime`.
 *
 * Creates the company + org actors if none exist, enqueues `loop.tick`, and
 * opens a BAND coordination room when that capability is usable. A missing
 * Band key is recorded as `blockedOn` — dispatch will refuse rather than
 * enqueue a specialist with no room.
 */

import { describeError } from '@foundry/core';
import { companyConfig } from '@foundry/db';
import { BandAdapter } from '@foundry/providers';
import { ensureOperatingCompany, type EnsureOperatingCompanyResult } from '@foundry/services';
import { getLogger } from '@foundry/obs';
import type { AppContext } from './context.js';

export interface BandRoomBootstrap {
  readonly chatId: string | null;
  readonly created: boolean;
  readonly blockedOn: { readonly capability: 'coordination.agent_mesh'; readonly reason: string } | null;
}

export interface BootstrapOperatingCompanyResult extends EnsureOperatingCompanyResult {
  readonly bandRoom: BandRoomBootstrap;
}

export async function bootstrapOperatingCompany(ctx: AppContext): Promise<BootstrapOperatingCompanyResult> {
  const company = await ensureOperatingCompany({ repos: ctx.repos, queues: ctx.queues });
  const bandRoom = await ensureBandCoordinationRoom(ctx, company.companyId);
  getLogger().info(
    {
      companyId: company.companyId,
      created: company.created,
      cycleId: company.cycleId,
      bandChatId: bandRoom.chatId,
      bandBlocked: bandRoom.blockedOn?.reason ?? null,
    },
    'operating company bootstrapped',
  );
  return { ...company, bandRoom };
}

async function ensureBandCoordinationRoom(ctx: AppContext, companyId: string): Promise<BandRoomBootstrap> {
  const status = ctx.capabilities.resolveCapability('coordination.agent_mesh');
  const band = ctx.providers.adapter('band');
  if (!(band instanceof BandAdapter) || !band.isConfigured || !status.usable) {
    return {
      chatId: null,
      created: false,
      blockedOn: {
        capability: 'coordination.agent_mesh',
        reason: status.remediation ?? `coordination.agent_mesh is ${status.state}`,
      },
    };
  }

  try {
    const company = await ctx.repos.companies.byId(companyId);
    const config = companyConfig(company);
    const existing = config.integrations?.bandChatId;
    if (existing) {
      return { chatId: existing, created: false, blockedOn: null };
    }
    const chat = await band.createChat({
      name: `${company.name} coordination`,
      taskId: companyId,
    });
    await ctx.repos.companies.updateConfig(companyId, {
      ...config,
      integrations: { ...config.integrations, bandChatId: chat.id },
    });
    return { chatId: chat.id, created: true, blockedOn: null };
  } catch (error) {
    return {
      chatId: null,
      created: false,
      blockedOn: {
        capability: 'coordination.agent_mesh',
        reason: error instanceof Error ? error.message : String(describeError(error)),
      },
    };
  }
}
