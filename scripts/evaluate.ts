import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { policies, sha256, type JobInput, type Policy, type Priority } from '../src/domain';
import type { Job, Run } from '../src/db';
import type { getRunMetrics } from '../src/metrics';

type Metrics = Awaited<ReturnType<typeof getRunMetrics>>;
type Workload = 'normal' | 'burst';
const settings = z.object({
  EVALUATION_API: z.url().default('http://localhost:3000'),
  EVALUATION_TOKEN: z.string().min(24),
  EVALUATION_REPEAT: z.coerce.number().int().min(1).max(20).default(3),
  EVALUATION_LONG_S: z.coerce.number().positive().max(150).default(30),
  EVALUATION_SHORT_S: z.coerce.number().positive().max(150).default(8),
  EVALUATION_STARTUP_S: z.coerce.number().positive().max(90).default(45),
  EVALUATION_JOB_BUDGET: z.string().default('0.030'),
  EVALUATION_MODE: z.enum(['full', 'smoke']).default('full'),
}).parse(process.env);

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, settings.EVALUATION_API), {
    ...options, signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${settings.EVALUATION_TOKEN}`, ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`${path}: ${body.error ?? response.status}`);
  }
  return response.status === 204 ? undefined as T : response.json();
}

const post = <T>(path: string, body: object, headers?: Record<string, string>) => api<T>(path, {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers },
});

function fixture(sampleCount: number, seed: number) {
  let cursor = seed;
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    cursor = (Math.imul(1664525, cursor) + 1013904223) >>> 0;
    return Math.round(7000 * Math.sin(2 * Math.PI * index / 25) + (cursor % 300) - 150);
  });
  const bytes = Buffer.from(samples.join('\n') + '\n');
  return { bytes, checksum: sha256(bytes), seed };
}

interface Entry {
  id: string;
  atSeconds: number;
  deadlineSeconds: number;
  priority: Priority;
  expectedSeconds: number;
  budgetUsd: string;
  maxLag: number;
  input: ReturnType<typeof fixture>;
}

function manifest(workload: Workload): Entry[] {
  const smoke = settings.EVALUATION_MODE === 'smoke';
  const long = smoke ? 1 : settings.EVALUATION_LONG_S;
  const short = smoke ? 1 : settings.EVALUATION_SHORT_S;
  const startup = smoke ? 1 : settings.EVALUATION_STARTUP_S;
  const heavy = fixture(smoke ? 400 : 245_000, 531);
  const lighter = fixture(smoke ? 200 : 245_000, 532);
  function entry(id: string, atSeconds: number, deadlineSeconds: number, priority: Priority, expectedSeconds: number, budgetUsd: string, bulk: boolean): Entry {
    return {
      id, atSeconds, deadlineSeconds, priority, expectedSeconds, budgetUsd,
      maxLag: smoke ? 12 : bulk ? 2048 : 512, input: bulk ? heavy : lighter,
    };
  }
  const budget = settings.EVALUATION_JOB_BUDGET;
  if (workload === 'normal') {
    return Array.from({ length: smoke ? 3 : 12 }, (_, index) =>
      entry(`routine-${index + 1}`, index * (smoke ? 0.3 : Math.max(45, long + 5)), long + 45, 'normal', long, budget, true));
  }
  return [
    entry('already-running-1', 0, long * 5, 'normal', long, '0', true),
    entry('already-running-2', 0, long * 5, 'normal', long, '0', true),
    ...Array.from({ length: smoke ? 2 : 8 }, (_, index) =>
      entry(`backlog-${index + 1}`, smoke ? 0.4 : 2, long * 5, index < 6 ? 'high' : 'normal', long, budget, true)),
    entry('deadline-rescue', smoke ? 0.4 : 8, startup + Math.max(10, short), 'high', short, budget, false),
    entry('zero-budget', smoke ? 0.4 : 8, startup + Math.max(11, short), 'high', short, '0', false),
    entry('already-at-risk', smoke ? 0.4 : 8, smoke ? 1.5 : 3, 'high', long, budget, true),
  ];
}

async function runTrace(workload: Workload, policy: Policy, repeat: number, entries: Entry[]) {
  const label = `${workload} / ${policy} / ${repeat + 1}`;
  const run = await post<Run>('/api/runs', {
    label, policy, manifest: { workload, repeat: repeat + 1, mode: settings.EVALUATION_MODE,
      entries: entries.map(({ input, ...item }) => ({ ...item, seed: input.seed, inputSha256: input.checksum })) },
  });
  const begin = Date.now() + 500;
  const submitted = await Promise.all(entries.map(async entry => {
    const arrival = begin + entry.atSeconds * 1000;
    await sleep(Math.max(0, arrival - Date.now()));
    const spec: JobInput = {
      type: 'vibration-v1', runId: run.id, inputSha256: entry.input.checksum, priority: entry.priority,
      expectedSeconds: entry.expectedSeconds, budgetUsd: entry.budgetUsd,
      deadline: new Date(arrival + entry.deadlineSeconds * 1000).toISOString(),
      minLag: 1, maxLag: entry.maxLag, sampleRate: 1000,
    };
    const job = await post<Job>('/api/jobs', spec, { 'Idempotency-Key': randomUUID() });
    const queued = await api<Job>(`/api/jobs/${job.id}/input`, {
      method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: new Uint8Array(entry.input.bytes),
    });
    return { fixture: entry.id, jobId: job.id, plannedAt: arrival, admittedAt: queued.queued_at };
  }));
  const until = Date.now() + 25 * 60_000;
  while (Date.now() < until) {
    const metrics = await api<Metrics>(`/api/runs/${run.id}/metrics`);
    if (!metrics.counts.active && !metrics.cloud.active) {
      await post('/api/runs/finish', { id: run.id });
      const complete = await api<Metrics>(`/api/runs/${run.id}/metrics`);
      console.log(`${label}: ${complete.deadlines.hits}/${complete.deadlines.denominator} on time, ${complete.cloud.successes} EC2 results`);
      return { workload, policy, repeat, submitted, metrics: complete };
    }
    await sleep(1000);
  }
  throw new Error(`Evaluation ${run.id} did not reach a terminal state.`);
}

async function main() {
  const folder = join('evaluation-output', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(folder, { recursive: true });
  const results: Awaited<ReturnType<typeof runTrace>>[] = [];
  for (const workload of ['normal', 'burst'] as const) {
    const entries = manifest(workload);
    const repeats = settings.EVALUATION_MODE === 'smoke' ? 1 : settings.EVALUATION_REPEAT;
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (let turn = 0; turn < policies.length; turn++) {
        const policy = policies[(repeat + turn) % policies.length];
        const result = await runTrace(workload, policy, repeat, entries);
        results.push(result);
        await writeFile(join(folder, `${workload}-${repeat + 1}-${policy}.json`), JSON.stringify(result, null, 2));
      }
    }
  }
  const comparison = results.filter(result => result.policy === 'qos').map(qos => ({
    workload: qos.workload, repeat: qos.repeat + 1,
    baselines: results.filter(row => row.workload === qos.workload && row.repeat === qos.repeat && row.policy !== 'qos').map(base => {
      const additionalHits = qos.metrics.deadlines.hits - base.metrics.deadlines.hits;
      const additionalComputeUsd = (qos.metrics.cloud.computeMicros - base.metrics.cloud.computeMicros) / 1_000_000;
      return { policy: base.policy, additionalHits, additionalComputeUsd,
        costPerAdditionalHit: additionalHits > 0 ? additionalComputeUsd / additionalHits : null };
    }),
  }));
  await writeFile(join(folder, 'comparison.json'), JSON.stringify(comparison, null, 2));
  console.log(`Saved run evidence in ${folder}.`);
}

main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
