import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Attempt, Job, Run } from '../src/db';
import { sha256 } from '../src/domain';
import type { getRunMetrics, operatorSnapshot } from '../src/metrics';

type Detail = Job & { attempts: Attempt[] };
type Metrics = Awaited<ReturnType<typeof getRunMetrics>>;
type Operations = Awaited<ReturnType<typeof operatorSnapshot>>;
const output = 'evaluation-output/hosted';
const phase = process.argv[2];
const sample = Buffer.from('sample\n2\n0\n-2\n0\n2\n0\n-2\n0\n');
const bulk = () => Buffer.from(Array.from({ length: 245_000 }, (_, i) =>
  Math.round(7000 * Math.sin(2 * Math.PI * i / 25))).join('\n') + '\n');

class HostedApi {
  private sessionCookie?: string;

  constructor(private origin: URL, private token: string) {}

  async signIn() {
    const response = await this.request('/api/session', {
      method: 'POST', body: JSON.stringify({ token: this.token }), headers: { 'Content-Type': 'application/json' },
    }, true);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie ?? '', /; HttpOnly/i);
    assert.match(cookie ?? '', /; Secure/i);
    assert.match(cookie ?? '', /; SameSite=lax/i);
    this.sessionCookie = cookie!.split(';', 1)[0];
    assert.equal((await response.json()).operator, true);
  }

  async request(path: string, init: RequestInit = {}, anonymous = false) {
    const headers = new Headers(init.headers);
    if (!anonymous && this.sessionCookie) headers.set('Cookie', this.sessionCookie);
    if (!anonymous && !this.sessionCookie) headers.set('Authorization', `Bearer ${this.token}`);
    if (init.method && init.method !== 'GET') headers.set('Origin', this.origin.origin);
    const response = await fetch(new URL(path, this.origin), {
      ...init, headers, cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(25_000),
    });
    assert.ok(response.ok || response.status === 303, `${init.method ?? 'GET'} ${path} returned HTTP ${response.status}`);
    return response;
  }

  async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.request(path, init)).json() as Promise<T>;
  }

  async post<T>(path: string, body: object, headers?: Record<string, string>): Promise<T> {
    return this.json(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
  }

  async until<T>(path: string, done: (state: T) => boolean, label: string, timeout = 180_000) {
    const stopAt = Date.now() + timeout;
    while (Date.now() < stopAt) {
      const state = await this.json<T>(path);
      if (done(state)) return state;
      await sleep(900);
    }
    throw new Error(`Timed out waiting for ${label}.`);
  }

  async submit(input: Buffer, values: { runId?: string; deadlineSeconds: number; budget: string; large?: boolean; priority?: 'high' | 'normal' }) {
    const job = await this.post<Job>('/api/jobs', {
      type: 'vibration-v1', runId: values.runId, inputSha256: sha256(input), sampleRate: 1000,
      minLag: values.large ? 1 : 2, maxLag: values.large ? 2048 : 4,
      priority: values.priority ?? 'normal', expectedSeconds: values.large ? 120 : 1,
      deadline: new Date(Date.now() + values.deadlineSeconds * 1000).toISOString(), budgetUsd: values.budget,
    }, { 'Idempotency-Key': randomUUID() });
    await this.request(`/api/jobs/${job.id}/input`, { method: 'PUT', body: new Uint8Array(input), headers: { 'Content-Type': 'text/csv' } });
    return job;
  }

  async result(jobId: string, target: Attempt['target']) {
    const job = await this.until<Detail>(`/api/jobs/${jobId}`, item => item.terminal_at !== null, `${target} result`, 300_000);
    assert.equal(job.status, 'SUCCEEDED', `Job ${jobId} failed with ${job.failure}`);
    const winning = job.attempts.find(item => item.id === job.winning_attempt_id);
    assert.ok(winning);
    assert.equal(winning.target, target);
    assert.equal(job.attempts.filter(item => item.outcome === 'succeeded').length, 1);
    const redirect = await this.request(`/api/jobs/${jobId}/result`);
    assert.equal(redirect.status, 303);
    const location = new URL(redirect.headers.get('location')!);
    assert.equal(location.protocol, 'https:');
    assert.match(location.hostname, /\.amazonaws\.com$/);
    assert.ok(location.searchParams.has('X-Amz-Signature'));
    const result = await fetch(location, { signal: AbortSignal.timeout(20_000) });
    assert.ok(result.ok, 'The private result could not be downloaded.');
    const bytes = Buffer.from(await result.arrayBuffer());
    const checksum = sha256(bytes);
    assert.equal(checksum, winning.output_sha256);
    assert.equal(JSON.parse(bytes.toString('utf8')).frequencyHz, 250);
    const browserDownload = await this.request(`/api/jobs/${jobId}/result?download=1`);
    assert.equal(browserDownload.status, 200);
    assert.equal(browserDownload.headers.get('content-disposition'), `attachment; filename="${jobId}.json"`);
    assert.equal(sha256(Buffer.from(await browserDownload.arrayBuffer())), checksum);
    return { job, winning, checksum, publishedBeforeDeadline: job.terminal_at! <= Date.parse(job.spec.deadline) };
  }

  stopped(runId: string, attempt: Attempt) {
    return this.until<Metrics>(`/api/runs/${runId}/metrics`, item => !item.cloud.active && item.cloud.sessions.some(session =>
      session.instance_id === attempt.instance_id && session.ready_at !== null && session.ready_at <= attempt.started_at &&
      session.stopped_at !== null && session.stopped_at >= attempt.ended_at!), 'the EC2 idle shutdown');
  }
}

async function main() {
  assert.ok(['connected', 'offline', 'restart'].includes(phase), 'Pass connected, offline, or restart.');
  const origin = new URL(process.env.HOSTED_VERIFY_URL!);
  const token = process.env.HOSTED_VERIFY_TOKEN;
  assert.ok(token && origin.protocol === 'https:' &&
    /\.(cloudfront\.net|execute-api\.us-east-1\.amazonaws\.com)$/.test(origin.hostname));
  const api = new HostedApi(origin, token);
  // Check that the CDN forwards authorization before testing its cookie-based UI flow.
  await api.request('/api/runs/operations');
  await api.signIn();
  let evidence;
  if (phase === 'connected') {
    await api.until<Operations>('/api/runs/operations', ops => ops.cloudState === 'stopped' &&
      ops.workers.filter(item => item.target === 'local' && item.healthy).length === 2, 'both laptop workers');
    const standalone = await api.submit(sample, { deadlineSeconds: 60, budget: '0' });
    const local = await api.result(standalone.id, 'local');
    assert.equal(local.job.decision?.reason, 'local_meets_deadline');
    const run = await api.post<Run>('/api/runs', { label: 'Hosted burst acceptance', policy: 'qos', manifest: { purpose: 'hosted test' } });
    const input = bulk();
    const preloads = await Promise.all([1, 2].map(() => api.submit(input, {
      runId: run.id, large: true, deadlineSeconds: 300, budget: '0',
    })));
    const running = await Promise.all(preloads.map(job => api.until<Detail>(`/api/jobs/${job.id}`, value => value.status === 'RUNNING', 'a local preload')));
    assert.deepEqual(new Set(running.map(job => job.assigned_worker)), new Set(['local-1', 'local-2']));
    const urgent = await api.submit(sample, { runId: run.id, deadlineSeconds: 85, budget: '0.030', priority: 'high' });
    const cloud = await api.result(urgent.id, 'ec2');
    assert.equal(cloud.job.decision?.reason, 'cloud_rescues_deadline');
    assert.equal(cloud.publishedBeforeDeadline, true);
    const metrics = await api.stopped(run.id, cloud.winning);
    await Promise.all(preloads.map(job => api.until<Detail>(`/api/jobs/${job.id}`, state => state.terminal_at !== null, 'preload completion')));
    await api.request('/api/runs/finish', { method: 'POST', body: JSON.stringify({ id: run.id }), headers: { 'Content-Type': 'application/json' } });
    evidence = { local, cloud, preloads: running.map(({ id, assigned_worker: worker }) => ({ id, worker })), metrics };
  } else if (phase === 'offline') {
    await api.until<Operations>('/api/runs/operations', ops => ops.cloudState === 'stopped' &&
      ops.workers.every(item => item.target !== 'local' || !item.healthy), 'both laptop workers to disconnect');
    const waiting = await api.submit(sample, { deadlineSeconds: 240, budget: '0' });
    const queued = await api.until<Detail>(`/api/jobs/${waiting.id}`, job => job.status === 'QUEUED' &&
      job.decision?.reason === 'job_budget' && job.target === null, 'the zero-budget job to wait for local capacity');
    const submitted = await api.submit(sample, { deadlineSeconds: 120, budget: '0.030', priority: 'high' });
    const cloud = await api.result(submitted.id, 'ec2');
    assert.equal(cloud.publishedBeforeDeadline, true);
    const metrics = await api.stopped(submitted.run_id, cloud.winning);
    const stillQueued = await api.json<Detail>(`/api/jobs/${waiting.id}`);
    assert.equal(stillQueued.status, 'QUEUED');
    assert.equal(stillQueued.decision?.reason, 'job_budget');
    evidence = { queued, stillQueued, cloud, metrics };
  } else {
    const offline = JSON.parse(await readFile(`${output}/offline.json`, 'utf8'));
    const connected = JSON.parse(await readFile(`${output}/connected.json`, 'utf8'));
    const local = await api.result(connected.local.job.id, 'local');
    assert.equal(local.checksum, connected.local.checksum);
    const cloud = await api.result(offline.cloud.job.id, 'ec2');
    assert.equal(cloud.checksum, offline.cloud.checksum);
    const queued = await api.json<Detail>(`/api/jobs/${offline.queued.id}`);
    assert.equal(queued.created_at, offline.queued.created_at);
    evidence = { local, cloud, queued };
  }
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/${phase}.json`, JSON.stringify({ at: new Date().toISOString(), ...evidence }, null, 2));
  console.log(`Hosted ${phase} verification passed.`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Hosted verification failed.'); process.exitCode = 1; });
