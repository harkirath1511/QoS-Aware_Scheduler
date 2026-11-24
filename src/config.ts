import { z } from 'zod';
import { micros, policies } from './domain';
import type { Calibration } from './policy';

const usd = z.string().regex(/^\d{1,4}(\.\d{1,6})?$/).transform(micros);
const numeric = (fallback: number, min: number) => z.coerce.number().min(min).default(fallback);
const defaults = z.object({
  POLICY: z.enum(policies).default('qos'),
  AWS_REGION: z.string().default('ap-south-1'),
  AWS_S3_BUCKET: z.string().min(1).optional(),
  EC2_INSTANCE_ID: z.string().regex(/^i-[a-f0-9]+$/).optional(),
  EC2_ACCOUNT_ID: z.string().regex(/^\d{12}$/).optional(),
  EC2_IDENTITY_CERT: z.string().min(1).optional(),
  EC2_IMAGE_DIGEST: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  EC2_RATE_USD_HOUR: usd.optional(),
  EC2_RATE_SOURCE: z.string().url().optional(),
  EC2_RATE_DATE: z.iso.date().optional(),
  RUN_BUDGET_USD: usd.prefault('1'),
  EC2_START_ESTIMATE_S: numeric(45, 1),
  CLOUD_RUNTIME_RATIO: numeric(1, 0.001),
  LOCAL_BPS: numeric(2_000_000, 1),
  CLOUD_BPS: numeric(5_000_000, 1),
  LOCAL_FIXED_S: numeric(0.4, 0),
  CLOUD_FIXED_S: numeric(0.5, 0),
  ARTIFACT_DIR: z.string().default('.data/artifacts'),
  CLOUDWATCH_LOG_GROUP: z.string().min(1).optional(),
  CLOUDWATCH_NAMESPACE: z.string().min(1).default('UCS531/Scheduler'),
});

export function config() {
  const env = defaults.parse(process.env);
  if (env.EC2_INSTANCE_ID && [
    env.AWS_S3_BUCKET, env.EC2_ACCOUNT_ID, env.EC2_IDENTITY_CERT, env.EC2_IMAGE_DIGEST,
    env.EC2_RATE_USD_HOUR, env.EC2_RATE_SOURCE, env.EC2_RATE_DATE, env.CLOUDWATCH_LOG_GROUP,
  ].some(value => !value)) throw new Error('EC2 mode requires S3, identity, image, pricing and CloudWatch configuration.');
  return env;
}

export interface RunConfig {
  calibration: Calibration;
  startupEstimateMs: number;
  runBudgetMicros: number;
  rateMicrosPerHour: number;
  region: string;
  rateSource?: string;
  rateDate?: string;
  instanceId?: string;
}

export function runConfig(): RunConfig {
  const env = config();
  return {
    calibration: {
      cloudRuntimeRatio: env.CLOUD_RUNTIME_RATIO,
      localBytesPerSecond: env.LOCAL_BPS,
      cloudBytesPerSecond: env.CLOUD_BPS,
      localFixedSeconds: env.LOCAL_FIXED_S,
      cloudFixedSeconds: env.CLOUD_FIXED_S,
    },
    startupEstimateMs: env.EC2_START_ESTIMATE_S * 1000,
    runBudgetMicros: env.RUN_BUDGET_USD,
    rateMicrosPerHour: env.EC2_RATE_USD_HOUR ?? 0,
    region: env.AWS_REGION, rateSource: env.EC2_RATE_SOURCE, rateDate: env.EC2_RATE_DATE,
    instanceId: env.EC2_INSTANCE_ID,
  };
}
