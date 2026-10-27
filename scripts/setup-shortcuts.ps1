#requires -Version 5.1

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$powershell = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'

if (-not $desktop -or -not (Test-Path -LiteralPath $desktop -PathType Container)) {
    Write-Host 'デスクトップが見つかりません。Windows のデスクトップ設定を確認してください。' -ForegroundColor Red
    exit 1
}

$items = @(
    @{ Name = '研究用学習システム - LAN起動.lnk'; Script = 'start-lan.ps1'; Description = '研究用学習システムのLANモードを起動' },
    @{ Name = '研究用学習システム - 停止.lnk'; Script = 'stop-lan.ps1'; Description = '確認後に研究用学習システムを停止' }
)
foreach ($item in $items) {
    $path = Join-Path $desktop $item.Name
    if (Test-Path -LiteralPath $path) {
        Write-Host ('同名のショートカットが既にあります: {0}' -f $path) -ForegroundColor Yellow
        Write-Host '上書きせずに終了します。作り直す場合は既存のショートカットを移動または削除してください。'
        exit 1
    }
}

try {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($item in $items) {
        $path = Join-Path $desktop $item.Name
        $scriptPath = Join-Path $PSScriptRoot $item.Script
        $shortcut = $shell.CreateShortcut($path)
        $shortcut.TargetPath = $powershell
        $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -NoExit -File "{0}"' -f $scriptPath
        $shortcut.WorkingDirectory = $projectRoot
        $shortcut.Description = $item.Description
        $shortcut.Save()
        Write-Host ('作成しました: {0}' -f $path)
    }
} catch {
    Write-Host ('ショートカットを作成できませんでした。{0}' -f $_.Exception.Message) -ForegroundColor Red
    exit 1
}
