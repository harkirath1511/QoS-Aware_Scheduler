param(
  [string]$Aws = 'aws',
  [string]$Profile = 'ucs531-qos',
  [string]$Stack = 'ucs531-qos'
)

$ErrorActionPreference = 'Stop'
function Invoke-Aws {
  & $Aws --profile $Profile --region us-east-1 --no-cli-pager @args
  if ($LASTEXITCODE -ne 0) { throw "AWS $($args[0]) $($args[1]) failed." }
}

function Stack-Output([string]$name, [string]$key) {
  (Invoke-Aws cloudformation describe-stacks --stack-name $name `
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" --output text).Trim()
}

function Run-Command([string]$instance, [string]$document, [string]$shell) {
  $commandArgs = @('ssm', 'send-command', '--instance-ids', $instance, '--document-name', $document,
    '--timeout-seconds', '300', '--query', 'Command.CommandId', '--output', 'text')
  $file = $null
  if ($shell) {
    $file = New-TemporaryFile
    [IO.File]::WriteAllText($file.FullName, (ConvertTo-Json @{commands=@($shell)} -Compress))
    $commandArgs += @('--parameters', "file://$($file.FullName)")
  }
  else { $commandArgs += @('--document-version', '$LATEST') }
  try { $commandId = (Invoke-Aws @commandArgs).Trim() }
  finally { if ($file) { Remove-Item -LiteralPath $file.FullName } }
  & $Aws --profile $Profile --region us-east-1 --no-cli-pager ssm wait command-executed --instance-id $instance --command-id $commandId
  $result = Invoke-Aws ssm get-command-invocation --instance-id $instance --command-id $commandId `
    --query '{Status:Status,Code:ResponseCode,Message:StandardErrorContent}' --output json | ConvertFrom-Json
  if ($result.Status -ne 'Success') { throw "SSM command $commandId ended with $($result.Status). $($result.Message)" }
}

$app = Stack-Output "$Stack-hosted-app" AppInstanceId
$worker = Stack-Output "$Stack-resources" InstanceId
$bind = Stack-Output "$Stack-hosted-worker" BindDocument
$state = (Invoke-Aws ec2 describe-instances --instance-ids $worker --query 'Reservations[0].Instances[0].State.Name' --output text).Trim()
if ($state -ne 'stopped') { throw "Expected a stopped burst worker. Observed $state." }

$started = $false
try {
  Run-Command $app 'AWS-RunShellScript' 'systemctl stop qos-hosted@scheduler.service'
  Write-Output 'Paused hosted scheduling for the worker configuration.'
  Invoke-Aws ec2 start-instances --instance-ids $worker --query 'StartingInstances[0].CurrentState.Name' --output text
  $started = $true
  $online = $false
  $deadline = (Get-Date).AddSeconds(110)
  do {
    $ping = (Invoke-Aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$worker" `
      --query 'InstanceInformationList[0].PingStatus' --output text).Trim()
    $online = $ping -eq 'Online'
    if (-not $online) { Start-Sleep -Seconds 3 }
  } while (-not $online -and (Get-Date) -lt $deadline)
  if (-not $online) { throw 'The burst instance did not come online in Systems Manager.' }
  Run-Command $worker $bind ''
  Write-Output 'Installed the hosted HTTPS endpoint and the boot-time token refresh.'
} finally {
  try {
    if ($started) {
      Invoke-Aws ec2 stop-instances --instance-ids $worker --query 'StoppingInstances[0].CurrentState.Name' --output text
      Invoke-Aws ec2 wait instance-stopped --instance-ids $worker
    }
  } finally {
    Run-Command $app 'AWS-RunShellScript' 'systemctl start qos-hosted@scheduler.service'
  }
}
