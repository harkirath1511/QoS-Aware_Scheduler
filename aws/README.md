# Live EC2 burst setup

Use one dedicated, EBS-backed, Linux On-Demand instance in the S3 bucket's region. Enable required IMDSv2 with hop limit 1. Set instance-initiated shutdown behavior to `stop`. Install Docker, curl and the team's private network client. Keep the instance stopped when the lab stack is idle.

## Provisioning

The [resource template](cloud-resources.yaml) provisions the worker, encrypted S3 storage, a private ECR repository, and distinct web and controller roles. It uses an existing subnet with outbound HTTPS, an Amazon Linux 2023 AMI and a `t3.small` On-Demand instance by default. Standard CPU credits keep surplus credits outside the cost model. The instance starts during deployment, so plan to finish setup and stop it before configuring the scheduler. The stack retains project artifacts and images when deleted.

From an authenticated AWS CLI session at the repository root, set the target region, existing VPC and subnet IDs, and the IAM ARN of the operator role that will assume the two application roles. Use a VPC with DNS resolution enabled. Use `AssignPublicIpv4=false` if the subnet routes outbound traffic through NAT.

```powershell
$region = 'ap-south-1'
$stack = 'ucs531-qos'
$vpc = 'vpc-REPLACE'
$subnet = 'subnet-REPLACE'
$operatorArn = 'arn:aws:iam::ACCOUNT:role/REPLACE'
aws cloudformation deploy --region $region --stack-name "$stack-observability" --template-file aws/cloud-observability.yaml
aws cloudformation deploy --region $region --stack-name "$stack-resources" --template-file aws/cloud-resources.yaml --capabilities CAPABILITY_IAM --parameter-overrides "VpcId=$vpc" "SubnetId=$subnet" "OperatorPrincipalArn=$operatorArn"
$resources = @{}
aws cloudformation describe-stacks --region $region --stack-name "$stack-resources" --query 'Stacks[0].Outputs' --output json |
  ConvertFrom-Json | ForEach-Object { $resources[$_.OutputKey] = $_.OutputValue }
```

The deployment identity also needs access to publish the worker image. Authenticate Docker to the output registry, publish the worker target, and retrieve its digest. Use a new tag when publishing a different build because the repository has immutable tags.

```powershell
$repo = $resources.ImageRepository
$registry, $repository = $repo -split '/', 2
$tag = git rev-parse --short HEAD
aws ecr get-login-password --region $region | docker login --username AWS --password-stdin $registry
docker build --platform linux/amd64 --target worker -t "${repo}:$tag" .
docker push "${repo}:$tag"
$digest = aws ecr describe-images --region $region --repository-name $repository --image-ids "imageTag=$tag" --query 'imageDetails[0].imageDigest' --output text
$workerImage = "$repo@$digest"
```

### Resource checklist

1. Verify Block Public Access, bucket-owner-enforced ownership, default SSE-S3 and TLS enforcement on the artifact bucket. The API writes immutable inputs and signs short-lived grants for one input and one attempt output. Keep the `inputs/` and `attempts/` prefixes private. Set retention for the lab's evidence before writing artifacts.
2. Check that the observability stack created the controller and EC2 worker log streams and alarms for worker loss, startup timeout and a delayed stop. Use its log group and namespace on both hosts.
3. Use the two application roles from the resource stack. The web role has `s3:GetObject` and `s3:PutObject` on the two bucket prefixes. The controller role has regional `ec2:DescribeInstances`, `ec2:StartInstances` and `ec2:StopInstances` on the worker, `logs:PutLogEvents` on the controller stream, and `cloudwatch:PutMetricData` in the project namespace. The instance profile can create and write the dedicated EC2 log stream and pull the worker image. Keep operator credentials and worker tokens local to the project hosts.
4. Connect the worker to the lab API over an existing private network or the [Systems Manager relay](#private-worker-connection-through-systems-manager). For a Tailscale deployment, use Serve and apply network access rules for the EC2 host and authorized project users. Set `COOKIE_SECURE=true` when accessing the dashboard through HTTPS. PostgreSQL stays on the Compose network.
5. Build and publish the `worker` Dockerfile target to the team's private registry. Pull the image by digest to EC2 and set `WORKER_IMAGE_REF` to that same digest-qualified image reference in the lab's `.env`. The AWS Compose override uses that image for both local slots. Use the same architecture for the comparison and authenticate Docker to the private registry on both hosts. Restrict the EC2 security group to outbound access needed for the private API, S3 and CloudWatch. Require IMDSv2 hop limit 1 so the Docker bridge workers cannot obtain the host's credentials.

## Lab environment

Complete the EC2 and S3 settings commented in [the environment example](../.env.example). Use the project's EC2 instance ID, account, region, pinned image digest and measured durations. Set a fresh `WORKER_TOKEN_EC2_1` with at least 24 characters. Record the rate source and date with the rate for your instance and region. Save the region's **RSA public certificate** for the EC2 instance identity document to a local file. Set `AWS_IID_CERT_FILE` to the certificate's host path.

The stack outputs supply `AWS_S3_BUCKET` from `ArtifactBucket`, `EC2_INSTANCE_ID` from `InstanceId`, and `EC2_ACCOUNT_ID` from `Account`. Use `$digest` for `EC2_IMAGE_DIGEST` and `$workerImage` for `WORKER_IMAGE_REF`. Set `CLOUDWATCH_LOG_GROUP=/ucs531/scheduler` when using the default observability stack.

Generate short-lived credentials for both application roles. Pass the locally authenticated AWS CLI profile used for provisioning. If that profile uses the account root identity, the template creates a project issuer whose only permission is to assume the two application roles. The helper uses a one-time key for that issuer and revokes the key after issuing both sessions.

```powershell
./aws/new-role-sessions.ps1 -Profile ucs531-qos -Region $region -StackName "$stack-resources" -Destination .
```

Set `AWS_WEB_ENV_FILE=.env.aws-web` and `AWS_CONTROLLER_ENV_FILE=.env.aws-controller` in `.env`. Ensure the sessions cover the planned evaluation. When refreshing credentials, recreate the web and scheduler containers after all jobs finish and EC2 stops. Once the worker is configured and stopped, start the lab stack.

```sh
docker compose -f compose.yaml -f compose.aws.yaml up --build -d
```

An evaluation run freezes its AWS mode, rate and calibration at creation. To apply changed settings to a populated database, finish the current run after all jobs and EC2 sessions close, then start a new run. Operators can call `POST /api/runs/finish` with the active run ID and begin the next run from the evaluation CLI.

If an assumed session is too short for the complete evaluation, run one repetition at a time with `EVALUATION_REPEAT=1`. Set `EVALUATION_FIRST_TRIAL` to `1`, `2`, and `3` on successive invocations to keep trial numbers distinct and rotate policy order. Refresh both roles between invocations as needed and keep all workload and calibration settings fixed.

## EC2 environment

Open a Session Manager session to the instance, wait for `cloud-init status --wait`, and enroll the host in the team's private network. The provisioned instance profile has pull access to the private ECR repository. Authenticate the host's Docker client to that registry and pull the digest-qualified image. The example uses the region and repository from the stack outputs.

```sh
aws ecr get-login-password --region REGION | sudo docker login --username AWS --password-stdin REGISTRY
sudo docker pull 'REGISTRY/REPOSITORY@sha256:DIGEST'
```

Place matching values in the following root-owned files. Keep the worker token in `worker.env` with mode 0600.

```dotenv
# /etc/qos-worker/host.env
AWS_REGION=ap-south-1
LOG_GROUP=/ucs531/scheduler
WORKER_IMAGE=registry.example/team/qos-worker@sha256:replace-with-digest
```

```dotenv
# /etc/qos-worker/worker.env
WORKER_ID=ec2-1
WORKER_TOKEN=matching-worker-token
WORKER_API_URL=https://lab-host.private-network.example
WORKER_IMAGE_DIGEST=sha256:replace-with-digest
WORKER_IDENTITY_DOCUMENT=/run/qos-worker/identity/document
WORKER_IDENTITY_SIGNATURE=/run/qos-worker/identity/signature
WORKER_CONTACT_FILE=/run/qos-worker/contact/last
```

Install the shell scripts and service units from the pinned image. This prepares the worker for its next boot.

```sh
assets=$(mktemp -d)
worker_assets=$(sudo docker create 'REGISTRY/REPOSITORY@sha256:DIGEST')
sudo docker cp "$worker_assets:/app/aws/." "$assets"
sudo docker rm "$worker_assets"
cd "$assets"
sudo install -m 0755 prepare-worker.sh /usr/local/sbin/qos-prepare-worker
sudo install -m 0755 worker-watchdog.sh /usr/local/sbin/qos-worker-watchdog
sudo install -m 0644 ec2-worker.service qos-watchdog.service qos-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable ec2-worker.service qos-watchdog.timer
sudo systemctl poweroff
```

The boot hook reads the signed instance identity with IMDSv2 on the host. The trusted worker agent presents it over private HTTPS. The web API verifies the signature against the AWS certificate and checks the configured account, region, instance ID and image digest. The host watchdog stops the VM when controller contact has expired after the startup grace period.

## Private worker connection through Systems Manager

Install OpenSSH and the [AWS Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/install-plugin-windows.html) on the lab host. Use an operator profile that can connect to the dedicated instance through Systems Manager. The relay uses an SSH reverse port forward over the AWS-managed connection. The instance security group needs no inbound port for this arrangement.

1. Generate separate SSH keys for the relay and one-time host setup. Run `aws/prepare-ssm-relay.sh` as root on the dedicated instance via Systems Manager Run Command. Pass the two public keys as arguments, in that order. The script prepares a forwarding-only user named `qos-tunnel` and reports the Docker bridge gateway and SSH host key.
2. Pin that SSH host key in a project-specific known_hosts file under the instance ID returned by the stack. Configure the OpenSSH host alias `qos-ec2` to connect as `qos-tunnel` via the Session Manager `AWS-StartSSHSession` document. Use the relay private key, strict host-key checking, and `RemoteForward <bridge-gateway>:38443 127.0.0.1:38444`. Require `ExitOnForwardFailure yes` and set `ServerAliveInterval 5` and `ServerAliveCountMax 2`. Use a separate OpenSSH entry for temporary `ec2-user` setup and revoke its key once that setup is complete.
3. Create a project TLS certificate with a DNS subject alternative name of `qos-lab-worker`. Copy its public certificate to `/etc/qos-worker/relay.pem` over the verified private setup connection. Set `WORKER_API_URL=https://qos-lab-worker:38443` and `NODE_EXTRA_CA_CERTS=/run/qos-worker/identity/relay.pem` in `worker.env`. Only the lab keeps the TLS private key. The worker uses the standard bridged Docker network and the host gateway alias.
4. Keep the relay running during evaluation. It listens on loopback, forwards only worker API POST requests, and reconnects the SSH session when EC2 starts. Replace `3000` if the lab API uses a different loopback port.

```sh
npx tsx scripts/worker-relay.ts relay.pem relay-key.pem ssh-config 3000
```

Invoke the AWS CLI executable directly in `ProxyCommand` where possible so SSH data travels as bytes. See [SSH over Systems Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-enable-ssh-connections.html) for platform-specific syntax.

## Demonstrate live bursting

- Confirm the two local workers are healthy and EC2 begins stopped. Use the calibrated burst trace and a job budget that covers the cold reservation. Provide enough deadline slack for measured boot and actual computation. Set `EVALUATION_REQUIRE_EC2=true` for verification.
- Capture the dashboard placement explanation, EC2 readiness and job claim, and the attempt ID shown on the result. Check the EC2-only CloudWatch stream for that attempt and confirm its image digest and result checksum match the job history.
- Check the console reports EC2 stopped after idle time. Inspect the run's cost record, uptime and deadline result. Repeat the same manifests under FCFS and priority before drawing a comparison.

[AWS instance identity signature verification](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/verify-iid.html) · [EC2 lifecycle billing](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html) · [S3 signed URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) · [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
