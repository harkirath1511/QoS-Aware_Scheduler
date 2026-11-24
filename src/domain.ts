import { createHash } from 'node:crypto';
import { z } from 'zod';

export const policies = ['fcfs', 'priority', 'qos'] as const;
export type Policy = typeof policies[number];
export type Target = 'local' | 'ec2';
export const priorities = ['low', 'normal', 'high'] as const;
export type Priority = typeof priorities[number];
export type JobState = 'AWAITING_INPUT' | 'QUEUED' | 'ASSIGNED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export const limits = {
  bytes: 2 * 1024 * 1024, samples: 250_000, lags: 2048, jobs: 100,
  uploadMs: 600_000, waitingMs: 900_000, executionMs: 180_000,
  heartbeatMs: 5_000, leaseMs: 20_000, ageMs: 120_000,
  startupMs: 90_000, idleMs: 60_000, stopGraceMs: 20_000, cooldownMs: 120_000,
};

export const checksum = z.string().regex(/^[a-f0-9]{64}$/);
export const jobInput = z.strictObject({
  type: z.literal('vibration-v1'),
  sampleRate: z.number().positive().max(10_000_000),
  minLag: z.number().int().min(1).max(limits.samples - 1),
  maxLag: z.number().int().min(1).max(limits.samples - 1),
  priority: z.enum(priorities),
  expectedSeconds: z.number().min(1).max(180),
  deadline: z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  budgetUsd: z.string().regex(/^\d{1,4}(?:\.\d{1,6})?$/),
  inputSha256: checksum,
  runId: z.uuid().optional(),
}).refine(job => job.maxLag >= job.minLag && job.maxLag - job.minLag < limits.lags, {
  message: 'Choose an increasing lag range with at most 2,048 values.',
  path: ['maxLag'],
});
export type JobInput = z.infer<typeof jobInput>;

export function micros(usd: string) {
  const [units, fraction = ''] = usd.split('.');
  return Number(units) * 1_000_000 + Number(fraction.padEnd(6, '0'));
}

export function sha256(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

export class Fault extends Error {
  constructor(public status: number, message: string) { super(message); }
}
