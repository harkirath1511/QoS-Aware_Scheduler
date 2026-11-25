# Deployed System Architecture

```mermaid
flowchart LR
    U[Browser and dashboard user]
    L[Two optional laptop Docker workers]
    subgraph AWS[AWS us-east-1]
      G[API Gateway HTTPS]
      V[VPC Link and Cloud Map]
      subgraph H[Private EC2 app host]
        A[Next.js dashboard and REST API]
        C[TypeScript scheduler service]
      end
      D[("Private RDS PostgreSQL<br/>Queue, jobs, attempts and leases")]
      B[("Private S3<br/>CSV inputs and JSON results")]
      W[Dedicated EC2 burst worker]
      M["CloudWatch<br/>Logs, metrics and alarms"]
      S[Secrets Manager]
      R[Private ECR images]
      G --> V --> A
      A <--> D
      C <--> D
      A <--> B
      C -->|Start, observe, stop| W
      W -->|Register, claim, renew, publish| G
      W <-->|Signed file access| B
      A --> M
      C --> M
      W --> M
      S --> A
      S --> C
      S --> W
      R --> A
      R --> C
      R --> W
    end
    U <-->|HTTPS| G
    L -->|Register, claim, renew, publish| G
    L <-->|Signed file access| B
```

The web process validates an upload and admits the job to the PostgreSQL queue. The scheduler ranks eligible jobs, forecasts worker finish times, and reserves an assignment in PostgreSQL. A worker claims the job, obtains scoped file URLs, evaluates the signal, and uploads a result for its attempt. The API verifies the checksum before publishing the winning result. The browser downloads it through the same authenticated HTTPS URL.

Web and scheduler processes run as separate services. Their durable queue and artifact records survive process restarts. Laptop workers connect only as optional execution capacity. CloudFormation describes the deployment, and the running application uses the private API Gateway VPC integration. [Deployed resource inventory](../../aws/HOSTED.md)
