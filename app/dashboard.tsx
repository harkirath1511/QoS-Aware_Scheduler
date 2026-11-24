'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Attempt, Job } from '../src/db';
import type { getRunMetrics, operatorSnapshot } from '../src/metrics';

type Account = { id: string; operator: boolean };
type RunMetrics = Awaited<ReturnType<typeof getRunMetrics>>;
type Ops = Awaited<ReturnType<typeof operatorSnapshot>>;
type Timeline = { id: number; at: number; kind: string; details: Record<string, unknown> }[];
type Detail = Job & { attempts: Attempt[] };
const states: Record<string, string> = {
  AWAITING_INPUT: 'Awaiting input', QUEUED: 'Queued', ASSIGNED: 'Assigned',
  RUNNING: 'Running', SUCCEEDED: 'Succeeded', FAILED: 'Failed',
};
const reasons: Record<string, string> = {
  local_meets_deadline: 'Local can finish before the deadline.',
  cloud_rescues_deadline: 'EC2 can meet the deadline that local would miss.',
  cloud_starts_earlier: 'EC2 can start sooner than the next local slot.',
  local_first: 'The baseline policy prefers local execution.',
  both_targets_late: 'Both targets are predicted to miss. The job will run locally.',
  cloud_only_available: 'EC2 is the only available execution target.',
  cloud_unavailable: 'EC2 capacity is unavailable.',
  job_budget: 'EC2 exceeds the remaining job budget.',
  run_budget: 'EC2 exceeds the remaining run budget.',
};
const targetLabel = (target: string | null) => target === 'ec2' ? 'EC2' : target === 'local' ? 'Local Docker' : '—';
const humanize = (label: string) => (label[0]?.toUpperCase() ?? '') + label.slice(1).replaceAll('_', ' ');
const money = (micros: number) => `$${(micros / 1_000_000).toFixed(6)}`;
const seconds = (ms: number | null) => ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`;
const date = (value: number | null) => value === null ? '—' : new Date(value).toLocaleString();
const rate = (hits: number, total: number) => total ? `${hits}/${total} (${Math.round(100 * hits / total)}%)` : '—';
const method = (verb: string, body: unknown, headers?: Record<string, string>) => ({
  method: verb, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers },
});

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (HTTP ${response.status}).`);
  }
  return response.status === 204 ? undefined as T : response.json();
}

function usePoll<T>(load: (signal: AbortSignal) => Promise<T>, interval = 3000) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await load(abort.signal);
        if (!abort.signal.aborted) { setValue(next); setError(''); }
      } catch (error) {
        if (!abort.signal.aborted) setError((error as Error).message);
      }
      if (!abort.signal.aborted) timer = setTimeout(refresh, interval);
    }
    void refresh();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [load, interval]);
  return { value, error };
}

function SignIn() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = new FormData(event.currentTarget).get('token');
    setBusy(true);
    setError('');
    try { await request('/api/session', method('POST', { token })); location.reload(); }
    catch (error) { setError((error as Error).message); setBusy(false); }
  }
  return <main className="login" id="content" tabIndex={-1}>
    <h1>Cloud QoS Scheduler</h1>
    <p>Sign in to submit and monitor batch jobs.</p>
    <form onSubmit={signIn} className="stack">
      <label htmlFor="token">Project access token</label>
      <input id="token" name="token" type="password" autoComplete="current-password" required />
      <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  </main>;
}

export function Dashboard({ account }: { account: Account | null }) {
  const [view, setView] = useState<'jobs' | 'new' | 'operator'>('jobs');
  const [job, setJob] = useState<string>();
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('job');
    if (id) setJob(id);
  }, []);
  if (!account) return <SignIn />;
  function navigate(view: 'jobs' | 'new' | 'operator', id?: string) {
    setView(view);
    setJob(id);
    history.replaceState(null, '', id ? `/?job=${encodeURIComponent(id)}` : '/');
  }
  return <>
    <a className="skip" href="#content">Skip to content</a>
    <header className="mast">
      <div className="shell mast-inner"><span className="wordmark">Cloud QoS Scheduler</span>
        <nav aria-label="Dashboard">
          <button className="nav" aria-current={view === 'jobs' ? 'page' : undefined} onClick={() => navigate('jobs')}>Jobs</button>
          {account.operator && <button className="nav" aria-current={view === 'operator' ? 'page' : undefined} onClick={() => navigate('operator')}>Operations</button>}
        </nav>
        <button className="secondary" onClick={() => { void request('/api/session', { method: 'DELETE' }).then(() => location.reload()); }}>Sign out</button>
      </div>
    </header>
    <main id="content" tabIndex={-1} className="shell workspace">
      {view === 'operator' ? <Operations /> : view === 'new' ?
        <NewJob onDone={id => navigate('jobs', id)} onCancel={() => navigate('jobs')} /> :
        job ? <JobDetail key={job} id={job} onBack={() => navigate('jobs')} /> :
        <Jobs onOpen={id => navigate('jobs', id)} onNew={() => navigate('new')} />}
    </main>
  </>;
}

function Jobs({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const [filters, setFilters] = useState({ state: '', priority: '', target: '' });
  const [offset, setOffset] = useState(0);
  const load = useCallback((signal: AbortSignal) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    params.set('offset', String(offset));
    return request<{ jobs: Job[]; nextOffset: number | null }>(`/api/jobs?${params}`, { signal });
  }, [filters, offset]);
  const { value, error } = usePoll(load);
  const jobs = value?.jobs ?? [];
  return <>
    <div className="page-head"><div><h1>Jobs</h1><p>Submit a recording and follow it from the queue to a verified result.</p></div>
      <button onClick={onNew}>Submit job</button></div>
    <div className="filters">
      {Object.entries({ state: states, priority: { high: 'High', normal: 'Normal', low: 'Low' }, target: { local: 'Local Docker', ec2: 'EC2' } }).map(([field, options]) => {
        const key = field as keyof typeof filters;
        return <label key={field}>{humanize(field)}
          <select value={filters[key]} onChange={event => { setOffset(0); setFilters({ ...filters, [key]: event.target.value }); }}>
            <option value="">All</option>
            {Object.entries(options).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>;
      })}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="table-wrap" role="region" aria-labelledby="job-caption" tabIndex={0}>
      <table><caption id="job-caption">Job history</caption><thead><tr>
        {['Job ID', 'State', 'Priority', 'Target', 'Deadline', 'Queued'].map(label => <th key={label} scope="col">{label}</th>)}
      </tr></thead><tbody>
        {jobs.map(job => <tr key={job.id}>
          <th scope="row"><button className="text-button mono" onClick={() => onOpen(job.id)}>{job.id.slice(0, 8)}</button></th>
          <td><Status job={job} /></td><td>{humanize(job.spec.priority)}</td>
          <td>{targetLabel(job.target)}</td><td>{date(Date.parse(job.spec.deadline))}</td><td>{date(job.queued_at)}</td>
        </tr>)}
        {!jobs.length && <tr><td colSpan={6} className="empty">{value ? 'No jobs match these filters.' : 'Loading jobs…'}</td></tr>}
      </tbody></table>
    </div>
    {(offset > 0 || value?.nextOffset != null) && <div className="actions">
      <button className="secondary" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous</button>
      <button className="secondary" disabled={value?.nextOffset == null} onClick={() => setOffset(offset + 100)}>Next</button>
    </div>}
  </>;
}

function Status({ job }: { job: Job }) {
  return <span className="status" data-state={job.status}>
    {job.status === 'ASSIGNED' && job.target === 'ec2' ? 'Awaiting EC2' :
      job.status === 'QUEUED' && job.failure ? 'Queued again' : states[job.status]}
  </span>;
}

function NewJob({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string>();
  const draft = useRef<{ payload: string; key: string } | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const recording = fields.get('recording') as File;
    setBusy(true);
    setError('');
    setCreated(undefined);
    try {
      if (recording.size > 2 * 1024 * 1024) throw new Error('Select a CSV under 2 MiB.');
      const bytes = new Uint8Array(await recording.arrayBuffer());
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      const inputSha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      const payload = JSON.stringify({
        type: 'vibration-v1', sampleRate: Number(fields.get('sampleRate')),
        minLag: Number(fields.get('minLag')), maxLag: Number(fields.get('maxLag')),
        priority: fields.get('priority'), expectedSeconds: Number(fields.get('expectedSeconds')),
        deadline: new Date(String(fields.get('deadline'))).toISOString(), budgetUsd: fields.get('budgetUsd'), inputSha256,
      });
      if (draft.current?.payload !== payload) draft.current = { payload, key: crypto.randomUUID() };
      const job = await request<Job>('/api/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': draft.current.key },
        body: payload,
      });
      setCreated(job.id);
      await request(`/api/jobs/${job.id}/input`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'text/csv' } });
      onDone(job.id);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <>
    <button className="text-button" onClick={onCancel}>Back to jobs</button>
    <div className="page-head"><div><h1>Submit a job</h1><p>Find the strongest period in a vibration recording.</p></div></div>
    <form onSubmit={submit} className="panel stack narrow">
      <label htmlFor="recording">Recording (CSV)</label>
      <input id="recording" name="recording" type="file" accept=".csv,text/csv" required aria-describedby="recording-help" />
      <small id="recording-help">One signed 16-bit sample per row. Up to 2 MiB.</small>
      <fieldset className="field-grid"><legend>Analysis</legend>
        <label>Sample rate (Hz)<input name="sampleRate" type="number" min="1" defaultValue="1000" required /></label>
        <label>Minimum lag<input name="minLag" type="number" min="1" defaultValue="2" required /></label>
        <label>Maximum lag<input name="maxLag" type="number" min="1" defaultValue="4" required /></label>
      </fieldset>
      <fieldset className="field-grid"><legend>Scheduling</legend>
        <label>Priority<select name="priority" defaultValue="normal"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label>
        <label>Expected local runtime (seconds)<input name="expectedSeconds" type="number" min="1" max="180" step="any" defaultValue="10" required /></label>
        <label>Deadline (your local time)<input name="deadline" type="datetime-local" required /></label>
        <label>Cloud budget (USD)<input name="budgetUsd" type="number" min="0" step="0.000001" defaultValue="0" required /></label>
      </fieldset>
      {error && <p role="alert" className="error">{error}</p>}
      {created && error && <button type="button" className="text-button" onClick={() => onDone(created)}>Open saved submission</button>}
      <div className="actions"><button disabled={busy}>{busy ? 'Uploading…' : 'Queue job'}</button></div>
    </form>
  </>;
}

function JobDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [load] = useState(() => async (signal: AbortSignal) => {
    const [job, events] = await Promise.all([
      request<Detail>(`/api/jobs/${id}`, { signal }), request<Timeline>(`/api/jobs/${id}/events`, { signal }),
    ]);
    return { job, events };
  });
  const { value, error } = usePoll(load);
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  async function retry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUploading(true);
    try {
      const file = new FormData(event.currentTarget).get('recording') as File;
      await request(`/api/jobs/${id}/input`, { method: 'PUT', body: file });
      setUploadError('');
    } catch (error) { setUploadError((error as Error).message); }
    finally { setUploading(false); }
  }
  const job = value?.job;
  const decision = job?.decision;
  return <>
    <button className="text-button" onClick={onBack}>Back to jobs</button>
    <div className="page-head"><div><h1>Job <span className="mono">{id.slice(0, 8)}</span></h1>
      {job && <><Status job={job} /> <span className="muted">{targetLabel(job.target)}</span></>}</div>
      {job?.winning_attempt_id && <a className="button" href={`/api/jobs/${id}/result`}>Download result</a>}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {!job ? <p>{error ? 'Job details unavailable.' : 'Loading job…'}</p> : <>
      {job.status === 'AWAITING_INPUT' && <form className="panel actions" onSubmit={retry}>
        <label>Upload the original CSV<input type="file" name="recording" accept=".csv,text/csv" required /></label>
        <button disabled={uploading}>Retry upload</button>{uploadError && <p role="alert" className="error">{uploadError}</p>}
      </form>}
      {job.failure && <p className="error" role="status">{humanize(job.failure)}.</p>}
      <div className="detail-grid">
        <section className="panel">
          <h2>Placement decision</h2>
          {decision ? <>
            <p>{reasons[decision.reason] ?? humanize(decision.reason)}</p>
            {decision.deadlineRisk && <p className="warning">The result is at risk of missing the deadline.</p>}
            <dl><dt>Policy and queue rank</dt><dd>{decision.policy.toUpperCase()} / {decision.rank}</dd>
              <dt>Local finish</dt><dd>{date(decision.localFinish)}</dd>
              <dt>EC2 finish</dt><dd>{date(decision.cloudFinish)}</dd>
              <dt>Estimated EC2 compute</dt><dd>{money(decision.cloudExpectedMicros)}</dd>
              <dt>EC2 reservation</dt><dd>{money(decision.cloudReservationMicros)}</dd>
              <dt>Remaining job budget at decision</dt><dd>{money(decision.jobRemainingMicros)}</dd>
            </dl>
          </> : <p className="muted">A decision appears after the input is queued.</p>}
        </section>
        <section className="panel"><h2>Job details</h2>
          <dl><dt>Deadline</dt><dd>{date(Date.parse(job.spec.deadline))}</dd>
            <dt>Deadline outcome</dt><dd>{job.terminal_at === null ? 'Pending' : job.status === 'SUCCEEDED' && job.terminal_at <= Date.parse(job.spec.deadline) ? 'Met' : 'Missed'}</dd>
            <dt>Priority</dt><dd>{humanize(job.spec.priority)}</dd>
            <dt>Queued</dt><dd>{date(job.queued_at)}</dd><dt>First claim</dt><dd>{date(job.first_started_at)}</dd>
            <dt>Finished</dt><dd>{date(job.terminal_at)}</dd><dt>EC2 cost attributed to job</dt><dd>{money(job.spent_micros)}</dd></dl>
        </section>
      </div>
      <section className="panel"><h2>Attempts</h2>
        {!job.attempts.length ? <p className="muted">No worker has claimed this job.</p> :
          <div className="attempts">{job.attempts.map(attempt => <article key={attempt.id}>
            <h3>Attempt {attempt.number} <span className="muted">{targetLabel(attempt.target)}</span></h3>
            <dl><dt>Worker</dt><dd>{attempt.worker_id}</dd><dt>Instance</dt><dd>{attempt.instance_id ?? '—'}</dd>
              <dt>Outcome</dt><dd>{humanize(attempt.failure ?? attempt.outcome ?? 'running')}</dd>
              <dt>Started</dt><dd>{date(attempt.started_at)}</dd><dt>Ended</dt><dd>{date(attempt.ended_at)}</dd>
              <dt>Attempt ID</dt><dd className="mono">{attempt.id}</dd>
              {attempt.image_digest && <><dt>Image digest</dt><dd className="mono">{attempt.image_digest}</dd></>}
              {attempt.output_sha256 && <><dt>Result SHA-256</dt><dd className="mono">{attempt.output_sha256}</dd></>}</dl>
          </article>)}</div>}
      </section>
      <section className="panel"><h2>Job timeline</h2><ol className="timeline">
        {value?.events.map(event => <li key={event.id}><time>{date(event.at)}</time><div><strong>{humanize(event.kind)}</strong>
          {typeof event.details.reason === 'string' && <p>{reasons[event.details.reason] ?? humanize(event.details.reason)}</p>}
          {typeof event.details.failure === 'string' && <p>{humanize(event.details.failure)}</p>}</div></li>)}
      </ol></section>
    </>}
  </>;
}

const loadOperations = (signal: AbortSignal) => Promise.all([
  request<RunMetrics[]>('/api/runs', { signal }), request<Ops>('/api/runs/operations', { signal }),
]);
function Operations() {
  const { value, error } = usePoll(loadOperations, 5000);
  const [runs, ops] = value ?? [[], undefined];
  const session = ops?.capacity;
  const cloudState = session?.stop_requested_at ? 'Stopping' : session?.ready_at ? 'Ready' : session ? 'Starting' : 'No active session';
  const workloadRun = runs.find(run => !run.run.ended_at);
  return <>
    <div className="page-head"><div><h1>Operations</h1><p>Live capacity and policy evaluation.</p></div></div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="stats">
      <div><span>Queued</span><strong>{ops?.queued ?? '—'}</strong></div>
      <div><span>Running</span><strong>{ops?.running ?? '—'}</strong></div>
      <div><span>Oldest wait</span><strong>{ops ? seconds(ops.oldestWaitMs) : '—'}</strong></div>
      <div><span>EC2 capacity</span><strong>{ops ? cloudState : '—'}</strong></div>
    </div>
    <section className="panel"><h2>Workers</h2>
      {!ops?.workers.length ? <p className="muted">No workers have registered.</p> :
        <ul className="workers">{ops.workers.map(worker => <li key={worker.id}>
          <strong>{worker.id}</strong><span>{worker.healthy ? 'Healthy' : 'Offline'}</span><span>{date(worker.seen_at)}</span>
        </li>)}</ul>}
      {workloadRun && <p>Current estimated EC2 compute spend <strong>{money(workloadRun.cloud.computeMicros)}</strong></p>}
      {!!ops?.telemetryPending && <p className="muted">Pending CloudWatch records {ops.telemetryPending}</p>}
    </section>
    <div className="table-wrap" role="region" aria-labelledby="run-caption" tabIndex={0}>
      <table><caption id="run-caption">Policy runs</caption><thead><tr>
        {['Run', 'Policy', 'Avg. wait', 'P95 wait', 'Deadline hit', 'High-priority hit', 'Median finish', 'Makespan', 'EC2 jobs', 'EC2 compute'].map(label => <th key={label} scope="col">{label}</th>)}
      </tr></thead><tbody>
        {runs.map(run => <tr key={run.run.id}><th scope="row"><a href={`/api/runs/${run.run.id}/metrics`}>{run.run.label}</a></th>
          <td>{run.run.policy.toUpperCase()}</td><td>{seconds(run.queueWaitMs.mean)}</td><td>{seconds(run.queueWaitMs.p95)}</td>
          <td>{rate(run.deadlines.hits, run.deadlines.denominator)}</td><td>{rate(run.deadlines.highHits, run.deadlines.highDenominator)}</td>
          <td>{seconds(run.completionMs.median)}</td><td>{seconds(run.makespanMs)}</td><td>{run.cloud.successes}</td>
          <td>{money(run.cloud.computeMicros)}</td></tr>)}
        {!runs.length && <tr><td colSpan={10} className="empty">No runs recorded.</td></tr>}
      </tbody></table>
    </div>
  </>;
}
