import { Fault, limits, sha256, type JobInput } from './domain';

export function samplesFromCsv(bytes: Uint8Array): Int16Array {
  if (bytes.byteLength > limits.bytes) throw new Fault(413, 'CSV exceeds 2 MiB.');
  let csv: string;
  try { csv = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Fault(422, 'Use UTF-8 CSV.'); }
  const lines = csv.trimEnd().split(/\r?\n/);
  if (lines[0]?.trim().toLowerCase() === 'sample') lines.shift();
  if (lines.length < 2 || lines.length > limits.samples) {
    throw new Fault(422, 'Provide between 2 and 250,000 samples.');
  }
  const samples = new Int16Array(lines.length);
  for (const [index, line] of lines.entries()) {
    const text = line.trim();
    const value = Number(text);
    if (!/^[+-]?\d{1,5}$/.test(text) || value < -32768 || value > 32767) {
      throw new Fault(422, `Sample ${index + 1} must contain one signed 16-bit integer.`);
    }
    samples[index] = value;
  }
  return samples;
}

export function analyze(bytes: Uint8Array, job: Pick<JobInput, 'sampleRate' | 'minLag' | 'maxLag' | 'inputSha256'>) {
  if (sha256(bytes) !== job.inputSha256) throw new Error('Input checksum mismatch.');
  const samples = samplesFromCsv(bytes);
  if (job.maxLag >= samples.length) throw new Fault(422, 'Maximum lag must be below sample count.');
  let bestLag = job.minLag;
  let bestSum = -Infinity;
  let bestCount = 1;
  const scores = [];
  for (let lag = job.minLag; lag <= job.maxLag; lag++) {
    const count = samples.length - lag;
    let sum = 0;
    for (let index = 0; index < count; index++) sum += samples[index] * samples[index + lag];
    if (bestSum === -Infinity || BigInt(sum) * BigInt(bestCount) > BigInt(bestSum) * BigInt(count)) {
      bestLag = lag;
      bestSum = sum;
      bestCount = count;
    }
    scores.push({ lag, score: sum / count });
  }
  return {
    algorithmVersion: 'vibration-v1', inputSha256: job.inputSha256, sampleCount: samples.length,
    sampleRate: job.sampleRate, scores, bestLag, frequencyHz: job.sampleRate / bestLag,
  };
}
