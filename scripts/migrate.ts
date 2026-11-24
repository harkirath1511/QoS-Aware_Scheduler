import { readdir, readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { transaction, db } from '../src/db';

if (existsSync('.env')) loadEnvFile('.env');

async function main() {
  const files = (await readdir('db')).filter(file => /^\d+_.+\.sql$/.test(file)).sort();
  for (const file of files) {
    const schema = await readFile(`db/${file}`, 'utf8');
    await transaction(client => client.query(schema));
  }
  console.log('Database schema ready.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db().end());
