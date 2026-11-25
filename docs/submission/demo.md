# Live Demonstration Runbook

## Before presenting

- Open the [hosted dashboard](https://4k3efjo42g.execute-api.us-east-1.amazonaws.com/) and [health endpoint](https://4k3efjo42g.execute-api.us-east-1.amazonaws.com/api/health). Sign in privately before sharing the screen. An authorized operator can use `./aws/use-hosted.ps1 -Mode Operator -Profile ucs531-qos` to copy the token to the clipboard. See the [AWS guide](../../aws/HOSTED.md#sign-in-and-connect-workers) for the per-user AWS CLI path.
- For the scripted burst test, install the project dependencies with `npm ci` on Node.js 22 or newer. Keep the laptop's Docker engine running while the workers connect.
- In **Operations**, check that the scheduler is active and EC2 is stopped. Start both laptop workers for the first two scenarios. If this is a fresh checkout, prepare the private environment file using the AWS guide.

```powershell
docker compose --env-file .env.aws-workers -f compose.workers.yaml up -d
```

## 1 Local result

Submit `sample-vibration.csv` from this folder. Use a sample rate of 1,000 Hz, lags 2 to 4, normal priority, expected local runtime 10 seconds, a deadline at least two minutes ahead, and a zero cloud budget. Open the job details, point out the local placement reason and worker ID, then download the JSON. It should show **250 Hz** and best lag **4**.

## 2 Deadline rescue with both local slots busy

Use the reproducible `connected` phase of `scripts/verify-hosted.ts`. From a cleared queue with EC2 stopped, it submits two large zero-budget recordings and waits until both local slots are running. It then submits a high-priority sample with an 85-second deadline and a $0.030 budget. Apply a CPU quota for this controlled demonstration so the preloads occupy both slots.

```powershell
$env:LOCAL_WORKER_CPUS = '0.035'
docker compose --env-file .env.aws-workers -f compose.workers.yaml up -d --force-recreate
```

Use the sign-in helper to copy the authorized operator token before screen sharing. The verifier reads it from the process environment. Run these commands from the project directory.

```powershell
$env:HOSTED_VERIFY_URL = 'https://4k3efjo42g.execute-api.us-east-1.amazonaws.com'
$env:HOSTED_VERIFY_TOKEN = (Get-Clipboard -Raw).Trim()
try {
  node --import tsx scripts/verify-hosted.ts connected
} finally {
  Remove-Item Env:HOSTED_VERIFY_TOKEN
}
```

In the dashboard, select the **Hosted burst acceptance** run. Show both finish forecasts, the EC2 assignment, the checksum on the completed attempt, the matching CloudWatch record, and the return to stopped after idle time. The recorded hosted rescue completed 64.5 seconds before its deadline. [Verified burst job](https://4k3efjo42g.execute-api.us-east-1.amazonaws.com/?job=8191eab0-45bd-4450-bfa4-680d06d8ce1c)

## 3 Cloud execution with the laptop workers offline

```powershell
docker compose --env-file .env.aws-workers -f compose.workers.yaml stop
Remove-Item Env:LOCAL_WORKER_CPUS -ErrorAction SilentlyContinue
```

Keep the dashboard open. Submit the sample with a deadline at least three minutes ahead and a $0.030 budget. Once it completes, download the result. Submit a second sample with a zero budget. The second job waits for local capacity during its queue window and shows the budget constraint. The hosted app and the EC2 worker communicate directly over the AWS HTTPS endpoint. The recorded test completed with the original laptop app and relay also stopped. [Verified cloud-only job](https://4k3efjo42g.execute-api.us-east-1.amazonaws.com/?job=52a25224-599f-4e02-b9e4-7c4e888b1812)

## Close the demonstration

Show the policy comparison and explain the result. QoS tied priority at 15 of 21 burst deadlines, used EC2 for six jobs versus eleven, and had a longer mean completion time. Confirm EC2 is stopped in **Operations**. The AWS app stays online. The [hosted acceptance summary](../../aws/HOSTED.md#live-acceptance-on-november-25-2026) provides completed-job evidence if classroom connectivity interrupts a live step.
