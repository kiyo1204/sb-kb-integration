#requires -Version 5.1

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $projectRoot 'compose.yaml'
$lanComposeFile = Join-Path $projectRoot 'compose.lan.yaml'
$envFile = Join-Path $projectRoot '.env'

if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    Write-Host '設定ファイル .env がありません。README の「初回起動」に従って作成し、研究者コードを設定してください。' -ForegroundColor Yellow
    exit 1
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host 'Docker が見つかりません。Docker Desktop をインストールして起動してください。' -ForegroundColor Yellow
    exit 1
}

$null = & docker info --format '{{.ServerVersion}}' 2>$null
$dockerReady = $LASTEXITCODE -eq 0
if (-not $dockerReady) {
    $dockerDesktopPath = @(
        "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
        "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1

    if (-not $dockerDesktopPath) {
        Write-Host 'Docker Desktop を見つけられません。Docker Desktop を起動してから再実行してください。' -ForegroundColor Yellow
        exit 1
    }

    Write-Host 'Docker Desktop を起動し、利用可能になるまで待っています（最大3分）。'
    try {
        Start-Process -FilePath $dockerDesktopPath | Out-Null
    } catch {
        Write-Host ('Docker Desktop を起動できませんでした。{0}' -f $_.Exception.Message) -ForegroundColor Yellow
        exit 1
    }

    $deadline = (Get-Date).AddMinutes(3)
    $nextStatusAt = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        $null = & docker info --format '{{.ServerVersion}}' 2>$null
        $dockerReady = $LASTEXITCODE -eq 0
        if ($dockerReady) { break }
        if ((Get-Date) -ge $nextStatusAt) {
            Write-Host 'Docker Engine の準備中です。Docker Desktop が起動したままお待ちください。'
            $nextStatusAt = (Get-Date).AddSeconds(15)
        }
    }

    if (-not $dockerReady) {
        Write-Host 'Docker Engine に接続できませんでした。Docker Desktop の画面に追加操作やエラーが出ていないか確認してから、もう一度起動してください。' -ForegroundColor Yellow
        exit 1
    }
    Write-Host 'Docker Engine を確認しました。'
}

$candidates = @(
    foreach ($adapter in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($adapter.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up -or
            $adapter.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) { continue }
        try { $addresses = $adapter.GetIPProperties().UnicastAddresses } catch { continue }
        foreach ($address in $addresses) {
            $ip = $address.Address
            if ($ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
            $octets = $ip.GetAddressBytes()
            if ([System.Net.IPAddress]::IsLoopback($ip) -or $octets[0] -eq 0 -or
                ($octets[0] -eq 169 -and $octets[1] -eq 254) -or $octets[0] -ge 224) { continue }
            $virtualHint = ($adapter.Name + ' ' + $adapter.Description) -match 'Docker|WSL|Hyper-V|Virtual|VMware|VirtualBox|VPN|Tailscale|WireGuard'
            [pscustomobject]@{ Name = $adapter.Name; Description = $adapter.Description; Address = $ip.ToString(); VirtualHint = $virtualHint }
        }
    }
)

if ($candidates.Count -eq 0) {
    Write-Host '利用できる IPv4 アドレスが見つかりません。Wi-Fi または Ethernet に接続してから再実行してください。' -ForegroundColor Yellow
    exit 1
}

Write-Host 'この LAN モードは開発・模擬データ専用です。HTTP 通信は暗号化されません。' -ForegroundColor Yellow
Write-Host '参加者と同じ閉じた LAN の IPv4 アドレスを選んでください。インターネット向けのアドレスは選ばないでください。'
for ($index = 0; $index -lt $candidates.Count; $index++) {
    $candidate = $candidates[$index]
    $hint = if ($candidate.VirtualHint) { ' [仮想・VPNの可能性あり：接続先を確認]' } else { '' }
    Write-Host ('{0}. {1}  {2} ({3}){4}' -f ($index + 1), $candidate.Address, $candidate.Name, $candidate.Description, $hint)
}

do {
    $choice = (Read-Host '番号または一覧のIPv4アドレスを入力してください（中止は Q）').Trim()
    if ($choice -match '^[Qq]$') { Write-Host '起動を中止しました。'; exit 0 }
    $selectedNumber = 0
    $selectedIndex = -1
    $matchingIndexes = @()
    $validChoice = $false
    if ([int]::TryParse($choice, [ref]$selectedNumber)) {
        if ($selectedNumber -ge 1 -and $selectedNumber -le $candidates.Count) {
            $selectedIndex = $selectedNumber - 1
            $validChoice = $true
        }
    } else {
        $matchingIndexes = @(
            for ($index = 0; $index -lt $candidates.Count; $index++) {
                if ($candidates[$index].Address -eq $choice) { $index }
            }
        )
        if ($matchingIndexes.Count -eq 1) {
            $selectedIndex = [int]$matchingIndexes[0]
            $validChoice = $true
        } elseif ($matchingIndexes.Count -gt 1) {
            Write-Host '同じIPv4アドレスの候補が複数あります。番号で選んでください。' -ForegroundColor Yellow
        }
    }
    if (-not $validChoice -and $matchingIndexes.Count -eq 0) {
        Write-Host '一覧に表示された番号またはIPv4アドレスを入力してください。' -ForegroundColor Yellow
    }
} until ($validChoice)

$selected = $candidates[$selectedIndex]
$oldBindAddress = $env:FRONTEND_BIND_ADDRESS
try {
    $env:FRONTEND_BIND_ADDRESS = $selected.Address
    Push-Location -LiteralPath $projectRoot
    try {
        $null = & docker compose --project-directory $projectRoot -f $composeFile -f $lanComposeFile config --quiet 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw '設定を読み込めません。.env の必須項目と Docker Compose を確認してください。'
        }

        Write-Host 'フロントエンドと内部サービスを起動しています。'
        & docker compose --project-directory $projectRoot -f $composeFile -f $lanComposeFile up --build -d --wait --wait-timeout 180
        if ($LASTEXITCODE -ne 0) { throw '起動できませんでした。Docker Desktop とポートの使用状況を確認してください。' }

        $frontendIds = @(& docker compose --project-directory $projectRoot -f $composeFile -f $lanComposeFile ps -q frontend 2>$null)
        if ($LASTEXITCODE -ne 0 -or $frontendIds.Count -ne 1) { throw 'フロントエンドの起動状態を確認できません。' }
        $portJson = & docker inspect --format '{{json .NetworkSettings.Ports}}' $frontendIds[0] 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'フロントエンドの公開先を確認できません。' }
        $bindings = @(($portJson | ConvertFrom-Json).'5173/tcp')
        $lanBinding = @($bindings | Where-Object { $_.HostIp -eq $selected.Address })
        $localBinding = @($bindings | Where-Object { $_.HostIp -eq '127.0.0.1' })
        $apiPort = @(& docker compose --project-directory $projectRoot -f $composeFile -f $lanComposeFile port api 3000 2>$null)
        $dbPort = @(& docker compose --project-directory $projectRoot -f $composeFile -f $lanComposeFile port db 5432 2>$null)
        if ($bindings.Count -ne 2 -or $lanBinding.Count -ne 1 -or $localBinding.Count -ne 1 -or
            $lanBinding[0].HostPort -ne $localBinding[0].HostPort -or
            $apiPort.Count -ne 1 -or $apiPort[0] -notmatch '^127\.0\.0\.1:\d+$' -or
            $dbPort.Count -ne 1 -or $dbPort[0] -notmatch '^127\.0\.0\.1:\d+$') {
            throw 'ポートの公開先を確認できません。README の手順に従ってコンテナを停止し、公開設定を確認してください。'
        }
        $portNumber = [int]$lanBinding[0].HostPort
        Write-Host ''
        Write-Host ('参加者用 URL: http://{0}:{1}' -f $selected.Address, $portNumber) -ForegroundColor Green
        Write-Host ('選択したアダプター: {0}' -f $selected.Name)
        Write-Host ('Windows ファイアウォールではプライベートネットワークの TCP {0} のみを手動で許可してください。' -f $portNumber)
        Write-Host '停止: デスクトップの「研究用学習システム - 停止」を開いてください。'
        try {
            Start-Process -FilePath ('http://localhost:{0}' -f $portNumber)
        } catch {
            Write-Host ('研究者画面を自動で開けませんでした。http://localhost:{0} をブラウザーで開いてください。' -f $portNumber) -ForegroundColor Yellow
        }
    } finally {
        Pop-Location
    }
} catch {
    Write-Host ('LAN モードを開始できませんでした。{0}' -f $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($null -eq $oldBindAddress) { Remove-Item Env:\FRONTEND_BIND_ADDRESS -ErrorAction SilentlyContinue }
    else { $env:FRONTEND_BIND_ADDRESS = $oldBindAddress }
}
