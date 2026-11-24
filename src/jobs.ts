import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { config, runConfig } from './config';
import { db, event, telemetry, transaction, type Attempt, type Job, type Run, type Worker } from './db';
import { Fault, limits, micros, sha256, type JobInput, type Policy, type Target } from './domain';
import { computeCost } from './policy';

export async function activeRun(client: PoolClient, now: number) {
  const { rows: [run] } = await client.query<Run>('SELECT * FROM runs WHERE ended_at IS NULL');
  if (run) return run;
  const { rows } = await client.query<Run>(
    'INSERT INTO runs (id,label,policy,config,created_at) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [randomUUID(), 'Dashboard jobs', config().POLICY, runConfig(), now],
  );
  return rows[0];
}

export async function startRun(label: string, policy: Policy, manifest: object) {
  return transaction(async client => {
    const now = Date.now();
    const settings = runConfig();
    const { rows: [busy] } = await client.query(
      `SELECT EXISTS(SELECT 1 FROM jobs WHERE status NOT IN ('SUCCEEDED','FAILED'))
       OR EXISTS(SELECT 1 FROM capacity_sessions WHERE stopped_at IS NULL) AS busy`,
    );
    if (busy.busy) throw new Fault(409, 'Wait until all jobs finish and EC2 stops.');
    const { rows: [local] } = await client.query(
      `SELECT count(*) FROM workers WHERE target='local' AND seen_at > $1`, [now - limits.leaseMs],
    );
    if (local.count !== 2) throw new Fault(409, 'Wait for both local workers to become healthy.');
    if (settings.instanceId) {
      const { rowCount } = await client.query(
        `SELECT singleton FROM controller_state WHERE cloud_state='stopped' AND observed_at > $1`, [now - limits.leaseMs],
      );
      if (!rowCount) throw new Fault(409, 'Wait for the controller to confirm EC2 is stopped.');
    }
    await client.query('UPDATE runs SET ended_at=$1 WHERE ended_at IS NULL', [now]);
    const { rows } = await client.query<Run>(
      'INSERT INTO runs (id,label,policy,config,manifest,created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [randomUUID(), label, policy, settings, manifest, now],
    );
    return rows[0];
  });
}

export async function endRun(id: string) {
  return transaction(async client => {
    const { rows: [run] } = await client.query<Run>('SELECT * FROM runs WHERE id=$1', [id]);
    if (!run) throw new Fault(404, 'Run not found.');
    if (run.ended_at !== null) return;
    const { rows: [busy] } = await client.query(
      `SELECT EXISTS(SELECT 1 FROM jobs WHERE run_id=$1 AND status NOT IN ('SUCCEEDED','FAILED'))
       OR EXISTS(SELECT 1 FROM capacity_sessions WHERE run_id=$1 AND stopped_at IS NULL) AS busy`, [id],
    );
    if (busy.busy) throw new Fault(409, 'Wait until all jobs finish and EC2 stops.');
    await client.query('UPDATE runs SET ended_at=$2 WHERE id=$1', [id, Date.now()]);
  });
}

export async function submit(owner: string, key: string, spec: JobInput) {
  return transaction(async client => {
    const hash = sha256(JSON.stringify(spec));
    const { rows: [previous] } = await client.query<Job & { request_hash: string }>(
      'SELECT * FROM jobs WHERE owner = $1 AND idempotency_key = $2', [owner, key],
    );
    if (previous) {
      if (previous.request_hash !== hash) throw new Fault(409, 'The idempotency key belongs to a different submission.');
      return { job: previous, created: false };
    }
    const now = Date.now();
    if (Date.parse(spec.deadline) <= now) throw new Fault(422, 'Deadline must be in the future.');
    const run = await activeRun(client, now);
    if (spec.runId !== undefined && spec.runId !== run.id) throw new Fault(409, 'This evaluation run is no longer active.');
    if (run.manifest && spec.runId !== run.id) throw new Fault(409, 'An evaluation run is in progress.');
    const { rows: [{ count }] } = await client.query(
      `SELECT count(*) FROM jobs WHERE status NOT IN ('SUCCEEDED','FAILED')`,
    );
    if (count >= limits.jobs) throw new Fault(429, 'The queue is full. Try again later.');
    const { rows: [job] } = await client.query<Job>(
      `INSERT INTO jobs (id,run_id,owner,idempotency_key,request_hash,spec,budget_micros,status,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'AWAITING_INPUT',$8) RETURNING *`,
      [randomUUID(), run.id, owner, key, hash, spec, micros(spec.budgetUsd), now],
    );
    await event(client, job.id, now, 'submitted');
    return { job, created: true };
  });
}

export async function ownedJob(id: string, owner: string) {
  const { rows: [job] } = await db().query<Job>('SELECT * FROM jobs WHERE id=$1 AND owner=$2', [id, owner]);
  if (!job) throw new Fault(404, 'Job not found.');
  return job;
}

export async function admit(id: string, owner: string, bytes: number) {
  return transaction(async client => {
    const now = Date.now();
    const { rows: [job] } = await client.query<Job>('SELECT * FROM jobs WHERE id=$1 AND owner=$2', [id, owner]);
    if (!job) throw new Fault(404, 'Job not found.');
    if (job.queued_at !== null) return job;
    if (job.status !== 'AWAITING_INPUT' || now - job.created_at >= limits.uploadMs) {
      throw new Fault(410, 'The input upload window expired. Submit a new job.');
    }
    const { rows } = await client.query<Job>(
      `UPDATE jobs SET status='QUEUED', queued_at=$2, input_bytes=$3 WHERE id=$1 RETURNING *`,
      [id, now, bytes],
    );
    await event(client, id, now, 'queued', { inputBytes: bytes });
    return rows[0];
  });
}

export interface WorkerIdentity {
  id: string;
  target: Target;
  generation: string;
  instanceId?: string;
  imageDigest?: string;
}

export async function register(worker: WorkerIdentity) {
  return transaction(async client => {
    const now = Date.now();
    const { rows: [previous] } = await client.query<Worker>('SELECT * FROM workers WHERE id=$1', [worker.id]);
    if (previous && previous.generation !== worker.generation && now - previous.seen_at < limits.leaseMs) {
      throw new Fault(409, 'A different agent still owns this slot.');
    }
    await client.query(
      `INSERT INTO workers (id,target,generation,instance_id,image_digest,seen_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET generation=$3,
       instance_id=$4, image_digest=$5, seen_at=$6`,
      [worker.id, worker.target, worker.generation, worker.instanceId ?? null, worker.imageDigest ?? null, now],
    );
  });
}

async function touch(client: PoolClient, id: string, generation: string, now: number) {
  const { rows: [worker] } = await client.query<Worker>(
    'UPDATE workers SET seen_at=$3 WHERE id=$1 AND generation=$2 RETURNING *', [id, generation, now],
  );
  if (!worker) throw new Fault(409, 'Register this worker before claiming jobs.');
  return worker;
}

export async function claim(id: string, generation: string) {
  return transaction(async client => {
    const now = Date.now();
    const worker = await touch(client, id, generation, now);
    if (worker.busy_attempt) {
      const { rows: [attempt] } = await client.query<Attempt>('SELECT * FROM attempts WHERE id=$1', [worker.busy_attempt]);
      if (!attempt || attempt.worker_generation !== generation || attempt.lease_until <= now) return null;
      const { rows: [job] } = await client.query<Job>('SELECT * FROM jobs WHERE id=$1', [attempt.job_id]);
      return { job, attempt };
    }
    if (worker.target === 'ec2') {
      const { rowCount } = await client.query(
        'SELECT id FROM capacity_sessions WHERE ready_at IS NOT NULL AND stop_requested_at IS NULL AND stopped_at IS NULL',
      );
      if (!rowCount) return null;
    }
    const { rows: [job] } = await client.query<Job>(
      `SELECT * FROM jobs WHERE assigned_worker=$1 AND status='ASSIGNED'`, [id],
    );
    if (!job) return null;
    const { rows: [attempt] } = await client.query<Attempt>(
      `INSERT INTO attempts (id,job_id,number,target,worker_id,worker_generation,instance_id,image_digest,started_at,lease_until)
       SELECT $1,$2,count(*)+1,$3,$4,$5,$6,$7,$8,$9 FROM attempts WHERE job_id=$2 RETURNING *`,
      [randomUUID(), job.id, worker.target, id, generation, worker.instance_id, worker.image_digest, now, now + limits.leaseMs],
    );
    await client.query(
      `UPDATE jobs SET status='RUNNING', active_attempt_id=$2, first_started_at=COALESCE(first_started_at,$3) WHERE id=$1`,
      [job.id, attempt.id, now],
    );
    await client.query('UPDATE workers SET busy_attempt=$2 WHERE id=$1', [id, attempt.id]);
    await event(client, job.id, now, 'claimed', { attemptId: attempt.id, workerId: id, target: worker.target, instanceId: worker.instance_id });
    return { job, attempt };
  });
}

export async function currentAttempt(
  client: PoolClient, workerId: string, generation: string, attemptId: string, now: number, allowSucceeded = false,
) {
  const { rows: [attempt] } = await client.query<Attempt>(
    'SELECT * FROM attempts WHERE id=$1 AND worker_id=$2 AND worker_generation=$3',
    [attemptId, workerId, generation],
  );
  if (!attempt || (attempt.outcome !== null && !(allowSucceeded && attempt.outcome === 'succeeded'))) {
    throw new Fault(409, 'This attempt no longer owns the lease.');
  }
  const { rows: [job] } = await client.query<Job>('SELECT * FROM jobs WHERE id=$1', [attempt.job_id]);
  if (allowSucceeded && job.winning_attempt_id === attemptId) return { attempt, job };
  if (job.active_attempt_id !== attemptId || attempt.lease_until <= now || attempt.started_at + limits.executionMs <= now) {
    throw new Fault(409, 'This attempt no longer owns the lease.');
  }
  const { rowCount } = await client.query('SELECT id FROM workers WHERE id=$1 AND generation=$2', [workerId, generation]);
  if (!rowCount) throw new Fault(409, 'This worker generation was replaced.');
  return { attempt, job };
}

export async function heartbeat(workerId: string, generation: string, attemptId: string) {
  return transaction(async client => {
    const now = Date.now();
    const { attempt } = await currentAttempt(client, workerId, generation, attemptId, now);
    const until = Math.min(now + limits.leaseMs, attempt.started_at + limits.executionMs);
    await touch(client, workerId, generation, now);
    await client.query('UPDATE attempts SET lease_until=$2 WHERE id=$1', [attemptId, until]);
    return until;
  });
}

export async function finishAttempt(
  client: PoolClient, job: Job, attempt: Attempt, now: number,
  outcome: { checksum: string } | { failure: string; transient: boolean },
) {
  const success = 'checksum' in outcome;
  const failure = success ? null : outcome.failure;
  const retry = !success && outcome.transient && attempt.number < 2 && now - job.queued_at! < limits.waitingMs;
  const status = success ? 'SUCCEEDED' : retry ? 'QUEUED' : 'FAILED';
  const endedAt = Math.min(now, attempt.started_at + limits.executionMs);
  const { rows: [run] } = await client.query<Run>('SELECT * FROM runs WHERE id=$1', [job.run_id]);
  const spend = attempt.target === 'ec2' ? computeCost(run.config.rateMicrosPerHour, endedAt - attempt.started_at) : 0;
  await client.query(
    'UPDATE attempts SET ended_at=$2,outcome=$3,failure=$4,output_sha256=$5 WHERE id=$1',
    [attempt.id, endedAt, success ? 'succeeded' : 'failed', failure, success ? outcome.checksum : null],
  );
  await client.query(
    `UPDATE jobs SET status=$2, active_attempt_id=NULL, winning_attempt_id=$3, terminal_at=$4,
     failure=$5, assigned_worker=NULL, assigned_at=NULL, target=CASE WHEN $2='QUEUED' THEN NULL ELSE target END,
     spent_micros=spent_micros+$6, reserved_micros=0 WHERE id=$1`,
    [job.id, status, success ? attempt.id : null, retry ? null : now, failure, spend],
  );
  await client.query('UPDATE workers SET busy_attempt=NULL WHERE busy_attempt=$1', [attempt.id]);
  const details = {
    attemptId: attempt.id, target: attempt.target, workerId: attempt.worker_id, instanceId: attempt.instance_id,
    imageDigest: attempt.image_digest, inputSha256: job.spec.inputSha256, startedAt: attempt.started_at,
    endedAt, ...outcome, spendMicros: spend, deadlineHit: success && now <= Date.parse(job.spec.deadline),
  };
  const kind = success ? 'succeeded' : retry ? 'retrying' : 'failed';
  await event(client, job.id, now, kind, details);
  await telemetry(client, now, { kind, jobId: job.id, policy: run.policy, ...details });
}
