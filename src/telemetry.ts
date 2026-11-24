import { CloudWatchClient, PutMetricDataCommand, type MetricDatum } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, PutLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { config } from './config';
import { db } from './db';
import { limits } from './domain';
import { getRunMetrics, operatorSnapshot } from './metrics';

interface RecordPayload {
  kind: string;
  failure?: string;
  target?: string;
  policy?: string;
  startupMs?: number;
}

export function telemetryPublisher() {
  const env = config();
  if (!env.CLOUDWATCH_LOG_GROUP) return null;
  const metrics = new CloudWatchClient({ region: env.AWS_REGION, maxAttempts: 2 });
  const logs = new CloudWatchLogsClient({ region: env.AWS_REGION, maxAttempts: 2 });
  let lastMetricsAt = 0;
  let workerLoss = 0;
  let startupTimeouts = 0;
  let lastId = 0;
  let latestBootMs: number | undefined;

  return async () => {
    const now = Date.now();
    const { rows } = await db().query<{ id: number; payload: RecordPayload; created_at: number }>(
      'SELECT id,payload,created_at FROM telemetry WHERE sent_at IS NULL ORDER BY id LIMIT 50',
    );
    if (rows.length) {
      // CloudWatch Logs accepts events for up to 14 days. The DB retains older history.
      const recent = rows.filter(row => now - row.created_at < 13 * 86_400_000);
      if (recent.length) {
        await logs.send(new PutLogEventsCommand({
          logGroupName: env.CLOUDWATCH_LOG_GROUP, logStreamName: 'controller',
          logEvents: recent.map(row => ({ timestamp: row.created_at, message: JSON.stringify({ eventId: row.id, ...row.payload }) })),
        }), { abortSignal: AbortSignal.timeout(8000) });
      }
      for (const row of rows) {
        if (row.id <= lastId) continue;
        if (row.payload.failure === 'worker_lost') workerLoss++;
        if (row.payload.kind === 'cloud_startup_timeout') startupTimeouts++;
        if (row.payload.startupMs !== undefined) latestBootMs = row.payload.startupMs;
        lastId = row.id;
      }
    }
    if (now - lastMetricsAt < 60_000) return;
    const ops = await operatorSnapshot();
    const { rows: [active] } = await db().query('SELECT id FROM runs WHERE ended_at IS NULL');
    const run = active && await getRunMetrics(active.id);
    const data: MetricDatum[] = [];
    function point(MetricName: string, Value: number, Unit?: MetricDatum['Unit']) {
      data.push({ MetricName, Value, Unit, Timestamp: new Date(now) });
    }
    point('QueueDepth', ops.queued, 'Count');
    point('RunningJobs', ops.running, 'Count');
    point('OldestQueueWait', ops.oldestWaitMs / 1000, 'Seconds');
    point('HealthySlots', ops.workers.filter(worker => worker.healthy).length, 'Count');
    point('WorkerLoss', workerLoss, 'Count');
    point('StartupTimeout', startupTimeouts, 'Count');
    point('StopOverdue', Number(!!ops.capacity?.stop_requested_at && now - ops.capacity.stop_requested_at > limits.stopGraceMs), 'Count');
    if (latestBootMs !== undefined) point('StartupDelay', latestBootMs / 1000, 'Seconds');
    if (run) {
      point('DeadlineHits', run.deadlines.hits, 'Count');
      point('DeadlineMisses', run.counts.succeeded + run.counts.failed - run.deadlines.hits, 'Count');
      point('Retries', run.retryWaitMs.count, 'Count');
      point('Ec2Busy', run.cloud.busyMs / 1000, 'Seconds');
      point('Ec2Idle', run.cloud.idleMs / 1000, 'Seconds');
      point('EstimatedComputeUsd', run.cloud.computeMicros / 1_000_000, 'None');
    }
    await metrics.send(new PutMetricDataCommand({ Namespace: env.CLOUDWATCH_NAMESPACE, MetricData: data }), {
      abortSignal: AbortSignal.timeout(8000),
    });
    if (lastId) await db().query('UPDATE telemetry SET sent_at=$1 WHERE id <= $2 AND sent_at IS NULL', [now, lastId]);
    lastMetricsAt = now;
    workerLoss = 0;
    startupTimeouts = 0;
    latestBootMs = undefined;
  };
}
