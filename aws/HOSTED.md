# AWS-hosted scheduler

The hosted dashboard, REST API, queue, and scheduler remain available with the lab laptop disconnected. The laptop supplies two optional Docker worker slots. The burst worker connects directly to the hosted HTTPS API.

## Sign in and connect workers

Open the [hosted dashboard](https://4k3efjo42g.execute-api.us-east-1.amazonaws.com/), the `DashboardUrl` output of `ucs531-qos-hosted-gateway`. From the project directory, an authorized operator can copy a sign-in token straight to the Windows clipboard. Paste it into **Project access token** on that dashboard. Use `Student` for submission, tracking, and results without the Operations view.

```powershell
./aws/use-hosted.ps1 -Mode Operator -Profile ucs531-qos
```

The local workers use their own tokens and the digest-pinned image. Prepare `.env.aws-workers` once, then run Compose whenever the laptop should contribute capacity.

```powershell
./aws/use-hosted.ps1 -Mode Workers -Profile ucs531-qos
docker compose --env-file .env.aws-workers -f compose.workers.yaml up -d
docker compose --env-file .env.aws-workers -f compose.workers.yaml stop
```

The scripts use `aws` from `PATH` by default. For the per-user AWS CLI installation on this laptop, pass `-Aws` with `Join-Path $env:LOCALAPPDATA 'Programs\Amazon\AWSCLIV2\aws.exe'`. The env file is ignored by Git. Workers can restart using the cached image and their API tokens. Refresh ECR login before pulling an uncached image.

## Provision and update

The `us-east-1` deployment reuses the `ucs531-qos-resources` worker, S3 bucket, and ECR repository, along with `ucs531-qos-observability` logs and alarms. The four hosted CloudFormation stages provision the following resources.

| Stage | Resources |
|---|---|
| Data | Dedicated VPC, private app and DB subnets, outbound IPv6 gateway, S3 gateway endpoint, RDS PostgreSQL, and Secrets Manager credentials |
| App | Private `t3.small` app origin, project-scoped instance profile, application image pointer, and CloudWatch app log streams |
| Gateway | API Gateway HTTPS hostname, private VPC link, Cloud Map origin registration, and CloudWatch access log |
| Worker | A scoped grant to the burst worker token and a Systems Manager document that binds the worker to the hosted URL |

Publish the `hosted` and `worker` Dockerfile targets to the project's private ECR repository with unique tags, then pass their published SHA-256 digests. The app host uses separate `qos-hosted@web` and `qos-hosted@scheduler` systemd services with automatic restart. The prepare service validates the PostgreSQL TLS hostname, configures the runtime DB role, and applies the existing migration files before the app starts. Its secret files are root-readable and live in `/run`.

```powershell
./aws/deploy-hosted.ps1 -Stage Data
./aws/deploy-hosted.ps1 -Stage App -AppDigest $appDigest -WorkerDigest $workerDigest
./aws/deploy-hosted.ps1 -Stage Gateway
$url = aws cloudformation describe-stacks --region us-east-1 --profile ucs531-qos --stack-name ucs531-qos-hosted-gateway --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue | [0]" --output text
./aws/deploy-hosted.ps1 -Stage App -AppDigest $appDigest -WorkerDigest $workerDigest -PublicOrigin $url
./aws/deploy-hosted.ps1 -Stage Worker -WorkerDigest $workerDigest
./aws/bind-hosted-worker.ps1
```

The binder runs the worker stack's `BindDocument` through Systems Manager. It pauses scheduling while the burst instance is configured, stops the worker, and resumes scheduling. The worker reads its own secret and uses the hosted HTTPS endpoint on future boots. After changing the app digest, restart the prepare and app services when the queue is idle. For an existing app host, sync the changed public origin to `/etc/qos-hosted/app.env` during the same Systems Manager release. The CloudFormation user data applies it automatically to new hosts.

API Gateway forwards requests to the private EC2 origin through a VPC link and Cloud Map registration. Cookies, authorization, query strings, and upload methods pass through the proxy. The app verifies write requests against the configured public HTTPS origin. The instance has no public IPv4 address. RDS is encrypted, has no public endpoint, and accepts PostgreSQL connections from the app security group. Worker artifact access uses short-lived S3 URLs scoped to one input or one attempt output. The dashboard downloads the verified private S3 result through the same authenticated HTTPS endpoint. [API Gateway private integrations](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-private.html)

CloudFront requires AWS Support to verify this project account before it can create a distribution. The optional `Edge` template remains available after verification. It uses a private VPC origin, disables caching, and forwards viewer headers and cookies. A switch to that template also requires updating the app's public origin and rebinding the worker. [CloudFront private origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)

## Cost estimate

Standard `us-east-1` rates for uninterrupted use over a 730-hour month before credits. The EC2 burst instance stays stopped when idle.

| Resource | Estimated monthly cost |
|---|---:|
| `t3.small` app host at $0.0208/hour | $15.18 |
| Single-AZ `db.t4g.micro` PostgreSQL at $0.016/hour | $11.68 |
| 20 GB of RDS gp3 storage and two 12 GB EC2 gp3 volumes | About $4.22 |
| Three Secrets Manager secrets | About $1.20 plus requests |
| API Gateway, Cloud Map, CloudWatch, S3, ECR, and burst runs | Varies with usage |

Budget roughly $33–36 per month for a lightly used demo before credits. AWS Free plan credits cover eligible usage until the credits are depleted or the plan expires. Keeping the app available after that point requires an account decision by the owner. [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/) · [RDS PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/) · [Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/) · [AWS Free plan](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html)

## Live acceptance on November 25, 2026

| Scenario | Observed result | Evidence |
|---|---|---|
| Hosted sign-in, CSV upload, and download | Signed in, submitted, and downloaded the result in Brave. `local-1` finished before the deadline. The saved 250 Hz JSON matched the winning attempt's SHA-256. | [Browser-submitted job](https://4k3efjo42g.execute-api.us-east-1.amazonaws.com/?job=87f392a7-6f8e-422a-a47e-8dfafa009364) |
| Both local slots busy | QoS selected EC2 to rescue the deadline. EC2 was ready after 17.3 seconds. The result was published 64.5 seconds before the deadline, and the worker stopped after idling. | [Burst job](https://4k3efjo42g.execute-api.us-east-1.amazonaws.com/?job=8191eab0-45bd-4450-bfa4-680d06d8ce1c) |
| Laptop execution disconnected | The original lab app, relay, and both laptop worker slots were offline. EC2 was ready after 19.3 seconds and completed the cloud-eligible job. The zero-budget job stayed queued with the local-worker waiting reason. | [EC2 result](https://4k3efjo42g.execute-api.us-east-1.amazonaws.com/?job=52a25224-599f-4e02-b9e4-7c4e888b1812), [zero-budget job](https://4k3efjo42g.execute-api.us-east-1.amazonaws.com/?job=641edf4a-5adb-4ad4-bdc4-fe31929e0e38) |
| App restart and database privacy | Both AWS services restarted after their containers were killed. Earlier job records and result checksums still matched through HTTPS. AWS reported encrypted RDS with public access disabled and inbound PostgreSQL limited to the app security group. | Local acceptance artifacts `app-restart.json`, `restart.json`, and `aws-state.json` |

The two EC2 runs matched the worker and controller CloudWatch streams on the attempt IDs, pinned image digest, result checksum, deadline outcome, and stop events. Raw JSON evidence is available in the local `evaluation-output/hosted/` directory. The connected run used a 0.035 CPU quota per laptop worker to keep the burst reproducible. The default worker-only Compose command uses one CPU per worker.
