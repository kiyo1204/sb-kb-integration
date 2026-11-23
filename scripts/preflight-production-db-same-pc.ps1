#requires -Version 5.1
<#
.SYNOPSIS
  Read-only inventory before placing a new PostgreSQL DB on the rehearsal PC.
.DESCRIPTION
  Never starts/stops Docker resources, writes files, inspects DB rows, or changes Compose.
  This cannot authorize deployment. Review any unfamiliar project/resource manually.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$productionProject = 'sbkb-production-db'
$rehearsalHint = 'sbkb-rehearsal-20261122125146'

function Invoke-DockerReadOnly {
    param([Parameter(Mandatory = $true)][string[]]$QueryArgs)

    $signature = '{0} {1}' -f $QueryArgs[0], $QueryArgs[1]
    if ($signature -notin @(
        'context show',
        'info --format',
        'container ls',
        'volume ls',
        'network ls'
    )) {
        throw 'Only explicitly allowlisted read-only Docker queries are permitted.'
    }
    $response = @(& docker @QueryArgs 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw ('Docker read-only query failed ({0}). Stop and investigate; do not start or reset containers.' -f $signature)
    }
    return @($response | ForEach-Object { [string]$_ } | Where-Object { $_.Trim().Length -gt 0 })
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI not found. No resources were changed.'
}

Write-Host 'Production DB same-PC preflight: READ ONLY'
Write-Host 'No docker compose up/down, no DB connection, no filesystem writes.'

$context = @(Invoke-DockerReadOnly -QueryArgs @('context', 'show'))
$serverVersion = @(Invoke-DockerReadOnly -QueryArgs @('info', '--format', '{{.ServerVersion}}'))
Write-Host ('Docker context: {0}' -f ($context -join ', '))
Write-Host ('Docker Engine: {0}' -f ($serverVersion -join ', '))
Write-Warning 'Confirm this Docker context points to the rehearsal PC, not a remote server.'

$allContainers = @(Invoke-DockerReadOnly -QueryArgs @('container', 'ls', '--all', '--format', '{{.Names}}'))
$allVolumes = @(Invoke-DockerReadOnly -QueryArgs @('volume', 'ls', '--format', '{{.Name}}'))
$allNetworks = @(Invoke-DockerReadOnly -QueryArgs @('network', 'ls', '--format', '{{.Name}}'))

$prodLabel = 'label=com.docker.compose.project=' + $productionProject
$prodContainers = @(Invoke-DockerReadOnly -QueryArgs @('container', 'ls', '--all', '--filter', $prodLabel, '--format', '{{.Names}}'))
$prodVolumes = @(Invoke-DockerReadOnly -QueryArgs @('volume', 'ls', '--filter', $prodLabel, '--format', '{{.Name}}'))
$prodNetworks = @(Invoke-DockerReadOnly -QueryArgs @('network', 'ls', '--filter', $prodLabel, '--format', '{{.Name}}'))

$blockers = @()
if ($prodContainers.Count -gt 0) { $blockers += 'A container already has the production Compose project label.' }
if ($prodVolumes.Count -gt 0) { $blockers += 'A volume already has the production Compose project label.' }
if ($prodNetworks.Count -gt 0) { $blockers += 'A network already has the production Compose project label.' }
if (@($allContainers | Where-Object { $_ -eq 'sbkb-production-db-db-1' -or $_ -eq 'sbkb-production-db_db_1' }).Count -gt 0) {
    $blockers += 'A predicted production DB container name already exists.'
}
if ($allVolumes -contains 'sbkb-production-db_pgdata') {
    $blockers += 'The intended production DB data volume already exists.'
}
if ($allNetworks -contains 'sbkb-production-db_db_private') {
    $blockers += 'The intended production private network already exists.'
}

$rehearsalLabel = 'label=com.docker.compose.project=' + $rehearsalHint
$rehearsalFromLabel = @(Invoke-DockerReadOnly -QueryArgs @('container', 'ls', '--all', '--filter', $rehearsalLabel, '--format', '{{.Names}}'))
$rehearsalFromName = @(Invoke-DockerReadOnly -QueryArgs @('container', 'ls', '--all', '--filter', ('name=' + $rehearsalHint), '--format', '{{.Names}}'))
$rehearsalMatches = @($rehearsalFromLabel + $rehearsalFromName | Sort-Object -Unique)

Write-Host ('Existing Docker inventory: {0} containers, {1} volumes, {2} networks' -f $allContainers.Count, $allVolumes.Count, $allNetworks.Count)
Write-Host ('Rehearsal candidates found by known name/label: {0}' -f $rehearsalMatches.Count)
if ($rehearsalMatches.Count -eq 0) {
    Write-Warning 'The rehearsal environment was not positively identified; manually verify its actual Compose project and containers before any future deployment.'
} else {
    Write-Host ('Rehearsal candidates: {0}' -f ($rehearsalMatches -join ', '))
}
Write-Host 'Existing resources have NOT been stopped, started, altered, or deleted.'

if ($blockers.Count -gt 0) {
    foreach ($reason in $blockers) { Write-Warning $reason }
    throw 'BLOCKED: production-name collision. Do not start or reuse any resource. Ask the operator to inspect ownership.'
}

Write-Host 'READ-ONLY INVENTORY COMPLETE: no expected production-name collisions detected.'
Write-Warning 'This is NOT permission to start production DB. Check free storage/RAM, backups, restoration, credentials, image digest, and approvals separately.'
