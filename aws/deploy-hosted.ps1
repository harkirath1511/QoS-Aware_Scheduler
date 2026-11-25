param(
  [Parameter(Mandatory)][ValidateSet('Data', 'App', 'Edge', 'Gateway', 'Worker')][string]$Stage,
  [string]$Aws = 'aws',
  [string]$Profile = 'ucs531-qos',
  [string]$Stack = 'ucs531-qos',
  [string]$AppDigest,
  [string]$WorkerDigest,
  [string]$PublicOrigin,
  [ValidateSet('Gateway', 'Edge')][string]$Entrypoint = 'Gateway',
  [string]$RateDate = (Get-Date -Format yyyy-MM-dd),
  [string]$RateUsdPerHour = '0.0208'
)

$ErrorActionPreference = 'Stop'
$Region = 'us-east-1'
$repository = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $repository
try {
  function Invoke-Aws {
    & $Aws --profile $Profile --region $Region --no-cli-pager @args
    if ($LASTEXITCODE -ne 0) { throw "AWS $($args[0]) $($args[1]) failed." }
  }

  function Read-StackOutputs([string]$name) {
    $outputs = @{}
    $json = Invoke-Aws cloudformation describe-stacks --stack-name $name --query 'Stacks[0].Outputs' --output json
    $json | ConvertFrom-Json | ForEach-Object { $outputs[$_.OutputKey] = $_.OutputValue }
    return $outputs
  }

  function Deploy-Data([string]$cloudFrontGroup = '', [bool]$allowCloudFront = $true) {
    $s3 = (Invoke-Aws ec2 describe-managed-prefix-lists --filters "Name=prefix-list-name,Values=com.amazonaws.$Region.s3" `
      --query 'PrefixLists[0].PrefixListId' --output text).Trim()
    $edge = (Invoke-Aws ec2 describe-managed-prefix-lists --filters 'Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing' `
      --query 'PrefixLists[0].PrefixListId' --output text).Trim()
    if ($s3 -notmatch '^pl-[a-f0-9]+$' -or $edge -notmatch '^pl-[a-f0-9]+$') {
      throw 'The AWS-managed S3 and CloudFront prefix lists could not be resolved.'
    }
    $parameters = @("S3PrefixList=$s3", "CloudFrontPrefixList=$edge", "EnableCloudFrontAccess=$($allowCloudFront.ToString().ToLowerInvariant())")
    if ($cloudFrontGroup) { $parameters += "CloudFrontOriginGroup=$cloudFrontGroup" }
    Invoke-Aws cloudformation deploy --stack-name "$Stack-hosted-data" --template-file aws/cloud-hosted-data.yaml `
      --parameter-overrides @parameters --tags Project=UCS531 --no-fail-on-empty-changeset
  }

  $resources = Read-StackOutputs "$Stack-resources"
  $account = (Invoke-Aws sts get-caller-identity --query Account --output text).Trim()
  if ($account -ne $resources.Account) { throw 'The CLI account differs from the existing project account.' }

  if ($Stage -eq 'Data') { Deploy-Data '' ($Entrypoint -eq 'Edge'); return }
  $data = Read-StackOutputs "$Stack-hosted-data"
  if ($Stage -eq 'App') {
    if ($AppDigest -notmatch '^sha256:[a-f0-9]{64}$' -or $WorkerDigest -notmatch '^sha256:[a-f0-9]{64}$') {
      throw 'Pass the published app and worker image digests.'
    }
    $repoName = ($resources.ImageRepository -split '/', 2)[1]
    $params = @("AppSubnetId=$($data.AppSubnetId)", "AppSecurityGroupId=$($data.AppSecurityGroupId)",
      "DatabaseEndpoint=$($data.DatabaseEndpoint)", "DatabaseSecretArn=$($data.DatabaseSecretArn)",
      "RuntimeSeedArn=$($data.RuntimeSeedArn)", "BurstWorkerTokenArn=$($data.BurstWorkerTokenArn)",
      "ArtifactBucket=$($resources.ArtifactBucket)", "BurstInstanceId=$($resources.InstanceId)",
      "ImageRepositoryName=$repoName", "AppImageDigest=$AppDigest", "WorkerImageDigest=$WorkerDigest",
      "RateDate=$RateDate", "RateUsdPerHour=$RateUsdPerHour")
    if ($PSBoundParameters.ContainsKey('PublicOrigin')) { $params += "PublicOrigin=$PublicOrigin" }
    Invoke-Aws cloudformation deploy --stack-name "$Stack-hosted-app" --template-file aws/cloud-hosted-app.yaml `
      --capabilities CAPABILITY_IAM --parameter-overrides @params --tags Project=UCS531 --no-fail-on-empty-changeset
    return
  }

  if ($Stage -eq 'Edge') {
    Deploy-Data
    $app = Read-StackOutputs "$Stack-hosted-app"
    Invoke-Aws cloudformation deploy --stack-name "$Stack-hosted-edge" --template-file aws/cloud-hosted-edge.yaml `
      --parameter-overrides "AppInstanceId=$($app.AppInstanceId)" "AppPrivateDnsName=$($app.AppPrivateDnsName)" `
      --tags Project=UCS531 --no-fail-on-empty-changeset
    $group = (Invoke-Aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$($data.VpcId)" `
      'Name=group-name,Values=CloudFront-VPCOrigins-Service-SG*' --query 'SecurityGroups[0].GroupId' --output text).Trim()
    if ($group -notmatch '^sg-[a-f0-9]+$') { throw 'CloudFront did not expose its managed origin security group yet.' }
    Deploy-Data $group
    return
  }

  if ($Stage -eq 'Gateway') {
    $app = Read-StackOutputs "$Stack-hosted-app"
    $privateIp = (Invoke-Aws ec2 describe-instances --instance-ids $app.AppInstanceId `
      --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text).Trim()
    Invoke-Aws cloudformation deploy --stack-name "$Stack-hosted-gateway" --template-file aws/cloud-hosted-gateway.yaml `
      --parameter-overrides "VpcId=$($data.VpcId)" "AppSubnetId=$($data.AppSubnetId)" `
      "AppSecurityGroupId=$($data.AppSecurityGroupId)" "AppPrivateIp=$privateIp" `
      --tags Project=UCS531 --no-fail-on-empty-changeset
    Deploy-Data '' $false
    return
  }

  if ($WorkerDigest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Pass the published worker image digest.' }
  $entry = Read-StackOutputs "$Stack-hosted-$($Entrypoint.ToLowerInvariant())"
  $role = (Invoke-Aws cloudformation describe-stack-resource --stack-name "$Stack-resources" --logical-resource-id WorkerRole `
    --query 'StackResourceDetail.PhysicalResourceId' --output text).Trim()
  Invoke-Aws cloudformation deploy --stack-name "$Stack-hosted-worker" --template-file aws/cloud-hosted-worker.yaml `
    --capabilities CAPABILITY_IAM --parameter-overrides "WorkerRoleName=$role" "WorkerTokenArn=$($data.BurstWorkerTokenArn)" `
    "DashboardUrl=$($entry.DashboardUrl)" "WorkerImage=$($resources.ImageRepository)@$WorkerDigest" `
    --tags Project=UCS531 --no-fail-on-empty-changeset
} finally {
  Pop-Location
}
