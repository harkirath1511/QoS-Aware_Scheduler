# Scheduler evaluation

The November 2026 evaluation compared FCFS, priority, and QoS using the same seeded vibration recordings, arrival times, deadlines, estimates, and budgets for each policy within a workload. Each policy ran three times per workload. Policy order rotated between repetitions. The measured runs used the two local Docker slots and, where enabled, one EC2 slot.

## Local-only replay

The full trace ran 18 trials and 225 jobs. It submitted 12 spaced jobs per normal run and 13 per burst. The normal runs met all 108 deadlines. Every job produced a result, including jobs that finished after their deadlines.

| Burst policy | On-time jobs | Mean queue wait | Mean completion time |
|---|---:|---:|---:|
| FCFS | 17/39 | 5.01 s | 6.44 s |
| Priority | 19/39 | 4.41 s | 5.79 s |
| QoS | 18/39 | 4.60 s | 5.96 s |

## Live hybrid replay

The hybrid trace ran 18 trials and 90 jobs. Normal runs each submitted three jobs ten seconds apart. The burst began with two long, zero-budget jobs. Five jobs arrived ten seconds later, including one with a three-second deadline and one with a zero cloud budget. The local slots each used a 0.035 CPU quota to represent constrained capacity. Both local slots and the `t3.small` in `us-east-1` used the same pinned worker image. The frozen EC2 readiness forecast was 33 seconds. The compute rate was $0.0208 per hour. Separate storage, data transfer, monitoring, and networking charges are outside the compute total. [EC2 On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/)

The on-time denominator includes all admitted jobs. Queue wait runs from admission to first claim. Completion time runs from admission to the publication of a successful result. Each timing mean pools jobs across the three repetitions. The per-run JSON also records p95 timing, high-priority deadline outcomes, and each capacity session.

Normal demand met all 27 deadlines without starting EC2. All 63 burst jobs also produced results. Burst outcomes follow.

| Policy | On-time jobs | On-time high-priority jobs | Mean queue wait | Mean completion time | EC2 results | Estimated EC2 compute |
|---|---:|---:|---:|---:|---:|---:|
| FCFS | 11/21 | 2/12 | 29.24 s | 46.00 s | 8 | $0.001752 |
| Priority | 15/21 | 6/12 | 21.73 s | 35.71 s | 11 | $0.001797 |
| QoS | 15/21 | 6/12 | 28.08 s | 47.08 s | 6 | $0.001546 |

QoS met four more deadlines than FCFS and tied priority, at about 14% lower estimated EC2 compute cost than priority. Priority had the shortest mean completion time. Each policy used three EC2 starts. Observed readiness ranged from 19.1 to 45.2 seconds, which affected individual deadline outcomes. Three repetitions characterize this controlled workload on this lab host.

## Evidence

- Every QoS burst published two results from the verified EC2 worker before their deadlines, with placement forecasts showing the local option would miss. The EC2 worker's CloudWatch stream and the controller stream agreed on attempt IDs, the pinned worker image, and result checksums. The controller observed the instance stop after each trial.
- A separate demonstration verified the signed EC2 identity and retrieved the 250 Hz result from private S3. The downloaded object's SHA-256 matched the job's winning attempt. The worker was ready 22.3 seconds after the start request and published the result 59.1 seconds before the deadline.
- Zero-budget jobs remained local. The already-at-risk job exercised best-effort processing after its deadline. Normal demand left the cloud instance stopped.
- Stopping `local-1` during an attempt caused the lease to expire. `local-2` retried the job and published the single downloadable result. The S3 checksum matched the winning retry. The CloudWatch `WorkerLoss` alarm changed from `OK` to `ALARM`.

The evaluation CLI writes manifests, raw metrics, and matched trial comparisons under `evaluation-output/`. For setup and replay settings, see the [project README](../README.md) and [AWS setup](../aws/README.md).
