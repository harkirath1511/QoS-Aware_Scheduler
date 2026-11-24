import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const secret = () => randomBytes(32).toString('hex');
const accounts = { operator: { token: secret(), operator: true }, student: { token: secret(), operator: false } };
const content = [
  `POSTGRES_PASSWORD=${secret()}`,
  `SESSION_SECRET=${secret()}`,
  `DASHBOARD_ACCOUNTS='${JSON.stringify(accounts)}'`,
  `WORKER_TOKEN_LOCAL_1=${secret()}`,
  `WORKER_TOKEN_LOCAL_2=${secret()}`,
  'POLICY=qos',
  '',
].join('\n');

writeFile('.env', content, { flag: 'wx', mode: 0o600 }).then(() => {
  console.log('Created .env. Open it to find the operator and student access tokens.');
}).catch(error => {
  console.error(error.code === 'EEXIST' ? '.env already exists.' : error.message);
  process.exitCode = 1;
});
