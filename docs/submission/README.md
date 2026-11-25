# UCS531 Project Submission

The QoS-Aware Hybrid Cloud Task Scheduler runs on AWS in `us-east-1`. It accepts vibration CSV jobs and schedules them on optional local Docker workers or an on-demand EC2 worker. The hosted application remains available when the laptop workers disconnect.

| Deliverable | Where to find it |
|---|---|
| Project proposal | [Problem statement and objectives](proposal.md) |
| System architecture | [Deployed architecture and Mermaid diagram](architecture.md) |
| Working implementation | [Project source and setup](../../README.md) and [hosted app](https://4k3efjo42g.execute-api.us-east-1.amazonaws.com/) |
| Cloud deployment and demonstration | [AWS deployment](../../aws/HOSTED.md) and [demo runbook](demo.md) |
| Source code and README | [GitHub repository](https://github.com/harkirath1511/QoS-Aware_Scheduler) and [README](../../README.md) |
| Project report | Four-page PDF in the submission package |
| Final presentation and live demonstration | Editable presentation in the handoff and the [demo runbook](demo.md) |

The [evaluation](../evaluation.md) compares the three policies. The [hosted acceptance summary](../../aws/HOSTED.md#live-acceptance-on-november-25-2026) records the browser, worker, AWS and restart checks. Access to hosted job details uses an authorized project token.
