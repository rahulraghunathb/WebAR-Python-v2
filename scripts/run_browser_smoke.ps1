param(
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$python = (Get-Command python).Source
$browserCandidates = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
)
$browser = $browserCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) {
  throw 'No supported browser was found.'
}

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try {
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

if ($Port -le 0) {
  $Port = Get-FreeTcpPort
}

$baseUrl = 'http://127.0.0.1:' + $Port
$previousHost = $env:WEBAR_HOST
$previousPort = $env:WEBAR_PORT
$env:WEBAR_HOST = '127.0.0.1'
$env:WEBAR_PORT = [string]$Port

$server = Start-Process -FilePath $python -ArgumentList 'app.py' -WorkingDirectory $repo -PassThru -WindowStyle Hidden
$browserProcess = $null
try {
  $ready = $false
  for ($i = 0; $i -lt 40; $i += 1) {
    try {
      $statusResponse = Invoke-WebRequest -Uri ($baseUrl + '/status') -UseBasicParsing
      $statusPayload = $statusResponse.Content | ConvertFrom-Json
      if ($statusPayload.build_signature -eq 'research-webxr-worker-wasm-map-20260309') {
        $ready = $true
        break
      }
    } catch {
    }
    Start-Sleep -Milliseconds 350
  }
  if (-not $ready) {
    throw ('Flask server did not become ready on ' + $baseUrl + ' with the expected build signature.')
  }

  Invoke-WebRequest -Uri ($baseUrl + '/smoke-report') -Method Delete -UseBasicParsing | Out-Null

  $profileDir = Join-Path $env:TEMP ('webar-browser-smoke-profile-' + $Port)
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  $browserArgs = @(
    '--headless=new',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    ('--user-data-dir=' + $profileDir),
    ($baseUrl + '/static/smoke.html')
  )
  $browserProcess = Start-Process -FilePath $browser -ArgumentList $browserArgs -PassThru -WindowStyle Hidden

  $result = $null
  for ($i = 0; $i -lt 40; $i += 1) {
    Start-Sleep -Milliseconds 500
    try {
      $response = Invoke-WebRequest -Uri ($baseUrl + '/smoke-report') -UseBasicParsing
      $payload = $response.Content | ConvertFrom-Json
      if ($payload.status -and $payload.status -in @('PASS', 'FAIL')) {
        $result = $payload
        break
      }
    } catch {
    }
  }

  if (-not $result) {
    try {
      $lastResponse = Invoke-WebRequest -Uri ($baseUrl + '/smoke-report') -UseBasicParsing
      $lastPayload = $lastResponse.Content | ConvertFrom-Json
      $lastPayload | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $repo 'smoke-output.json') -Encoding UTF8
      throw ('Smoke harness did not reach PASS/FAIL. Last status was ' + $lastPayload.status)
    } catch {
      throw 'Smoke harness did not reach PASS/FAIL.'
    }
  }

  $result | Add-Member -NotePropertyName baseUrl -NotePropertyValue $baseUrl -Force
  $result | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $repo 'smoke-output.json') -Encoding UTF8
  if ($result.status -ne 'PASS') {
    throw ('Smoke harness reported ' + $result.status)
  }

  Write-Output ('PASS ' + $baseUrl)
  exit 0
} finally {
  if ($browserProcess -and -not $browserProcess.HasExited) {
    Stop-Process -Id $browserProcess.Id -Force
  }
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force
  }
  if ($null -ne $previousHost) {
    $env:WEBAR_HOST = $previousHost
  } else {
    Remove-Item Env:WEBAR_HOST -ErrorAction SilentlyContinue
  }
  if ($null -ne $previousPort) {
    $env:WEBAR_PORT = $previousPort
  } else {
    Remove-Item Env:WEBAR_PORT -ErrorAction SilentlyContinue
  }
}
