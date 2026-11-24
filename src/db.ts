import { Pool, types, type PoolClient } from 'pg';
import type { RunConfig } from './config';
import type { JobInput, JobState, Policy, Target } from './domain';

// Timestamps and budgets are bounded well below JavaScript's safe integer limit.
types.setTypeParser(20, Number);
let instance: Pool | undefined;
export function db() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL.');
  return instance ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    // Serialize short scheduling writes across API and controller processes.
    await client.query('SELECT pg_advisory_xact_lock(531, 1)');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface Decision {
  policy: Policy;
  rank: number;
  localFinish: number | null;
  cloudFinish: number | null;
  selected: Target | null;
  reason: string;
  cloudBlock: string | null;
  deadlineRisk: boolean;
  jobRemainingMicros: number;
  runRemainingMicros: number;
  cloudExpectedMicros: number;
  cloudReservationMicros: number;
  localServiceMs: number;
  cloudServiceMs: number;
  localAvailableAt: number | null;
  cloudAvailableAt: number | null;
}

export interface Job {
  id: string;
  run_id: string;
  owner: string;
  spec: JobInput;
  budget_micros: number;
  spent_micros: number;
  reserved_micros: number;
  status: JobState;
  input_bytes: number | null;
  created_at: number;
  queued_at: number | null;
  assigned_at: number | null;
  first_started_at: number | null;
  terminal_at: number | null;
  assigned_worker: string | null;
  target: Target | null;
  active_attempt_id: string | null;
  winning_attempt_id: string | null;
  failure: string | null;
  decision: Decision | null;
}

export interface Worker {
  id: string;
  generation: string;
  target: Target;
  seen_at: number;
  instance_id: string | null;
  image_digest: string | null;
  busy_attempt: string | null;
}

export interface Attempt {
  id: string;
  job_id: string;
  number: number;
  target: Target;
  worker_id: string;
  worker_generation: string;
  instance_id: string | null;
  image_digest: string | null;
  started_at: number;
  lease_until: number;
  ended_at: number | null;
  outcome: 'succeeded' | 'failed' | null;
  failure: string | null;
  output_sha256: string | null;
}

export interface Run {
  id: string;
  label: string;
  policy: Policy;
  config: RunConfig;
  manifest: unknown;
  created_at: number;
  ended_at: number | null;
}

export interface CapacitySession {
  id: string;
  run_id: string;
  instance_id: string;
  startup_job_id: string;
  rate_micros: number;
  requested_at: number;
  running_at: number | null;
  ready_at: number | null;
  idle_at: number | null;
  stop_requested_at: number | null;
  running_ended_at: number | null;
  stopped_at: number | null;
  fault: string | null;
}

export async function event(client: PoolClient, jobId: string, at: number, kind: string, details: object = {}) {
  await client.query('INSERT INTO events (job_id, at, kind, details) VALUES ($1, $2, $3, $4)', [jobId, at, kind, details]);
}

export async function telemetry(client: PoolClient, at: number, payload: object) {
  await client.query('INSERT INTO telemetry (created_at, payload) VALUES ($1, $2)', [at, payload]);
}
