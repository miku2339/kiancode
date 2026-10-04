import { PostgresStore } from '../../src/storage/postgres.js';

const store = await PostgresStore.connect(process.env.KIANCODE_FIXTURE_DATABASE_URL!, {
  schema: process.env.KIANCODE_FIXTURE_SCHEMA!,
});
await store.scan('health');
process.send?.({ type: 'idle' });

process.on('message', async (message) => {
  if (message !== 'recover') return;
  try {
    await store.create('probe', 'idle-recovery-owner', { recovered: true }, 'recovery');
    const row = await store.get<{ recovered: boolean }>('probe', 'recovery', 'idle-recovery-owner');
    await store.close();
    process.send?.({ type: 'recovered', recovered: row?.data.recovered === true });
    process.disconnect();
  } catch {
    await store.close();
    process.send?.({ type: 'failed' });
    process.disconnect();
    process.exitCode = 1;
  }
});
