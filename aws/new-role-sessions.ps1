param(
  [Parameter(Mandatory)][string]$Profile,
  [Parameter(Mandatory)][string]$Region,
  [Parameter(Mandatory)][string]$Destination,
  [string]$StackName = 'ucs531-qos-resources',
  [string]$Aws = 'aws'
)

$ErrorActionPreference = 'Stop'
$variables = @('AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_SECURITY_TOKEN','AWS_PROFILE','AWS_DEFAULT_PROFILE')
$previous = @{}
foreach ($name in $variables) {
  $previous[$name] = [Environment]::GetEnvironmentVariable($name)
  Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
}

$issuer = $null
$bootstrapId = $null
try {
  $outputs = & $Aws cloudformation describe-stacks --stack-name $StackName --profile $Profile --region $Region --query 'Stacks[0].Outputs' --output json --no-cli-pager | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or !$outputs) { throw 'Could not read the project stack outputs.' }
  $stack = @{}
  foreach ($output in $outputs) { $stack[$output.OutputKey] = $output.OutputValue }
  if (!$stack.WebRoleArn -or !$stack.ControllerRoleArn) { throw 'The application roles are missing from the stack.' }

  $issuer = $stack.CredentialsIssuer
  $profileArguments = @('--profile', $Profile)
  if ($issuer) {
    $key = & $Aws iam create-access-key --user-name $issuer --profile $Profile --region $Region --query AccessKey --output json --no-cli-pager | ConvertFrom-Json
    $bootstrapId = $key.AccessKeyId
    if ($LASTEXITCODE -ne 0 -or !$bootstrapId -or !$key.SecretAccessKey) { throw 'Could not issue the temporary bootstrap key.' }
    $env:AWS_ACCESS_KEY_ID = $bootstrapId
    $env:AWS_SECRET_ACCESS_KEY = $key.SecretAccessKey
    $profileArguments = @()
  }

  [void](New-Item -ItemType Directory -Path $Destination -Force)
  foreach ($role in @(@{ Name = 'web'; Arn = $stack.WebRoleArn }, @{ Name = 'controller'; Arn = $stack.ControllerRoleArn })) {
    $session = $null
    # A newly created key can take a few seconds to become usable.
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
      $session = & $Aws sts assume-role --role-arn $role.Arn --role-session-name "qos-$($role.Name)" @profileArguments --region $Region --query Credentials --output json --no-cli-pager | ConvertFrom-Json
      if ($LASTEXITCODE -eq 0 -and $session.SessionToken) { break }
      Start-Sleep -Seconds 2
    }
    if (!$session.SessionToken) { throw "Could not assume the project $($role.Name) role." }
    @(
      "AWS_ACCESS_KEY_ID=$($session.AccessKeyId)"
      "AWS_SECRET_ACCESS_KEY=$($session.SecretAccessKey)"
      "AWS_SESSION_TOKEN=$($session.SessionToken)"
    ) | Set-Content -Encoding utf8 -LiteralPath (Join-Path $Destination ".env.aws-$($role.Name)")
    Write-Output "Created scoped $($role.Name) credentials expiring at $($session.Expiration)."
  }
}
finally {
  try {
    foreach ($name in $variables) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
    if ($bootstrapId) {
      & $Aws iam delete-access-key --user-name $issuer --access-key-id $bootstrapId --profile $Profile --region $Region --no-cli-pager
      if ($LASTEXITCODE -ne 0) { throw 'AWS did not confirm revocation of the bootstrap key.' }
      Write-Output 'Revoked the bootstrap key.'
    }
  }
  finally {
    foreach ($name in $variables) {
      if ($null -ne $previous[$name]) { Set-Item -LiteralPath "Env:$name" -Value $previous[$name] }
    }
  }
}
