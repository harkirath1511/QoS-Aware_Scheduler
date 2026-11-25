import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const labels = ['session', 'operator', 'student', 'local-1', 'local-2', 'database'] as const;
type Label = typeof labels[number];

function credentials(seed: string) {
  if (!/^[a-zA-Z0-9]{64}$/.test(seed)) throw new Error('Invalid hosted runtime seed.');
  return (label: Label) => createHmac('sha256', seed).update(`ucs531/hosted/v1/${label}`).digest('base64url');
}

function runtimeEnvironment(input: string) {
  const { seed, burstToken } = JSON.parse(input) as { seed: string; burstToken: string };
  const derive = credentials(seed.trim());
  if (!/^[a-zA-Z0-9]{48}$/.test(burstToken.trim())) throw new Error('Invalid burst worker token.');
  const host = process.env.RDS_HOST;
  if (!host || !/^[a-z0-9.-]+$/.test(host)) throw new Error('Invalid database hostname.');
  const database = new URL(`postgresql://scheduler_app@${host}:5432/scheduler`);
  database.password = derive('database');
  database.searchParams.set('sslmode', 'verify-full');
  database.searchParams.set('sslrootcert', '/app/certs/rds.pem');
  const env = {
    DATABASE_URL: database.toString(),
    SESSION_SECRET: derive('session'),
    DASHBOARD_ACCOUNTS: JSON.stringify({
      operator: { token: derive('operator'), operator: true },
      student: { token: derive('student'), operator: false },
    }),
    WORKER_TOKEN_LOCAL_1: derive('local-1'),
    WORKER_TOKEN_LOCAL_2: derive('local-2'),
    WORKER_TOKEN_EC2_1: burstToken.trim(),
  };
  for (const [name, value] of Object.entries(env)) process.stdout.write(`${name}=${value}\n`);
}

async function initializeDatabase(input: string) {
  const master = JSON.parse(input) as { username: string; password: string };
  const application = new URL(process.env.DATABASE_URL!);
  const admin = new URL(application);
  admin.username = encodeURIComponent(master.username);
  admin.password = encodeURIComponent(master.password);
  const db = new Client({ connectionString: admin.toString(), connectionTimeoutMillis: 10_000 });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(531, 3)');
    const role = await db.query("SELECT 1 FROM pg_roles WHERE rolname = 'scheduler_app'");
    if (!role.rowCount) await db.query('CREATE ROLE scheduler_app LOGIN');
    const password = decodeURIComponent(application.password);
    const { rows: [command] } = await db.query<{ sql: string }>(
      "SELECT format('ALTER ROLE scheduler_app PASSWORD %L', $1::text) AS sql", [password],
    );
    await db.query(command.sql);
    await db.query('GRANT CONNECT ON DATABASE scheduler TO scheduler_app');
    await db.query('GRANT USAGE, CREATE ON SCHEMA public TO scheduler_app');
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
}

async function main() {
  const mode = process.argv[2];
  const input = readFileSync(0, 'utf8');
  if (mode === 'runtime') return runtimeEnvironment(input);
  if (mode === 'init-db') return initializeDatabase(input);
  const derive = credentials(input.trim());
  if (mode === 'workers') {
    process.stdout.write(`WORKER_TOKEN_LOCAL_1=${derive('local-1')}\nWORKER_TOKEN_LOCAL_2=${derive('local-2')}\n`);
  } else if (mode === 'operator' || mode === 'student') {
    process.stdout.write(derive(mode));
  } else {
    throw new Error('Invalid hosted secrets command.');
  }
}

main().catch(error => {
  // SQL connection strings and statements can include passwords. Emit only safe diagnostics.
  console.error(JSON.stringify({ kind: 'hosted_secrets_failed', mode: process.argv[2], code: (error as { code?: string }).code }));
  process.exitCode = 1;
});
