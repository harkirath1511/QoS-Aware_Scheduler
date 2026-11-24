import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Job } from '../src/db';
import { sha256 } from '../src/domain';

const origin = process.env.SMOKE_URL;

test('dashboard API accepts a recording and publishes a verified local result', { skip: !origin, timeout: 45_000 }, async () => {
  if (existsSync('.env')) loadEnvFile('.env');
  const accounts = JSON.parse(process.env.DASHBOARD_ACCOUNTS ?? '{}');
  const operator: string = accounts.operator.token;
  const student: string = accounts.student.token;
  const recording = 'sample\n2\n0\n-2\n0\n2\n0\n-2\n0\n';
  const key = randomUUID();

  async function api(path: string, init?: RequestInit, token = student) {
    return fetch(new URL(path, origin), {
      ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
  }

  const page = await fetch(new URL('/', origin));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Cloud QoS Scheduler/);
  assert.equal((await api('/api/jobs', {}, 'invalid')).status, 401);
  const creation = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({
      type: 'vibration-v1', sampleRate: 1000, minLag: 2, maxLag: 4, priority: 'normal',
      deadline: new Date(Date.now() + 60_000).toISOString(), expectedSeconds: 1, budgetUsd: '0',
      inputSha256: sha256(recording),
    }),
  };
  const created = await api('/api/jobs', creation);
  assert.equal(created.status, 201, await created.clone().text());
  const job: Job = await created.json();
  const path = `/api/jobs/${job.id}`;
  assert.equal(job.status, 'AWAITING_INPUT');
  assert.equal((await api(path, {}, operator)).status, 404);
  assert.equal((await api(`${path}/result`)).status, 409);
  assert.equal((await api('/api/jobs', creation)).status, 200);
  assert.equal((await api(`${path}/input`, { method: 'PUT', body: 'wrong file' })).status, 422);
  const upload = await api(`${path}/input`, { method: 'PUT', body: recording });
  assert.equal(upload.status, 202, await upload.clone().text());
  const duplicate = await api(`${path}/input`, { method: 'PUT', body: recording });
  assert.equal(duplicate.status, 200);
  const until = Date.now() + 30_000;
  let finished: Job | undefined;
  while (Date.now() < until) {
    const status: Job = await (await api(path)).json();
    if (status.status === 'SUCCEEDED' || status.status === 'FAILED') {
      finished = status;
      break;
    }
    await sleep(500);
  }
  assert.equal(finished?.status, 'SUCCEEDED', JSON.stringify(finished));
  assert.equal(finished?.target, 'local');
  const result = await api(`${path}/result`);
  assert.equal(result.status, 200);
  assert.match(result.headers.get('Content-Disposition') ?? '', /attachment/);
  const output = await result.json();
  assert.equal(output.inputSha256, sha256(recording));
  assert.equal(output.frequencyHz, 250);
  assert.equal((await api('/api/runs/operations', {}, operator)).status, 200);
  assert.equal((await api('/api/runs/operations')).status, 403);
});
