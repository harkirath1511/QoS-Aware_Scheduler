import { sessionCost } from './controller';
import { db, type Attempt, type CapacitySession, type Job, type Run, type Worker } from './db';
import { Fault, limits } from './domain';

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, mean: null, median: null, p95: null };
  return {
    count: sorted.length,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

export function aggregate(run: Run, jobs: Job[], attempts: Attempt[], sessions: CapacitySession[], now: number) {
  const admitted = jobs.filter(job => job.queued_at !== null);
  const succeeded = admitted.filter(job => job.status === 'SUCCEEDED');
  const terminal = admitted.filter(job => job.terminal_at !== null);
  const hit = (job: Job) => job.status === 'SUCCEEDED' && job.terminal_at! <= Date.parse(job.spec.deadline);
  const high = admitted.filter(job => job.spec.priority === 'high');
  const wait = (cohort: Job[]) => summary(cohort.flatMap(job =>
    job.first_started_at === null ? [] : [job.first_started_at - job.queued_at!]));
  const retryWait = attempts.filter(attempt => attempt.number > 1).flatMap(attempt => {
    const previous = attempts.find(item => item.job_id === attempt.job_id && item.number === attempt.number - 1);
    return previous?.ended_at == null ? [] : [attempt.started_at - previous.ended_at];
  });
  const cloudAttempts = attempts.filter(attempt => attempt.target === 'ec2');
  const runningMs = sessions.reduce((sum, session) =>
    sum + (session.running_at === null ? 0 : (session.running_ended_at ?? now) - session.running_at), 0);
  const busyMs = cloudAttempts.reduce((sum, attempt) => sum + Math.min(limits.executionMs, (attempt.ended_at ?? now) - attempt.started_at), 0);
  const startupMs = sessions.reduce((sum, session) =>
    sum + (session.running_at === null ? 0 : Math.max(0, (session.ready_at ?? session.running_ended_at ?? now) - session.running_at)), 0);
  return {
    run, counts: {
      submitted: jobs.length, admitted: admitted.length, succeeded: succeeded.length, failed: terminal.length - succeeded.length,
      active: jobs.filter(job => job.terminal_at === null).length, neverClaimed: admitted.filter(job => job.first_started_at === null).length,
    },
    queueWaitMs: wait(admitted),
    queueWaitByPriority: Object.fromEntries(['low', 'normal', 'high'].map(priority => [priority, wait(admitted.filter(job => job.spec.priority === priority))])),
    retryWaitMs: summary(retryWait),
    completionMs: summary(succeeded.map(job => job.terminal_at! - job.queued_at!)),
    makespanMs: admitted.length && terminal.length === admitted.length
      ? Math.max(...terminal.map(job => job.terminal_at!)) - Math.min(...admitted.map(job => job.queued_at!)) : null,
    deadlines: { hits: admitted.filter(hit).length, denominator: admitted.length, highHits: high.filter(hit).length, highDenominator: high.length },
    cloud: {
      startRequests: sessions.length, starts: sessions.filter(session => session.running_at !== null).length,
      attempts: cloudAttempts.length, successes: cloudAttempts.filter(attempt => attempt.outcome === 'succeeded').length,
      busyMs, runningMs, startupMs, idleMs: Math.max(0, runningMs - busyMs - startupMs),
      computeMicros: sessions.reduce((sum, session) => sum + sessionCost(session, now), 0),
      active: sessions.some(session => session.stopped_at === null),
      sessions,
    },
  };
}

export async function getRunMetrics(id: string) {
  const { rows: [run] } = await db().query<Run>('SELECT * FROM runs WHERE id=$1', [id]);
  if (!run) throw new Fault(404, 'Run not found.');
  const [jobs, attempts, sessions] = await Promise.all([
    db().query<Job>('SELECT * FROM jobs WHERE run_id=$1', [id]),
    db().query<Attempt>('SELECT attempts.* FROM attempts JOIN jobs ON jobs.id=attempts.job_id WHERE jobs.run_id=$1', [id]),
    db().query<CapacitySession>('SELECT * FROM capacity_sessions WHERE run_id=$1 ORDER BY requested_at', [id]),
  ]);
  return aggregate(run, jobs.rows, attempts.rows, sessions.rows, Date.now());
}

export async function runSummaries() {
  const { rows } = await db().query<Run>('SELECT * FROM runs ORDER BY created_at DESC LIMIT 30');
  return Promise.all(rows.map(run => getRunMetrics(run.id)));
}

export async function operatorSnapshot() {
  const now = Date.now();
  const [workers, capacity, jobs, telemetry] = await Promise.all([
    db().query<Worker>('SELECT * FROM workers ORDER BY id'),
    db().query<CapacitySession>('SELECT * FROM capacity_sessions WHERE stopped_at IS NULL'),
    db().query<{ status: string; count: number; oldest: number | null }>('SELECT status,count(*),min(queued_at) AS oldest FROM jobs GROUP BY status'),
    db().query<{ count: number }>('SELECT count(*) FROM telemetry WHERE sent_at IS NULL'),
  ]);
  const queued = jobs.rows.find(row => row.status === 'QUEUED');
  return {
    workers: workers.rows.map(worker => ({ ...worker, healthy: worker.seen_at > now - limits.leaseMs })),
    capacity: capacity.rows[0] ?? null, queued: queued?.count ?? 0,
    running: jobs.rows.find(row => row.status === 'RUNNING')?.count ?? 0,
    oldestWaitMs: queued?.oldest == null ? 0 : Math.max(0, now - queued.oldest),
    telemetryPending: telemetry.rows[0].count,
  };
}
