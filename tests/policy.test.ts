import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeJob, rankJobs, type Candidate } from '../src/policy';
import { sha256 } from '../src/domain';
import { analyze } from '../src/vibration';

const job: Candidate = {
  id: 'urgent', priority: 'high', queuedAt: 0, deadline: 100_000, expectedSeconds: 30,
  inputBytes: 0, outputBytes: 0, budgetRemaining: 10_000,
};
const calibration = {
  cloudRuntimeRatio: 1, localBytesPerSecond: 1_000_000, cloudBytesPerSecond: 1_000_000,
  localFixedSeconds: 6, cloudFixedSeconds: 4,
};
const budget = { rateMicrosPerHour: 120_000, runRemaining: 1_000_000, cold: true, idleReserve: 3_000 };

test('QoS leaves EC2 stopped when local meets the deadline', () => {
  const result = placeJob(job, 'qos', 0, [{ id: 'a', target: 'local', freeAt: 0 }, { id: 'cloud', target: 'ec2', freeAt: 45_000 }], calibration, budget);
  assert.equal(result.reason, 'local_meets_deadline');
  assert.equal(result.localFinish, 36_000);
});

test('QoS considers cold boot, transfer, budget and a missed deadline', () => {
  const slots = [{ id: 'a', target: 'local', freeAt: 90_000 }, { id: 'cloud', target: 'ec2', freeAt: 45_000 }] as const;
  const result = placeJob(job, 'qos', 0, [...slots], calibration, budget);
  assert.equal(result.reason, 'cloud_rescues_deadline');
  assert.equal(result.cloudFinish, 79_000);
  assert.equal(result.reservation, 9000);
  assert.equal(placeJob({ ...job, budgetRemaining: 5000 }, 'qos', 0, [...slots], calibration, budget).reason, 'job_budget');
  assert.equal(placeJob({ ...job, deadline: 60_000 }, 'qos', 0, [...slots], calibration, budget).reason, 'both_targets_late');
});

test('FCFS, priority and QoS produce distinct ranks', () => {
  const old = { ...job, id: 'old', priority: 'low' as const };
  const newer = { ...job, queuedAt: 120_000, deadline: 200_000 };
  assert.equal(rankJobs([newer, old], 'fcfs', 121_000, calibration)[0].id, 'old');
  assert.equal(rankJobs([old, newer], 'priority', 121_000, calibration)[0].id, 'urgent');
  assert.equal(rankJobs([newer, old], 'qos', 121_000, calibration)[0].id, 'old');
});

test('reference recording produces a 250 Hz period', () => {
  const input = Buffer.from('2\n0\n-2\n0\n2\n0\n-2\n0\n');
  const result = analyze(input, { minLag: 2, maxLag: 4, sampleRate: 1000, inputSha256: sha256(input) });
  assert.deepEqual(result.scores.map(({ score }) => score), [-2, 0, 2]);
  assert.equal(result.bestLag, 4);
  assert.equal(result.frequencyHz, 250);
});
