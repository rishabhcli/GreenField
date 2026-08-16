import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const show = async (label, sql) => {
  console.log(`\n---- ${label} ----`);
  try {
    const r = await c.query(sql);
    for (const row of r.rows) console.log(JSON.stringify(row));
  } catch (e) { console.log('ERR', e.message); }
};
await show('companies', `select id, name, status, created_at from companies`);
await show('loop_cycles', `select * from loop_cycles order by created_at desc limit 3`);
await show('agent_runs cols', `select column_name, data_type from information_schema.columns where table_name='agent_runs' order by ordinal_position`);
await show('agent_runs', `select id, role_key, status, started_at, finished_at, substring(coalesce(error,'') for 300) as err from agent_runs order by started_at desc limit 15`);
await show('audience_segments cols', `select column_name, data_type, is_nullable from information_schema.columns where table_name='audience_segments' order by ordinal_position`);
await show('pain_points', `select * from pain_points limit 5`);
await show('products', `select id, name, status, created_at from products limit 10`);
await show('integration_verifications latest', `select provider_key, status, checked_at, substring(coalesce(detail,'') for 120) d from (select distinct on (provider_key) * from integration_verifications order by provider_key, checked_at desc) x order by status, provider_key`);
await c.end();
