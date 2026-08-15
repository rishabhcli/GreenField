// Ephemeral loop-tick driver: builds the runtime against hosted infra and ticks once.
import { buildContext, wireRuntime, bootstrapOperatingCompany } from './packages/runtime/dist/index.js';

const ctx = await buildContext({ serviceName: 'tick-driver', expectedMigrations: 6, installSchedules: false });
try {
  const services = wireRuntime(ctx);
  const boot = await bootstrapOperatingCompany(ctx);
  console.log('company:', boot.companyId);
  const n = Number(process.env.TICKS ?? 1);
  for (let i = 0; i < n; i++) {
    const tick = await services.loop.tick(boot.companyId);
    console.log(`tick ${i + 1}:`, JSON.stringify(tick));
  }
} finally {
  await ctx.shutdown();
}
