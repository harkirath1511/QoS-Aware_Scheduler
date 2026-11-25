import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateToken, authenticateWorker, requireAccount, sameOrigin, session, sessionName } from './auth';
import { boundedBody, downloadUrl, inputKey, maxResultBytes, outputKey, putArtifact, readArtifact, workerGrants } from './artifacts';
import { registration, verifyRegistration } from './cloud';
import { db, event, transaction } from './db';
import { checksum, Fault, jobInput, limits, policies, sha256 } from './domain';
import { claim, currentAttempt, endRun, finishAttempt, heartbeat, admit, ownedJob, register, startRun, submit } from './jobs';
import { getRunMetrics, operatorSnapshot, runSummaries } from './metrics';
import { samplesFromCsv } from './vibration';

const uuid = z.uuid();
const noStore = { 'Cache-Control': 'no-store' };
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: noStore });
const empty = () => new Response(null, { status: 204, headers: noStore });

async function readJson<T>(request: Request, schema: z.ZodType<T>, size = 32_768) {
  const bytes = await boundedBody(request, size);
  let data: unknown;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Fault(400, 'Send a valid JSON body.'); }
  return schema.parse(data);
}

export async function handle(request: Request, parts: string[]) {
  try {
    if (parts.length === 1 && parts[0] === 'health' && request.method === 'GET') {
      await db().query('SELECT 1 FROM jobs LIMIT 1');
      return json({ status: 'ok' });
    }
    if (parts[0] === 'worker') return await workerRequest(request, parts.slice(1));
    if (parts.length === 1 && parts[0] === 'session') {
      sameOrigin(request);
      const jar = await cookies();
      if (request.method === 'DELETE') {
        jar.delete(sessionName);
        return empty();
      }
      if (request.method === 'POST') {
        const { token } = await readJson(request, z.object({ token: z.string().min(1).max(1024) }));
        const account = authenticateToken(token);
        if (!account) throw new Fault(401, 'The access token was rejected.');
        const signed = session(account);
        jar.set(sessionName, signed.value, {
          httpOnly: true, sameSite: 'lax', path: '/', maxAge: signed.maxAge,
          secure: process.env.COOKIE_SECURE === 'true',
        });
        return json(account);
      }
    }
    const cookie = (await cookies()).get(sessionName)?.value;
    const account = requireAccount(request, cookie, parts[0] === 'runs');
    if (parts[0] === 'jobs') return await jobRequest(request, parts.slice(1), account.id);
    if (parts[0] === 'runs') {
      if (parts.length === 1 && request.method === 'GET') return json(await runSummaries());
      if (parts.length === 2 && parts[1] === 'operations' && request.method === 'GET') return json(await operatorSnapshot());
      if (parts.length === 1 && request.method === 'POST') {
        const run = await readJson(request, z.object({
          label: z.string().min(1).max(100), policy: z.enum(policies), manifest: z.record(z.string(), z.unknown()),
        }), 128_000);
        return json(await startRun(run.label, run.policy, run.manifest), 201);
      }
      if (parts.length === 3 && parts[2] === 'metrics' && request.method === 'GET') {
        return json(await getRunMetrics(uuid.parse(parts[1])));
      }
      if (parts.length === 2 && parts[1] === 'finish' && request.method === 'POST') {
        const { id } = await readJson(request, z.object({ id: uuid }));
        await endRun(id);
        return empty();
      }
    }
    throw new Fault(404, 'Endpoint not found.');
  } catch (error) {
    if (error instanceof Fault) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return json({ error: error.issues.map(issue => [issue.path.join('.'), issue.message].filter(Boolean).join(' — ')).join(' ') }, 422);
    console.error('Request failed', { name: (error as Error)?.name, code: (error as { code?: string })?.code });
    return json({ error: 'The service could not finish the request. Try again.' }, 503);
  }
}

async function jobRequest(request: Request, parts: string[], owner: string) {
  if (!parts.length && request.method === 'POST') {
    const key = z.string().min(1).max(128).parse(request.headers.get('idempotency-key'));
    const response = await submit(owner, key, await readJson(request, jobInput));
    return json(response.job, response.created ? 201 : 200);
  }
  if (!parts.length && request.method === 'GET') {
    const parts = new URL(request.url).searchParams;
    const filter = z.object({
      state: z.enum(['AWAITING_INPUT', 'QUEUED', 'ASSIGNED', 'RUNNING', 'SUCCEEDED', 'FAILED']).optional(),
      priority: z.enum(['low', 'normal', 'high']).optional(), target: z.enum(['local', 'ec2']).optional(),
      offset: z.coerce.number().int().min(0).max(100_000).default(0),
    }).parse(Object.fromEntries(parts));
    const { rows } = await db().query(
      `SELECT * FROM jobs WHERE owner=$1 AND ($2::text IS NULL OR status=$2)
       AND ($3::text IS NULL OR spec->>'priority'=$3) AND ($4::text IS NULL OR target=$4)
       ORDER BY created_at DESC, id LIMIT 101 OFFSET $5`,
      [owner, filter.state ?? null, filter.priority ?? null, filter.target ?? null, filter.offset],
    );
    return json({ jobs: rows.slice(0, 100), nextOffset: rows.length > 100 ? filter.offset + 100 : null });
  }
  const id = uuid.parse(parts[0]);
  const job = await ownedJob(id, owner);
  if (parts.length === 1 && request.method === 'GET') {
    const { rows: attempts } = await db().query('SELECT * FROM attempts WHERE job_id=$1 ORDER BY number', [id]);
    return json({ ...job, attempts });
  }
  if (parts.length === 2 && parts[1] === 'input' && request.method === 'PUT') {
    const bytes = await boundedBody(request, limits.bytes);
    if (sha256(bytes) !== job.spec.inputSha256) throw new Fault(422, 'The uploaded CSV checksum differs from the submission.');
    if (job.queued_at !== null) return json(job);
    if (job.status !== 'AWAITING_INPUT' || Date.now() - job.created_at >= limits.uploadMs) throw new Fault(410, 'The input upload window expired.');
    const samples = samplesFromCsv(bytes);
    if (job.spec.maxLag >= samples.length) throw new Fault(422, 'Maximum lag must be below the sample count.');
    try {
      await putArtifact(inputKey(id), bytes, 'text/csv');
    } catch (error) {
      await transaction(client => event(client, id, Date.now(), 'input_upload_failed'));
      throw error;
    }
    return json(await admit(id, owner, bytes.length), 202);
  }
  if (parts.length === 2 && parts[1] === 'events' && request.method === 'GET') {
    return json((await db().query('SELECT id,at,kind,details FROM events WHERE job_id=$1 ORDER BY id', [id])).rows);
  }
  if (parts.length === 2 && parts[1] === 'result' && request.method === 'GET') {
    if (!job.winning_attempt_id) throw new Fault(409, 'A result has not been published.');
    if (new URL(request.url).searchParams.get('download') !== '1') {
      const remote = await downloadUrl(id, job.winning_attempt_id);
      if (remote) return new Response(null, { status: 303, headers: { ...noStore, Location: remote } });
    }
    const bytes = await readArtifact(outputKey(id, job.winning_attempt_id), maxResultBytes);
    return new Response(new Uint8Array(bytes), {
      headers: { ...noStore, 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${id}.json"` },
    });
  }
  throw new Fault(404, 'Endpoint not found.');
}

async function workerRequest(request: Request, parts: string[]) {
  const worker = authenticateWorker(request);
  if (parts.length === 1 && parts[0] === 'register' && request.method === 'POST') {
    const body = await readJson(request, registration);
    const proof = worker.target === 'ec2' ? await verifyRegistration(body) : {};
    await register({ ...worker, ...proof });
    return empty();
  }
  if (parts.length === 1 && parts[0] === 'claim' && request.method === 'POST') {
    const work = await claim(worker.id, worker.generation);
    if (!work) return empty();
    const { job, attempt } = work;
    return json({
      jobId: job.id, attemptId: attempt.id, spec: job.spec,
      executionUntil: attempt.started_at + limits.executionMs, leaseUntil: attempt.lease_until,
      ...await workerGrants(job.id, attempt.id),
    });
  }
  if (parts.length !== 3 || parts[0] !== 'attempts') throw new Fault(404, 'Endpoint not found.');
  const id = uuid.parse(parts[1]);
  const current = (allowSucceeded = false) => transaction(client =>
    currentAttempt(client, worker.id, worker.generation, id, Date.now(), allowSucceeded));
  if (parts[2] === 'heartbeat' && request.method === 'POST') {
    return json({ leaseUntil: await heartbeat(worker.id, worker.generation, id) });
  }
  if (parts[2] === 'artifact' && !process.env.AWS_S3_BUCKET) {
    const { job } = await current();
    if (request.method === 'GET') {
      return new Response(new Uint8Array(await readArtifact(inputKey(job.id), limits.bytes)), {
        headers: { ...noStore, 'Content-Type': 'text/csv' },
      });
    }
    if (request.method === 'PUT') {
      const bytes = await boundedBody(request, maxResultBytes);
      await putArtifact(outputKey(job.id, id), bytes, 'application/json');
      return empty();
    }
  }
  if (parts[2] === 'complete' && request.method === 'POST') {
    const body = await readJson(request, z.object({ checksum }));
    const { job, attempt } = await current(true);
    if (attempt.outcome === 'succeeded') {
      if (attempt.output_sha256 !== body.checksum) throw new Fault(409, 'The published result has a different checksum.');
      return empty();
    }
    const bytes = await readArtifact(outputKey(job.id, id), maxResultBytes);
    if (sha256(bytes) !== body.checksum) throw new Fault(422, 'The uploaded result checksum is invalid.');
    await transaction(async client => {
      const now = Date.now();
      const { job, attempt } = await currentAttempt(client, worker.id, worker.generation, id, now, true);
      if (attempt.outcome !== 'succeeded') await finishAttempt(client, job, attempt, now, body);
    });
    return empty();
  }
  if (parts[2] === 'fail' && request.method === 'POST') {
    const { failure } = await readJson(request, z.object({
      failure: z.enum(['input_fetch_failed', 'invalid_input', 'compute_failed', 'output_upload_failed', 'timed_out']),
    }));
    await transaction(async client => {
      const now = Date.now();
      const { job, attempt } = await currentAttempt(client, worker.id, worker.generation, id, now);
      await finishAttempt(client, job, attempt, now, { failure, transient: failure !== 'invalid_input' });
    });
    return empty();
  }
  throw new Fault(404, 'Endpoint not found.');
}
