import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { cloudWorker, localWorkers } from './controller';
import { Fault } from './domain';

const accounts = z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/), z.object({
  token: z.string().min(24), operator: z.boolean().default(false),
}));
type Account = { id: string; operator: boolean };
export const sessionName = 'qos_session';
const lifeSeconds = 8 * 60 * 60;

function configuredAccounts() {
  return accounts.parse(JSON.parse(process.env.DASHBOARD_ACCOUNTS ?? '{}'));
}

function equal(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export function bearer(request: Request) {
  return request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
}

export function authenticateToken(token: string | undefined): Account | null {
  if (!token) return null;
  for (const [id, account] of Object.entries(configuredAccounts())) {
    if (equal(account.token, token)) return { id, operator: account.operator };
  }
  return null;
}

function sign(payload: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('Set SESSION_SECRET to at least 32 characters.');
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function session(account: Account) {
  const data = `${account.id}.${Math.floor(Date.now() / 1000) + lifeSeconds}`;
  return { value: `${data}.${sign(data)}`, maxAge: lifeSeconds };
}

export function cookieAccount(value: string | undefined): Account | null {
  const match = value?.match(/^([\w-]{1,48})\.(\d+)\.([\w-]+)$/);
  if (!match) return null;
  const [, id, expiry, signature] = match;
  if (+expiry <= Date.now() / 1000 || !equal(signature, sign(`${id}.${expiry}`))) return null;
  const account = configuredAccounts()[id];
  return account && Object.hasOwn(configuredAccounts(), id) ? { id, operator: account.operator } : null;
}

export function sameOrigin(request: Request) {
  const supported = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (supported === 'cross-site' || origin === 'null') throw new Fault(403, 'Cross-origin request denied.');
  if (origin) {
    const expected = process.env.PUBLIC_ORIGIN;
    // Hosted reverse proxies may rewrite Host. Trust only the configured public origin.
    if (expected ? origin !== expected : new URL(origin).host !== host) {
      throw new Fault(403, 'Cross-origin request denied.');
    }
  }
}

export function requireAccount(request: Request, cookie?: string, operator = false) {
  const token = bearer(request);
  if (!token && request.method !== 'GET') sameOrigin(request);
  const account = token ? authenticateToken(token) : cookieAccount(cookie);
  if (!account) throw new Fault(401, 'Sign in to continue.');
  if (operator && !account.operator) throw new Fault(403, 'Operator access is required.');
  return account;
}

export function authenticateWorker(request: Request) {
  const id = request.headers.get('x-worker-id') ?? '';
  const generation = z.uuid().safeParse(request.headers.get('x-worker-generation'));
  const token = bearer(request);
  const envName = [...localWorkers, cloudWorker].includes(id) ? `WORKER_TOKEN_${id.toUpperCase().replace('-', '_')}` : '';
  const expected = envName ? process.env[envName] : undefined;
  if (!generation.success || !token || !expected || expected.length < 24 || !equal(token, expected)) {
    throw new Fault(401, 'Worker credentials rejected.');
  }
  return { id, generation: generation.data, target: id === cloudWorker ? 'ec2' as const : 'local' as const };
}
