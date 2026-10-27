#requires -Version 5.1

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $projectRoot 'compose.yaml'
$mutex = [System.Threading.Mutex]::new($false, 'Global\Stage1ResearchSystemStop')
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) {
        Write-Host '別の停止操作が進行中です。' -ForegroundColor Yellow
        return
    }
    Write-Host 'システムを停止すると、参加者全員の接続が終了します。' -ForegroundColor Yellow
    Write-Host '保存済みのデータベースは保持されます。'
    $answer = Read-Host '停止する場合は Y、やめる場合はそれ以外を入力してください'
    if ($answer -notmatch '^[Yy]$') { Write-Host '停止を中止しました。'; return }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host 'Docker が見つかりません。Docker Desktop を確認してください。' -ForegroundColor Red
        return
    }
    $previousAddress = $env:FRONTEND_BIND_ADDRESS
    try {
        $env:FRONTEND_BIND_ADDRESS = '127.0.0.1'
        Push-Location -LiteralPath $projectRoot
        try {
            & docker compose --project-directory $projectRoot -f $composeFile down
            if ($LASTEXITCODE -ne 0) { throw '停止できませんでした。Docker Desktop の状態を確認してください。' }
            Write-Host 'システムを停止しました。保存済みのデータベースは保持されています。' -ForegroundColor Green
        } finally { Pop-Location }
    } finally {
        if ($null -eq $previousAddress) { Remove-Item Env:\FRONTEND_BIND_ADDRESS -ErrorAction SilentlyContinue }
        else { $env:FRONTEND_BIND_ADDRESS = $previousAddress }
    }
} catch {
    Write-Host ('停止できませんでした。{0}' -f $_.Exception.Message) -ForegroundColor Red
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
