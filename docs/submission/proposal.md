# Project Proposal

## QoS Aware Hybrid Cloud Task Scheduler

Batch-processing teams have to clear queues on limited local capacity while meeting deadlines and controlling cloud spend. A burst of arrivals can make urgent work wait behind long jobs. Keeping extra cloud capacity running adds cost even during quiet periods. This project proposes a scheduler that estimates whether an independent job can finish locally and starts cloud capacity when it can improve a deadline outcome within budget.

The demonstration uses one predefined workload. A user submits a one-column CSV of signed vibration samples, a sample rate, a lag range, a priority, an expected local runtime, a deadline, and a cloud budget. A worker scores candidate lags and publishes the dominant frequency, best lag, and lag scores as JSON.

## Objectives

1. Deliver a web dashboard and REST API for submission, job status, placement explanations, and result retrieval.
2. Implement first come first served, priority, and QoS-aware scheduling over the same queue and worker pool.
3. Run jobs on two optional Docker worker slots and a dedicated burst EC2 worker, with a durable AWS-hosted control plane.
4. Use RDS PostgreSQL for job state, private S3 for artifacts, and CloudWatch for monitoring and operational evidence.
5. Replay matched normal and burst workloads. Measure queue wait, deadline compliance, completion time, makespan, cloud usage, and estimated EC2 compute cost.

## Scope and success criteria

The semester prototype schedules independent, non-preemptive CSV jobs. It uses one EC2 burst slot and two optional local slots. Success requires a verified local result, a deadline rescued on EC2 within budget, a clear waiting reason for a zero-budget job while local capacity is offline, and durable job history across service restarts. The policy comparison will report observed trade-offs from the controlled experiment.
