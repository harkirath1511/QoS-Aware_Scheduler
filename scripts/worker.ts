import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { limits, sha256, type JobInput } from '../src/domain';

if (existsSync('.env')) loadEnvFile('.env');

interface Work {
  jobId: string;
  attemptId: string;
  spec: JobInput;
  inputUrl: string;
  outputUrl: string;
  executionUntil: number;
  leaseUntil: number;
}

type Failure = 'input_fetch_failed' | 'invalid_input' | 'compute_failed' | 'output_upload_failed' | 'timed_out';
class StageFailure extends Error {
  constructor(public code: Failure) { super(code); }
}

const id = process.env.WORKER_ID;
const token = process.env.WORKER_TOKEN;
const api = process.env.WORKER_API_URL;
if (!id || !token || !api) throw new Error('Set WORKER_ID, WORKER_TOKEN and WORKER_API_URL.');
const base = new URL(api);
if (id === 'ec2-1' && base.protocol !== 'https:') throw new Error('EC2 worker requires HTTPS.');
const generation = randomUUID();
const headers = { Authorization: `Bearer ${token}`, 'x-worker-id': id, 'x-worker-generation': generation };
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown.abort());

async function markControllerContact() {
  const path = process.env.WORKER_CONTACT_FILE;
  if (path) await writeFile(path, String(Date.now()), { mode: 0o600 });
}

async function request(path: string, options: RequestInit = {}) {
  const signal = AbortSignal.any([options.signal ?? shutdown.signal, AbortSignal.timeout(8000)]);
  const response = await fetch(new URL(path, base), {
    ...options, signal, redirect: 'error', headers: { ...headers, ...options.headers },
  });
  if (response.ok) await markControllerContact();
  return response;
}

function post(path: string, body?: object, signal?: AbortSignal) {
  return request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal,
  });
}

async function artifact(url: string, options: RequestInit) {
  if (url.startsWith('/api/worker/attempts/')) return request(url, options);
  const remote = new URL(url);
  if (remote.protocol !== 'https:') throw new Error('Artifact grants require HTTPS.');
  return fetch(remote, { ...options, redirect: 'error' });
}

function compute(input: Buffer, spec: JobInput, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // The analysis process receives only the CSV and fixed analysis parameters.
    const analysis = spawn(process.execPath, ['--import', 'tsx', 'scripts/compute.ts', JSON.stringify(spec)], {
      env: {}, stdio: ['pipe', 'pipe', 'pipe'], signal, windowsHide: true, killSignal: 'SIGKILL',
    });
    const output: Buffer[] = [];
    analysis.stdout.on('data', chunk => output.push(chunk));
    analysis.stderr.resume();
    analysis.stdin.on('error', reject);
    analysis.on('error', reject);
    analysis.on('close', code => {
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new StageFailure(code === 2 ? 'invalid_input' : 'compute_failed'));
    });
    analysis.stdin.end(input);
  });
}

async function run(work: Work) {
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, shutdown.signal, AbortSignal.timeout(Math.max(1, work.executionUntil - Date.now()))]);
  const path = `/api/worker/attempts/${work.attemptId}`;
  let leaseUntil = work.leaseUntil;
  const renew = async () => {
    while (!signal.aborted) {
      await sleep(limits.heartbeatMs, undefined, { signal });
      try {
        const response = await post(`${path}/heartbeat`, undefined, signal);
        if (response.ok) leaseUntil = (await response.json()).leaseUntil;
        else if (response.status === 409 || response.status === 401) return stop.abort();
      } catch { /* Use the last acknowledged lease expiry. */ }
      if (Date.now() + limits.heartbeatMs >= leaseUntil) return stop.abort();
    }
  };
  const renewal = renew().catch(() => undefined);
  const evidence = { workerId: id, jobId: work.jobId, attemptId: work.attemptId, imageDigest: process.env.WORKER_IMAGE_DIGEST, inputSha256: work.spec.inputSha256 };
  console.log(JSON.stringify({ kind: 'attempt_started', at: Date.now(), ...evidence }));
  let stage: Failure = 'input_fetch_failed';
  try {
    const response = await artifact(work.inputUrl, { signal });
    if (!response.ok) throw new StageFailure(stage);
    const input = Buffer.from(await response.arrayBuffer());
    if (input.length > limits.bytes) throw new StageFailure(stage);
    stage = 'compute_failed';
    const result = await compute(input, work.spec, signal);
    stage = 'output_upload_failed';
    const checksum = sha256(result);
    for (let trial = 0; trial < 3; trial++) {
      try {
        const upload = await artifact(work.outputUrl, {
          method: 'PUT', signal, body: new Uint8Array(result), headers: { 'If-None-Match': '*' },
        });
        if (!upload.ok && upload.status !== 412) throw new StageFailure(stage);
        const complete = await post(`${path}/complete`, { checksum }, signal);
        if (complete.ok) {
          console.log(JSON.stringify({ kind: 'attempt_published', at: Date.now(), checksum, ...evidence }));
          return;
        }
        if (complete.status === 409) return;
        throw new StageFailure(stage);
      } catch (error) {
        if (trial === 2 || signal.aborted) throw error;
        await sleep(500 * (trial + 1), undefined, { signal });
      }
    }
  } catch (error) {
    const failure = Date.now() >= work.executionUntil ? 'timed_out' : error instanceof StageFailure ? error.code : stage;
    console.error(JSON.stringify({ kind: failure, at: Date.now(), ...evidence }));
    if (!stop.signal.aborted && !shutdown.signal.aborted) await post(`${path}/fail`, { failure }).catch(() => undefined);
  } finally {
    stop.abort();
    await renewal;
  }
}

async function main() {
  const proof = id === 'ec2-1' ? {
    document: await readFile(process.env.WORKER_IDENTITY_DOCUMENT!, 'utf8'),
    signature: (await readFile(process.env.WORKER_IDENTITY_SIGNATURE!, 'utf8')).trim(),
    imageDigest: process.env.WORKER_IMAGE_DIGEST,
  } : {};
  let registered = false;
  while (!shutdown.signal.aborted) {
    try {
      if (!registered) {
        const registration = await post('/api/worker/register', proof);
        if (!registration.ok) throw new Error(`Registration returned HTTP ${registration.status}.`);
        registered = true;
      }
      const response = await post('/api/worker/claim');
      if (response.status === 409) registered = false;
      else if (response.status === 200) await run(await response.json());
      else if (response.status !== 204) throw new Error(`Claim returned HTTP ${response.status}.`);
    } catch (error) {
      if (!shutdown.signal.aborted) console.error((error as Error).message);
    }
    await sleep(1000, undefined, { signal: shutdown.signal }).catch(() => undefined);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
