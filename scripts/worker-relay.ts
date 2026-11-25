import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as requestHttp } from 'node:http';
import { createServer } from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

const [certPath, keyPath, sshConfig, appPortArg, relayPortArg = '38444'] = process.argv.slice(2);
if (!certPath || !keyPath || !sshConfig || !appPortArg) {
  throw new Error('Usage: worker-relay <cert> <key> <ssh-config> <local-api-port> [tls-port]');
}
const port = z.coerce.number().int().min(1024).max(65535);
const appPort = port.parse(appPortArg);
const relayPort = port.parse(relayPortArg);
const workerPath = /^\/api\/worker\/(?:register|claim|attempts\/[0-9a-f-]{36}\/(?:heartbeat|complete|fail))$/;

const server = createServer({
  cert: readFileSync(certPath), key: readFileSync(keyPath), minVersion: 'TLSv1.2',
}, (incoming, response) => {
  if (incoming.method !== 'POST' || !incoming.url || !workerPath.test(incoming.url)) {
    response.writeHead(404).end();
    return;
  }
  const { authorization, 'x-worker-id': workerId, 'x-worker-generation': generation,
    'content-type': type, 'content-length': length } = incoming.headers;
  const upstream = requestHttp({
    host: '127.0.0.1', port: appPort, method: 'POST', path: incoming.url,
    headers: Object.fromEntries(Object.entries({
      authorization, 'x-worker-id': workerId, 'x-worker-generation': generation,
      'content-type': type, 'content-length': length,
    }).filter(([, value]) => value !== undefined)),
    timeout: 10_000,
  }, result => {
    const headers = { ...result.headers };
    delete headers.connection;
    delete headers['transfer-encoding'];
    response.writeHead(result.statusCode ?? 502, headers);
    result.pipe(response);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => {
    if (response.headersSent) response.destroy();
    else response.writeHead(502).end();
  });
  incoming.on('aborted', () => upstream.destroy());
  incoming.pipe(upstream);
});

const shutdown = new AbortController();
let tunnel: ReturnType<typeof spawn> | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    shutdown.abort();
    tunnel?.kill();
    server.close();
  });
}
server.on('error', error => {
  console.error(error.message);
  shutdown.abort();
  tunnel?.kill();
  process.exitCode = 1;
});

server.listen(relayPort, '127.0.0.1', async () => {
  console.log(`TLS worker relay listening on loopback port ${relayPort}.`);
  while (!shutdown.signal.aborted) {
    await new Promise<void>(resolve => {
      tunnel = spawn('ssh', ['-F', sshConfig, '-N', '-T', 'qos-ec2'], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
      tunnel.once('error', error => { console.error(error.message); resolve(); });
      tunnel.once('close', () => resolve());
    });
    await sleep(5000, undefined, { signal: shutdown.signal }).catch(() => undefined);
  }
});
