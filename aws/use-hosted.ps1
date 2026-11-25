param(
  [Parameter(Mandatory)][ValidateSet('Operator', 'Student', 'Workers')][string]$Mode,
  [string]$Aws = 'aws',
  [string]$Profile = 'ucs531-qos',
  [string]$Stack = 'ucs531-qos',
  [ValidateSet('Gateway', 'Edge')][string]$Entrypoint = 'Gateway'
)

$ErrorActionPreference = 'Stop'
$Region = 'us-east-1'
Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
try {
  function Invoke-Aws {
    & $Aws --profile $Profile --region $Region --no-cli-pager @args
    if ($LASTEXITCODE -ne 0) { throw "AWS $($args[0]) $($args[1]) failed." }
  }

  function Read-Output([string]$stackName, [string]$key) {
    (Invoke-Aws cloudformation describe-stacks --stack-name $stackName `
      --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" --output text).Trim()
  }

  $seedArn = Read-Output "$Stack-hosted-data" RuntimeSeedArn
  $seed = (Invoke-Aws secretsmanager get-secret-value --secret-id $seedArn --query SecretString --output text).Trim()
  if ($seed -notmatch '^[a-zA-Z0-9]{64}$') { throw 'The hosted credentials could not be read.' }
  $credentialMode = $Mode.ToLowerInvariant()
  $secretLines = $seed | node --import tsx scripts/hosted-secrets.ts $credentialMode
  Remove-Variable seed
  if ($LASTEXITCODE -ne 0) { throw 'Credential derivation failed.' }

  if ($Mode -ne 'Workers') {
    $secretLines | Set-Clipboard
    Remove-Variable secretLines
    Write-Output "$Mode access token copied to the clipboard. Paste it on the hosted sign-in page."
    return
  }

  $url = Read-Output "$Stack-hosted-$($Entrypoint.ToLowerInvariant())" DashboardUrl
  $image = Read-Output "$Stack-resources" ImageRepository
  $digest = (Invoke-Aws cloudformation describe-stacks --stack-name "$Stack-hosted-app" `
    --query "Stacks[0].Parameters[?ParameterKey=='WorkerImageDigest'].ParameterValue | [0]" --output text).Trim()
  if ($url -notmatch '^https://([a-z0-9]+\.cloudfront\.net|[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com)$' -or
      $digest -notmatch '^sha256:[a-f0-9]{64}$') {
    throw 'The hosted URL or worker image is missing.'
  }
  $registry = ($image -split '/', 2)[0]
  Invoke-Aws ecr get-login-password | docker.exe login --username AWS --password-stdin $registry
  if ($LASTEXITCODE -ne 0) { throw 'ECR login failed.' }
  $envPath = Join-Path (Get-Location) '.env.aws-workers'
  [System.IO.File]::WriteAllLines($envPath, [string[]](@("WORKER_API_URL=$url", "WORKER_IMAGE_REF=$image@$digest") + $secretLines))
  Remove-Variable secretLines
  Write-Output 'Prepared .env.aws-workers for the two optional Docker workers.'
} finally {
  Pop-Location
}
