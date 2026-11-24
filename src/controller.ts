import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db, event, telemetry, transaction, type Attempt, type CapacitySession, type Decision, type Job, type Worker } from './db';
import { limits } from './domain';
import { activeRun, finishAttempt } from './jobs';
import { computeCost, placeJob, rankJobs, serviceMs, type Candidate, type Slot } from './policy';

export const cloudWorker = 'ec2-1';
export const localWorkers = ['local-1', 'local-2'];
export type CloudState = 'disabled' | 'unknown' | 'stopped' | 'pending' | 'running' | 'stopping';
type Action = 'start' | 'stop' | null;

function candidate(job: Job): Candidate {
  return {
    id: job.id, priority: job.spec.priority, queuedAt: job.queued_at!, deadline: Date.parse(job.spec.deadline),
    expectedSeconds: job.spec.expectedSeconds, inputBytes: job.input_bytes!,
    outputBytes: 512 + 48 * (job.spec.maxLag - job.spec.minLag + 1),
    budgetRemaining: job.budget_micros - job.spent_micros - job.reserved_micros,
  };
}

async function requeue(client: PoolClient, job: Job, now: number, reason: string) {
  await client.query(
    `UPDATE jobs SET status='QUEUED', assigned_at=NULL, assigned_worker=NULL, target=NULL, reserved_micros=0,
     failure=$2 WHERE id=$1`, [job.id, reason],
  );
  await event(client, job.id, now, 'assignment_requeued', { reason });
}

async function expireJobs(client: PoolClient, now: number, healthyIds: Set<string>, session?: CapacitySession) {
  const { rows } = await client.query<Job>(
    `SELECT * FROM jobs WHERE status NOT IN ('SUCCEEDED','FAILED')`,
  );
  for (const job of rows) {
    if (job.status === 'RUNNING') {
      const { rows: [attempt] } = await client.query<Attempt>('SELECT * FROM attempts WHERE id=$1', [job.active_attempt_id]);
      const timedOut = now >= attempt.started_at + limits.executionMs;
      if (timedOut || now >= attempt.lease_until) {
        await finishAttempt(client, job, attempt, now, { failure: timedOut ? 'timed_out' : 'worker_lost', transient: true });
      }
    } else if (job.status === 'ASSIGNED') {
      const healthy = healthyIds.has(job.assigned_worker!);
      const starting = job.target === 'ec2' && session && !session.fault && session.ready_at === null && session.stop_requested_at === null;
      const availableSince = Math.max(job.assigned_at!, job.target === 'ec2' ? session?.ready_at ?? 0 : 0);
      if ((!healthy && !starting) || now - availableSince >= (starting ? limits.startupMs : limits.leaseMs)) {
        await requeue(client, job, now, session?.fault && job.target === 'ec2' ? session.fault : 'worker_unavailable');
      }
    } else {
      const upload = job.status === 'AWAITING_INPUT';
      const expires = upload ? job.created_at + limits.uploadMs : job.queued_at! + limits.waitingMs;
      if (now >= expires) {
        const reason = upload ? 'upload_expired' : job.decision?.cloudBlock ?? 'queue_expired';
        await client.query(`UPDATE jobs SET status='FAILED', terminal_at=$2, failure=$3 WHERE id=$1`, [job.id, now, reason]);
        await event(client, job.id, now, 'failed', { reason });
      }
    }
  }
}

async function chargeStartup(client: PoolClient, session: CapacitySession, endedAt: number) {
  if (session.running_at === null) return;
  const duration = Math.max(0, Math.min(limits.startupMs, endedAt - session.running_at));
  const cost = computeCost(session.rate_micros, duration);
  await client.query(
    `UPDATE jobs SET spent_micros=spent_micros+$2, reserved_micros=GREATEST(0,reserved_micros-$3)
     WHERE id=$1`, [session.startup_job_id, cost, computeCost(session.rate_micros, limits.startupMs)],
  );
}

async function requestStop(client: PoolClient, session: CapacitySession, now: number, fault: string | null) {
  if (session.ready_at === null) await chargeStartup(client, session, now);
  await client.query('UPDATE capacity_sessions SET stop_requested_at=$2, fault=$3 WHERE id=$1', [session.id, now, fault]);
  const kind = fault ?? 'cloud_stop_requested';
  await event(client, session.startup_job_id, now, kind, { instanceId: session.instance_id, sessionId: session.id });
  await telemetry(client, now, { kind, target: 'ec2', sessionId: session.id, instanceId: session.instance_id });
}

async function reconcile(
  client: PoolClient, session: CapacitySession | undefined, state: CloudState, worker: Worker | undefined, now: number,
): Promise<{ session?: CapacitySession; action: Action }> {
  if (!session) return { action: state === 'running' || state === 'pending' ? 'stop' : null };
  if (state === 'running' && session.running_at === null) {
    session.running_at = now;
    await client.query('UPDATE capacity_sessions SET running_at=$2 WHERE id=$1', [session.id, now]);
  }
  if ((state === 'stopping' || state === 'stopped') && session.running_at !== null && session.running_ended_at === null) {
    session.running_ended_at = now;
    await client.query('UPDATE capacity_sessions SET running_ended_at=$2 WHERE id=$1', [session.id, now]);
  }
  if (state === 'stopped' && (session.stop_requested_at !== null || session.running_at !== null)) {
    if (session.stop_requested_at === null) {
      session.fault = 'cloud_stopped_unexpectedly';
      if (session.ready_at === null) await chargeStartup(client, session, now);
    }
    await client.query('UPDATE capacity_sessions SET stopped_at=$2,fault=$3 WHERE id=$1', [session.id, now, session.fault]);
    await event(client, session.startup_job_id, now, 'cloud_stopped', { instanceId: session.instance_id, sessionId: session.id });
    if (session.fault) await telemetry(client, now, { kind: session.fault, target: 'ec2', sessionId: session.id });
    return { action: null };
  }
  if (session.stop_requested_at !== null) return { session, action: state === 'pending' || state === 'running' ? 'stop' : null };
  if (session.ready_at === null && state === 'running' && worker && worker.seen_at >= session.requested_at) {
    session.ready_at = now;
    await chargeStartup(client, session, now);
    await client.query('UPDATE capacity_sessions SET ready_at=$2 WHERE id=$1', [session.id, now]);
    await event(client, session.startup_job_id, now, 'cloud_ready', { instanceId: session.instance_id, startupMs: now - session.requested_at });
    await telemetry(client, now, { kind: 'cloud_ready', target: 'ec2', startupMs: now - session.requested_at });
  }
  if (session.ready_at === null && now - session.requested_at >= limits.startupMs) {
    await requestStop(client, session, now, 'cloud_startup_timeout');
    session.stop_requested_at = now;
    session.fault = 'cloud_startup_timeout';
    return { session, action: state === 'running' || state === 'pending' ? 'stop' : null };
  }
  if (session.ready_at !== null) {
    const { rowCount } = await client.query(
      `SELECT id FROM jobs WHERE assigned_worker=$1 AND status IN ('ASSIGNED','RUNNING')`, [cloudWorker],
    );
    const idleAt = rowCount ? null : session.idle_at ?? now;
    if (idleAt !== session.idle_at) {
      session.idle_at = idleAt;
      await client.query('UPDATE capacity_sessions SET idle_at=$2 WHERE id=$1', [session.id, idleAt]);
    }
    if (idleAt !== null && now - idleAt >= limits.idleMs) {
      await requestStop(client, session, now, null);
      session.stop_requested_at = now;
      return { session, action: state === 'running' ? 'stop' : null };
    }
  }
  return { session, action: session.ready_at === null && state === 'stopped' ? 'start' : null };
}

function forecastChange(previous: Decision | null, next: Decision) {
  if (!previous) return true;
  return (['policy', 'rank', 'selected', 'reason', 'cloudBlock', 'deadlineRisk'] as const)
    .some(key => previous[key] !== next[key]);
}

function finite(value: number) { return Number.isFinite(value) ? value : null; }

export async function schedule(state: CloudState, now = Date.now()): Promise<Action> {
  return transaction(async client => {
    const run = await activeRun(client, now);
    const { calibration, rateMicrosPerHour: rate, startupEstimateMs } = run.config;
    const { rows } = await client.query<Worker>('SELECT * FROM workers WHERE seen_at > $1', [now - limits.leaseMs]);
    const workers = new Map(rows.map(worker => [worker.id, worker]));
    const { rows: [open] } = await client.query<CapacitySession>('SELECT * FROM capacity_sessions WHERE stopped_at IS NULL');
    const capacity = await reconcile(client, open, state, workers.get(cloudWorker), now);
    const session = capacity.session;
    if (!session || session.stop_requested_at !== null || state !== 'running' || session.ready_at === null) workers.delete(cloudWorker);
    await expireJobs(client, now, new Set(workers.keys()), session);

    const { rows: assigned } = await client.query<Job & { started_at: number | null; lease_until: number | null }>(
      `SELECT jobs.*,attempts.started_at,attempts.lease_until FROM jobs LEFT JOIN attempts ON attempts.id=jobs.active_attempt_id
       WHERE jobs.status IN ('ASSIGNED','RUNNING')`,
    );
    const occupied = new Map(assigned.map(job => [job.assigned_worker, job]));
    const slots: Slot[] = [];
    function addSlot(id: string, target: Slot['target'], readyAt: number) {
      const job = occupied.get(id);
      let freeAt = readyAt;
      if (job) {
        const estimated = serviceMs(candidate(job), target, calibration);
        freeAt = job.started_at === null ? readyAt + estimated :
          Math.min(job.started_at + limits.executionMs, Math.max(now + 5_000, job.started_at + estimated));
        freeAt = Math.max(now + 1, freeAt);
      }
      slots.push({ id, target, freeAt });
    }
    for (const id of localWorkers) if (workers.has(id)) addSlot(id, 'local', now);
    const { rows: sessions } = await client.query<CapacitySession>(
      'SELECT * FROM capacity_sessions WHERE run_id=$1 ORDER BY requested_at DESC', [run.id],
    );
    const { rows: [lastFault] } = await client.query<CapacitySession>(
      'SELECT * FROM capacity_sessions WHERE fault IS NOT NULL AND stopped_at IS NOT NULL ORDER BY stopped_at DESC LIMIT 1',
    );
    const cooldown = lastFault && now - lastFault.stopped_at! < limits.cooldownMs;
    const coldAvailable = !session && state === 'stopped' && !cooldown;
    const booting = !!session && session.ready_at === null && session.stop_requested_at === null;
    if (workers.has(cloudWorker)) addSlot(cloudWorker, 'ec2', now);
    else if (coldAvailable) addSlot(cloudWorker, 'ec2', now + startupEstimateMs);
    else if (booting && state !== 'unknown') {
      const readyAt = Math.min(session.requested_at + limits.startupMs, Math.max(now + 1_000, session.requested_at + startupEstimateMs));
      addSlot(cloudWorker, 'ec2', readyAt);
    }
    const used = sessions.reduce((sum, item) => sum + sessionCost(item, now), 0);
    const held = assigned.reduce((sum, job) => sum + Math.max(0, job.reserved_micros -
      (job.target === 'ec2' && job.started_at !== null ? computeCost(rate, now - job.started_at) : 0)), 0);
    let remaining = run.config.runBudgetMicros - used - held;
    const { rows: queued } = await client.query<Job>(`SELECT * FROM jobs WHERE status='QUEUED'`);
    const ranked = rankJobs(queued.map(candidate), run.policy, now, calibration);
    const jobs = new Map(queued.map(job => [job.id, job]));
    let action = capacity.action;
    let cold = coldAvailable;
    const reservedSlots = new Set(occupied.keys());
    for (const [index, item] of ranked.entries()) {
      const job = jobs.get(item.id)!;
      const localServiceMs = serviceMs(item, 'local', calibration);
      const cloudServiceMs = serviceMs(item, 'ec2', calibration);
      const result = placeJob(item, run.policy, now, slots, calibration, {
        rateMicrosPerHour: rate, runRemaining: remaining, cold,
        idleReserve: computeCost(rate, limits.idleMs + limits.stopGraceMs),
      });
      const slot = result.selected;
      const decision = {
        policy: run.policy, rank: index + 1,
        localFinish: finite(result.localFinish), cloudFinish: finite(result.cloudFinish),
        selected: slot?.target ?? null, reason: result.reason, cloudBlock: result.cloudBlock, deadlineRisk: result.deadlineRisk,
        jobRemainingMicros: item.budgetRemaining, runRemainingMicros: remaining, cloudExpectedMicros: result.cloudExpectedCost,
        cloudReservationMicros: result.reservation, localServiceMs, cloudServiceMs,
        localAvailableAt: finite(result.localFinish - localServiceMs), cloudAvailableAt: finite(result.cloudFinish - cloudServiceMs),
      };
      // Keep timestamps from the last decision until a meaningful change or commitment.
      const commit = slot && !reservedSlots.has(slot.id) && (slot.freeAt <= now || (cold && slot.target === 'ec2'));
      if (commit || forecastChange(job.decision, decision)) {
        await client.query('UPDATE jobs SET decision=$2 WHERE id=$1', [job.id, decision]);
        await event(client, job.id, now, 'placement', decision);
      }
      if (!slot) continue;
      slot.freeAt = result.finishAt;
      if (slot.target === 'ec2') remaining -= result.reservation;
      if (!commit) continue;
      reservedSlots.add(slot.id);
      await client.query(
        `UPDATE jobs SET status='ASSIGNED', assigned_at=$2, assigned_worker=$3, target=$4, reserved_micros=$5 WHERE id=$1`,
        [job.id, now, slot.id, slot.target, slot.target === 'ec2' ? result.reservation : 0],
      );
      await event(client, job.id, now, 'assigned', { workerId: slot.id, target: slot.target, waitingForEc2: cold && slot.target === 'ec2' });
      if (cold && slot.target === 'ec2') {
        cold = false;
        await client.query(
          `INSERT INTO capacity_sessions (id,run_id,instance_id,startup_job_id,rate_micros,requested_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), run.id, run.config.instanceId, job.id, rate, now],
        );
        action = 'start';
      }
    }
    return action;
  });
}

export function sessionCost(session: CapacitySession, now: number) {
  if (session.running_at === null) return 0;
  return computeCost(session.rate_micros, Math.max(60_000, (session.running_ended_at ?? now) - session.running_at));
}

export async function controllerTick(observe: () => Promise<CloudState>, act: (action: 'start' | 'stop') => Promise<void>) {
  const client = await db().connect();
  let lock = false;
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(531, 2) AS locked');
    lock = rows[0].locked;
    if (!lock) return;
    const action = await schedule(await observe());
    if (action) await act(action);
  } finally {
    try { if (lock) await client.query('SELECT pg_advisory_unlock(531, 2)'); }
    finally { client.release(); }
  }
}
