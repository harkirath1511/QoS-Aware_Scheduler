import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { capacityDriver } from '../src/cloud';
import { controllerTick } from '../src/controller';
import { db } from '../src/db';
import { telemetryPublisher } from '../src/telemetry';

if (existsSync('.env')) loadEnvFile('.env');

async function main() {
  const controller = capacityDriver();
  const publish = telemetryPublisher();
  const shutdown = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown.abort());
  const loop = async (name: string, tick: () => Promise<void>, interval: number) => {
    while (!shutdown.signal.aborted) {
      try { await tick(); }
      catch (error) {
        console.error(JSON.stringify({ kind: name, name: (error as Error)?.name, code: (error as { code?: string })?.code }));
      }
      await sleep(interval, undefined, { signal: shutdown.signal }).catch(() => undefined);
    }
  };
  console.log('Scheduler ready.');
  await Promise.all([
    loop('scheduler_tick_failed', () => controllerTick(async () => {
      try { return await controller.observe(); }
      catch (error) {
        console.error(JSON.stringify({ kind: 'ec2_observation_failed', name: (error as Error)?.name }));
        return { state: 'unknown' };
      }
    }, controller.act), 1000),
    publish && loop('telemetry_failed', publish, 5000),
  ]);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db().end());
