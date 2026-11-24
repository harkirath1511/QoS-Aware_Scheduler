import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { schedule } from '../src/controller';
import { db, transaction } from '../src/db';
import { limits, sha256, type JobInput } from '../src/domain';
import { admit, claim, currentAttempt, finishAttempt, ownedJob, register, submit } from '../src/jobs';
import { getRunMetrics } from '../src/metrics';

const connection = process.env.TEST_DATABASE_URL;

test('PostgreSQL enforces leases and preserves EC2 assignments through startup and stop', { skip: !connection }, async () => {
  const admin = new Pool({ connectionString: connection });
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(connection!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await db().query(await readFile('db/001_initial.sql', 'utf8'));
    await db().query(await readFile('db/002_controller_state.sql', 'utf8'));
    const owner = 'student';
    const coldLocal = await registerSlot('local-1', 'local');
    const secondLocal = await registerSlot('local-2', 'local');
    const initial = createSpec({ deadline: new Date(Date.now() + 300_000).toISOString(), budgetUsd: '0' });
    const first = await submit(owner, 'first', initial);
    assert.equal((await submit(owner, 'first', initial)).job.id, first.job.id);
    await assert.rejects(submit(owner, 'first', { ...initial, budgetUsd: '1' }), { status: 409 });
    await assert.rejects(ownedJob(first.job.id, 'other'), { status: 404 });
    await admit(first.job.id, owner, 16);
    const second = await enqueue(owner, initial);
    await schedule('disabled');
    const [firstClaim, duplicateClaim, secondClaim] = await Promise.all([
      claim(coldLocal.id, coldLocal.generation), claim(coldLocal.id, coldLocal.generation),
      claim(secondLocal.id, secondLocal.generation),
    ]);
    assert.ok(firstClaim && secondClaim);
    assert.equal(firstClaim.attempt.id, duplicateClaim?.attempt.id);
    assert.deepEqual(new Set([firstClaim.job.id, secondClaim.job.id]), new Set([first.job.id, second.id]));

    await db().query(`UPDATE runs SET config=config || $1::jsonb WHERE id=$2`, [
      JSON.stringify({ instanceId: 'i-01234567890123456', rateMicrosPerHour: 120_000, startupEstimateMs: 45_000 }),
      first.job.run_id,
    ]);
    const urgent = await enqueue(owner, createSpec({
      expectedSeconds: 1, deadline: new Date(Date.now() + 60_000).toISOString(),
    }));
    assert.equal(await schedule('stopped'), 'start');
    assert.equal((await ownedJob(urgent.id, owner)).target, 'ec2');
    assert.equal(await schedule('pending'), null);
    const cloud = await registerSlot('ec2-1', 'ec2');
    assert.equal(await claim(cloud.id, cloud.generation), null);
    await db().query('UPDATE jobs SET assigned_at=assigned_at-$2 WHERE id=$1', [urgent.id, 45_000]);
    await db().query('UPDATE capacity_sessions SET requested_at=requested_at-45000');
    assert.equal(await schedule('running'), null);
    const cloudClaim = await claim(cloud.id, cloud.generation);
    assert.equal(cloudClaim?.job.id, urgent.id);
    assert.ok(cloudClaim);
    await transaction(client => finishAttempt(client, cloudClaim.job, cloudClaim.attempt, Date.now(), { checksum: sha256('result') }));
    assert.equal((await ownedJob(urgent.id, owner)).status, 'SUCCEEDED');
    const ack = await transaction(client => currentAttempt(client, cloud.id, cloud.generation, cloudClaim.attempt.id, Date.now(), true));
    assert.equal(ack.attempt.outcome, 'succeeded');
    const reuse = await enqueue(owner, createSpec({
      expectedSeconds: 1, deadline: new Date(Date.now() + 25_000).toISOString(), budgetUsd: '0.006',
    }));
    assert.equal(await schedule('running'), null);
    const reusedClaim = await claim(cloud.id, cloud.generation);
    assert.equal(reusedClaim?.job.id, reuse.id);
    assert.ok(reusedClaim);
    await transaction(client =>
      finishAttempt(client, reusedClaim.job, reusedClaim.attempt, Date.now(), { checksum: sha256('second cloud result') }));
    await schedule('running');
    await db().query('UPDATE capacity_sessions SET idle_at=idle_at-$1', [limits.idleMs + 1000]);
    assert.equal(await schedule('running'), 'stop');
    await assert.rejects(claim(cloud.id, cloud.generation), { status: 503 });
    await schedule('stopping');
    await schedule('stopped');
    const metric = await getRunMetrics(urgent.run_id);
    assert.equal(metric.cloud.successes, 2);
    assert.equal(metric.cloud.starts, 1);
    assert.equal(metric.cloud.active, false);
    assert.ok(metric.cloud.computeMicros >= 2000);
    await db().query('UPDATE controller_state SET observed_at=0');
    await assert.rejects(claim(cloud.id, cloud.generation), { status: 503 });

    await db().query('UPDATE attempts SET lease_until=0 WHERE id=$1', [firstClaim.attempt.id]);
    await schedule('disabled');
    await assert.rejects(transaction(client =>
      currentAttempt(client, coldLocal.id, coldLocal.generation, firstClaim.attempt.id, Date.now(), true)),
    { status: 409 });
    const retry = await claim(coldLocal.id, coldLocal.generation);
    assert.equal(retry?.attempt.number, 2);
    assert.equal(retry?.job.id, firstClaim.job.id);
  } finally {
    await db().end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

function createSpec(overrides: Partial<JobInput>): JobInput {
  return {
    type: 'vibration-v1', minLag: 2, maxLag: 4, sampleRate: 1000, priority: 'high',
    inputSha256: sha256('same recording'), deadline: new Date(Date.now() + 300_000).toISOString(),
    expectedSeconds: 95, budgetUsd: '0.010', ...overrides,
  };
}

async function registerSlot(id: string, target: 'local' | 'ec2') {
  const identity = { id, target, generation: randomUUID(), instanceId: target === 'ec2' ? 'i-01234567890123456' : undefined };
  await register(identity);
  return identity;
}

async function enqueue(owner: string, spec: JobInput) {
  const response = await submit(owner, randomUUID(), spec);
  return admit(response.job.id, owner, 16);
}
