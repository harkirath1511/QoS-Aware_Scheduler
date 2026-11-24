import { limits, priorities, type Policy, type Priority, type Target } from './domain';

export interface Candidate {
  id: string;
  priority: Priority;
  queuedAt: number;
  deadline: number;
  expectedSeconds: number;
  inputBytes: number;
  outputBytes: number;
  budgetRemaining: number;
}

export interface Slot {
  id: string;
  target: Target;
  freeAt: number;
}

export interface Calibration {
  cloudRuntimeRatio: number;
  localBytesPerSecond: number;
  cloudBytesPerSecond: number;
  localFixedSeconds: number;
  cloudFixedSeconds: number;
}

export interface BurstBudget {
  rateMicrosPerHour: number;
  runRemaining: number;
  cold: boolean;
  idleReserve: number;
}

export function computeCost(rateMicrosPerHour: number, ms: number) {
  return Math.ceil(rateMicrosPerHour * ms / 3_600_000);
}

export function serviceMs(job: Candidate, target: Target, calibration: Calibration) {
  const cloud = target === 'ec2';
  const compute = job.expectedSeconds * (cloud ? calibration.cloudRuntimeRatio : 1);
  const throughput = cloud ? calibration.cloudBytesPerSecond : calibration.localBytesPerSecond;
  const fixed = cloud ? calibration.cloudFixedSeconds : calibration.localFixedSeconds;
  return Math.ceil(1000 * (compute + fixed + (job.inputBytes + job.outputBytes) / throughput));
}

export function rankJobs(jobs: Candidate[], policy: Policy, now: number, calibration: Calibration) {
  const queueOrder = (a: Candidate, b: Candidate) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id);
  const priorityOrder = (a: Candidate, b: Candidate) => priorities.indexOf(b.priority) - priorities.indexOf(a.priority);
  return [...jobs].sort((a, b) => {
    if (policy === 'fcfs') return queueOrder(a, b);
    if (policy === 'priority') return priorityOrder(a, b) || queueOrder(a, b);
    const agedA = now - a.queuedAt >= limits.ageMs;
    const agedB = now - b.queuedAt >= limits.ageMs;
    if (agedA && agedB) return queueOrder(a, b);
    if (agedA !== agedB) return agedA ? -1 : 1;
    const latestA = a.deadline - serviceMs(a, 'local', calibration);
    const latestB = b.deadline - serviceMs(b, 'local', calibration);
    return priorityOrder(a, b) || latestA - latestB || queueOrder(a, b);
  });
}

export function placeJob(job: Candidate, policy: Policy, now: number, slots: Slot[], calibration: Calibration, budget: BurstBudget) {
  const local = slots.filter(slot => slot.target === 'local').sort((a, b) => a.freeAt - b.freeAt)[0];
  const cloud = slots.find(slot => slot.target === 'ec2');
  const localFinish = local ? local.freeAt + serviceMs(job, 'local', calibration) : Infinity;
  const cloudFinish = cloud ? cloud.freeAt + serviceMs(job, 'ec2', calibration) : Infinity;
  const coldMs = budget.cold ? limits.startupMs : 0;
  const reservation = computeCost(budget.rateMicrosPerHour, limits.executionMs + coldMs);
  const cloudBlock = !cloud ? 'cloud_unavailable' :
    job.budgetRemaining <= 0 || reservation > job.budgetRemaining ? 'job_budget' :
    reservation + budget.idleReserve > budget.runRemaining ? 'run_budget' : null;
  let selected: Slot | undefined;
  let reason: string;
  if (policy === 'qos' && local && localFinish <= job.deadline) {
    selected = local;
    reason = 'local_meets_deadline';
  } else if (policy === 'qos' && cloud && !cloudBlock && cloudFinish <= job.deadline) {
    selected = cloud;
    reason = 'cloud_rescues_deadline';
  } else if (policy !== 'qos' && cloud && !cloudBlock && (!local || (local.freeAt > now && cloud.freeAt < local.freeAt))) {
    selected = cloud;
    reason = 'cloud_starts_earlier';
  } else if (local) {
    selected = local;
    reason = policy === 'qos' ? cloudBlock ?? 'both_targets_late' : 'local_first';
  } else if (cloud && !cloudBlock) {
    selected = cloud;
    reason = 'cloud_only_available';
  } else {
    reason = cloudBlock ?? 'no_available_worker';
  }

  const finishAt = selected?.target === 'ec2' ? cloudFinish : localFinish;
  return {
    selected, finishAt, reason, cloudBlock, localFinish, cloudFinish, reservation,
    cloudExpectedCost: computeCost(budget.rateMicrosPerHour, serviceMs(job, 'ec2', calibration) + (cloud && budget.cold ? Math.max(0, cloud.freeAt - now) : 0)),
    deadlineRisk: finishAt > job.deadline,
  };
}
