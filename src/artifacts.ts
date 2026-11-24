import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config';
import { Fault, limits, sha256 } from './domain';

export const inputKey = (id: string) => `inputs/${id}/recording.csv`;
export const outputKey = (id: string, attempt: string) => `attempts/${id}/${attempt}.json`;
export const maxResultBytes = 256 * 1024;

let s3Client: S3Client | undefined;
function settings() {
  const env = config();
  const Bucket = env.AWS_S3_BUCKET;
  return Bucket ? {
    s3: s3Client ??= new S3Client({ region: env.AWS_REGION, requestChecksumCalculation: 'WHEN_REQUIRED' }), Bucket,
  } : null;
}

export async function readArtifact(key: string, limit: number) {
  const remote = settings();
  if (remote) {
    const result = await remote.s3.send(new GetObjectCommand({ Bucket: remote.Bucket, Key: key }));
    if (!result.Body || result.ContentLength === undefined || result.ContentLength > limit) {
      (result.Body as { destroy?: () => void } | undefined)?.destroy?.();
      throw new Fault(413, 'Stored artifact exceeds the size limit.');
    }
    return Buffer.from(await result.Body.transformToByteArray());
  }
  const bytes = await readFile(join(config().ARTIFACT_DIR, key));
  if (bytes.length > limit) throw new Fault(413, 'Stored artifact exceeds the size limit.');
  return bytes;
}

export async function putArtifact(key: string, bytes: Buffer, contentType: string) {
  const remote = settings();
  if (remote) {
    try {
      await remote.s3.send(new PutObjectCommand({
        Bucket: remote.Bucket, Key: key, Body: bytes, ContentType: contentType, IfNoneMatch: '*',
        ChecksumSHA256: Buffer.from(sha256(bytes), 'hex').toString('base64'),
      }));
      return;
    } catch (error) {
      if ((error as { name: string }).name !== 'PreconditionFailed') throw error;
    }
  } else {
    const path = join(config().ARTIFACT_DIR, key);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    try {
      await link(temp, path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await unlink(temp);
    }
  }
  if (sha256(await readArtifact(key, limits.bytes)) !== sha256(bytes)) throw new Fault(409, 'The stored artifact has a different checksum.');
}

export async function workerGrants(job: string, attempt: string) {
  const remote = settings();
  if (!remote) {
    const path = `/api/worker/attempts/${attempt}/artifact`;
    return { inputUrl: path, outputUrl: path };
  }
  const { s3, Bucket } = remote;
  return {
    inputUrl: await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: inputKey(job) }), { expiresIn: 210 }),
    outputUrl: await getSignedUrl(s3, new PutObjectCommand({
      Bucket, Key: outputKey(job, attempt), IfNoneMatch: '*',
    }), { expiresIn: 210, signableHeaders: new Set(['if-none-match']) }),
  };
}

export async function downloadUrl(job: string, attempt: string) {
  const remote = settings();
  if (!remote) return null;
  return getSignedUrl(remote.s3, new GetObjectCommand({
    Bucket: remote.Bucket, Key: outputKey(job, attempt),
    ResponseContentDisposition: `attachment; filename="${job}.json"`,
    ResponseContentType: 'application/json',
  }), { expiresIn: 300 });
}

export async function boundedBody(request: Request, max: number) {
  if (Number(request.headers.get('content-length')) > max) throw new Fault(413, 'Request exceeds the size limit.');
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, length);
    length += value.length;
    if (length > max) {
      await reader.cancel();
      throw new Fault(413, 'Request exceeds the size limit.');
    }
    chunks.push(value);
  }
}
