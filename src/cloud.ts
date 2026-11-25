import { verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DescribeInstancesCommand, EC2Client, StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';
import { z } from 'zod';
import type { CloudObservation } from './controller';
import { config } from './config';
import { Fault } from './domain';

export const registration = z.strictObject({
  document: z.string().max(8192).optional(),
  signature: z.string().max(4096).optional(),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
});

export async function verifyRegistration(body: z.infer<typeof registration>) {
  const env = config();
  if (!env.EC2_INSTANCE_ID || !env.EC2_IDENTITY_CERT || !body.signature || !body.document ||
      body.imageDigest !== env.EC2_IMAGE_DIGEST) throw new Fault(403, 'EC2 identity or image did not match.');
  const certificate = await readFile(env.EC2_IDENTITY_CERT, 'utf8');
  if (!verify('RSA-SHA256', Buffer.from(body.document), certificate, Buffer.from(body.signature, 'base64'))) {
    throw new Fault(403, 'EC2 identity signature is invalid.');
  }
  const identity = JSON.parse(body.document);
  if (identity.instanceId !== env.EC2_INSTANCE_ID || identity.accountId !== env.EC2_ACCOUNT_ID || identity.region !== env.AWS_REGION) {
    throw new Fault(403, 'Unexpected EC2 instance, account or region.');
  }
  return { instanceId: env.EC2_INSTANCE_ID, imageDigest: body.imageDigest };
}

export function observeInstance(state?: string, transitionReason?: string): CloudObservation {
  if (state === 'pending' || state === 'running') return { state };
  if (state !== 'stopped' && state !== 'stopping') return { state: 'unknown' };

  // EC2 reports its transition time in DescribeInstances even after the instance stops.
  const stamp = transitionReason?.match(/\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) GMT\)$/);
  if (!stamp) return { state };
  const iso = `${stamp[1]}T${stamp[2]}.000Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString() === iso ? { state, exitedRunningAt: time } : { state };
}

export function capacityDriver() {
  const env = config();
  const instance = env.EC2_INSTANCE_ID;
  const ec2 = instance ? new EC2Client({ region: env.AWS_REGION, maxAttempts: 2 }) : null;
  return {
    async observe(): Promise<CloudObservation> {
      if (!ec2 || !instance) return { state: 'disabled' };
      const response = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instance] }), {
        abortSignal: AbortSignal.timeout(7000),
      });
      const observed = response.Reservations?.[0]?.Instances?.[0];
      return observeInstance(observed?.State?.Name, observed?.StateTransitionReason);
    },
    async act(action: 'start' | 'stop') {
      if (!ec2 || !instance) return;
      const input = { InstanceIds: [instance] };
      await ec2.send(action === 'start' ? new StartInstancesCommand(input) : new StopInstancesCommand(input), {
        abortSignal: AbortSignal.timeout(7000),
      });
      console.log(JSON.stringify({ kind: `ec2_${action}`, instanceId: instance }));
    },
  };
}
