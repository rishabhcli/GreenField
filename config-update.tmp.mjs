// Ephemeral: add our own Linq line as a consented outreach handle.
import { buildContext } from './packages/runtime/dist/index.js';

const ctx = await buildContext({ serviceName: 'config-driver', expectedMigrations: 6, installSchedules: false });
try {
  const row = await ctx.repos.companies.first();
  if (!row) throw new Error('no company');
  const config = structuredClone(row.config);
  const handle = process.env.LINQ_FROM_NUMBER;
  if (!handle) throw new Error('LINQ_FROM_NUMBER unset');
  const existing = new Set(config.messaging.outreachHandles ?? []);
  existing.add(handle);
  config.messaging.outreachHandles = [...existing];
  const updated = await ctx.repos.companies.updateConfig(row.id, config);
  console.log('outreachHandles now:', JSON.stringify(updated.config.messaging.outreachHandles));
} finally {
  await ctx.shutdown();
}
