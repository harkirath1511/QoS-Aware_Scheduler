import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { workerGrants } from '../src/artifacts';
import { observeInstance, verifyRegistration } from '../src/cloud';

test('EC2 stop observations only use valid transition timestamps', () => {
  const reason = 'User initiated (2026-11-25 06:54:22 GMT)';
  const time = Date.parse('2026-11-25T06:54:22Z');
  assert.deepEqual(observeInstance('stopped', reason), { state: 'stopped', exitedRunningAt: time });
  assert.deepEqual(observeInstance('stopping', reason), { state: 'stopping', exitedRunningAt: time });
  assert.deepEqual(observeInstance('running', reason), { state: 'running' });
  assert.deepEqual(observeInstance('stopped', 'User initiated (2026-02-30 06:54:22 GMT)'), { state: 'stopped' });
  assert.deepEqual(observeInstance('stopped', ''), { state: 'stopped' });
});

test('EC2 registration checks the signed document and the exact expected worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qos-iid-'));
  const keyfile = join(directory, 'public.pem');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  try {
    await writeFile(keyfile, publicKey.export({ type: 'spki', format: 'pem' }));
    const identity = { accountId: '123456789012', region: 'ap-south-1', instanceId: 'i-01234567890123456' };
    const imageDigest = `sha256:${'a'.repeat(64)}`;
    Object.assign(process.env, {
      AWS_REGION: identity.region, AWS_S3_BUCKET: 'qos-adapter-verification',
      EC2_INSTANCE_ID: identity.instanceId, EC2_ACCOUNT_ID: identity.accountId,
      EC2_IDENTITY_CERT: keyfile, EC2_IMAGE_DIGEST: imageDigest,
      EC2_RATE_USD_HOUR: '0.12', EC2_RATE_SOURCE: 'https://aws.amazon.com/ec2/pricing/on-demand/',
      EC2_RATE_DATE: '2026-11-25', CLOUDWATCH_LOG_GROUP: '/ucs531/scheduler',
    });
    const document = JSON.stringify(identity);
    const signature = sign('RSA-SHA256', Buffer.from(document), privateKey).toString('base64');
    assert.deepEqual(await verifyRegistration({ document, signature, imageDigest }), { instanceId: identity.instanceId, imageDigest });
    await assert.rejects(verifyRegistration({ document: document.replace('ap-south-1', 'eu-west-1'), signature, imageDigest }), { status: 403 });
    await assert.rejects(verifyRegistration({ document, signature, imageDigest: `sha256:${'b'.repeat(64)}` }), { status: 403 });
    const wrongDocument = JSON.stringify({ ...identity, instanceId: 'i-00000000000000000' });
    const wrongSignature = sign('RSA-SHA256', Buffer.from(wrongDocument), privateKey).toString('base64');
    await assert.rejects(verifyRegistration({ document: wrongDocument, signature: wrongSignature, imageDigest }), { status: 403 });

    // Static fixture credentials exercise URL generation locally without an AWS call.
    process.env.AWS_ACCESS_KEY_ID = 'fixture-access';
    process.env.AWS_SECRET_ACCESS_KEY = 'fixture-secret-for-local-signing';
    delete process.env.AWS_SESSION_TOKEN;
    const job = randomUUID();
    const attempt = randomUUID();
    const URLs = await workerGrants(job, attempt);
    const input = new URL(URLs.inputUrl);
    const output = new URL(URLs.outputUrl);
    assert.match(input.pathname, new RegExp(`/inputs/${job}/recording\\.csv$`));
    assert.match(output.pathname, new RegExp(`/attempts/${job}/${attempt}\\.json$`));
    assert.equal(output.searchParams.get('X-Amz-Expires'), '210');
    assert.match(output.searchParams.get('X-Amz-SignedHeaders') ?? '', /if-none-match/);
    assert.equal(output.searchParams.has('x-amz-checksum-crc32'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
