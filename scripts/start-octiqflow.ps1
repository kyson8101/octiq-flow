<#
.SYNOPSIS
    Start OctiqFlow on Windows. Closing this window stops it.

.DESCRIPTION
    OctiqFlow is a headless server plus a browser client -- there is no desktop
    app and no Windows service. `octiqflow install` is gated to macOS, and the
    launchd plumbing under scripts/ has no Windows equivalent, so this script is
    the Windows stand-in.

    It is deliberately manual: you start it, it runs; you close this window and
    the server stops, taking every agent it owns with it. Nothing is registered
    to start at boot.

    The port and token come from the active profile's web.json, so the URL it
    opens is the same one across restarts and stays bookmarkable.

.PARAMETER Port
    Override the port from web.json, for this run only.

.PARAMETER Bind
    Override the bind address, for this run only. The server refuses a
    non-loopback bind unless web.json carries a complete Cloudflare Access
    configuration.

.PARAMETER NoOpen
    Start the server without opening a browser.

.EXAMPLE
    .\scripts\start-octiqflow.ps1
#>

[CmdletBinding()]
param(
    [int]    $Port,
    [string] $Bind,
    [switch] $NoOpen
)

$ErrorActionPreference = 'Stop'

function Stop-WithMessage {
    param([string[]] $Lines)
    foreach ($line in $Lines) { Write-Host $line }
    Write-Host ''
    Read-Host 'Press Enter to close' | Out-Null
    exit 1
}

$repo = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $repo 'src-tauri\target\release\octiq-server.exe'

# Both halves or neither. web/dist is read off disk at runtime (web.rs
# v2_root), so a missing client is a blank page rather than a startup error --
# worth catching here instead of in the browser.
if (-not (Test-Path -LiteralPath $exe)) {
    Stop-WithMessage @(
        'octiq-server.exe has not been built.',
        '',
        "Build both halves from $repo :",
        '  pnpm --dir web build',
        '  cargo build --release --bin octiq-server --manifest-path src-tauri\Cargo.toml'
    )
}
if (-not (Test-Path -LiteralPath (Join-Path $repo 'web\dist\index.html'))) {
    Stop-WithMessage @(
        'The browser client has not been built (web\dist\index.html is missing).',
        '',
        '  pnpm --dir web build'
    )
}

# The active profile decides where web.json lives: config.json carries the
# base directory and the active profile name.
# Match paths::home_dir, including HOME overrides used for isolated profiles.
$userHomePath = $env:HOME
if ([string]::IsNullOrEmpty($userHomePath)) { $userHomePath = $env:USERPROFILE }
$octiqHome = Join-Path $userHomePath '.octiqflow'
$base      = Join-Path $octiqHome 'profiles'
$active    = 'default'
$configPath = Join-Path $octiqHome 'config.json'
if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.base)   { $base   = $config.base }
    if ($config.active) { $active = $config.active }
}
$webJson = Join-Path (Join-Path $base $active) 'web.json'

$effectivePort = 1421
$effectiveBind = '127.0.0.1'
$token         = ''
if (Test-Path -LiteralPath $webJson) {
    $web = Get-Content -LiteralPath $webJson -Raw | ConvertFrom-Json
    if ($web.port)  { $effectivePort = [int] $web.port }
    if ($web.bind)  { $effectiveBind = [string] $web.bind }
    if ($web.token) { $token         = [string] $web.token }
}
if ($PSBoundParameters.ContainsKey('Port')) { $effectivePort = $Port }
if ($PSBoundParameters.ContainsKey('Bind')) { $effectiveBind = $Bind }
$tokenOverride = [Environment]::GetEnvironmentVariable('OCTIQ_WEB_TOKEN')
if ($null -ne $tokenOverride) { $token = $tokenOverride }

# One server at a time. A second one would bind-fail anyway, but saying so here
# is clearer than a Rust panic scrolling past.
$listening = Get-NetTCPConnection -LocalPort $effectivePort -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Stop-WithMessage @(
        "Something is already listening on port $effectivePort -- OctiqFlow is probably already running.",
        'Close its window first, or pass -Port to start a second one on another port.'
    )
}

# The retired desktop app owns the same profile. Two owners overwrite each
# other's project list silently, which is the one failure the profile lock
# exists to make visible -- and it cannot see an app that never claimed it.
$desktop = Get-Process -Name 'octiq-flow' -ErrorAction SilentlyContinue
if ($desktop) {
    Write-Host ''
    Write-Host 'WARNING: the old OctiqFlow desktop app is running.' -ForegroundColor Yellow
    Write-Host 'It uses this same profile, and two owners overwrite each' -ForegroundColor Yellow
    Write-Host "other's project list without any error. Close it first." -ForegroundColor Yellow
    Write-Host ''
    $answer = Read-Host 'Start anyway? [y/N]'
    if ($answer -ne 'y') { exit 1 }
}

# A bind address is not always a reachable host: 0.0.0.0 means "every
# interface", which no browser can dial.
$hostName = $effectiveBind
if ($hostName -eq '0.0.0.0') { $hostName = '127.0.0.1' }
if ($hostName -eq '::' -or $hostName -eq '[::]') { $hostName = '[::1]' }
$connectHost = $hostName.Trim('[', ']')
$baseUrl = "http://${hostName}:${effectivePort}/"
$url = $baseUrl
if ($token) { $url += '?token=' + [Uri]::EscapeDataString($token) }

Write-Host ''
Write-Host 'OctiqFlow' -ForegroundColor Cyan
Write-Host "  server   $exe"
Write-Host "  profile  $active"
Write-Host "  url      $url"
Write-Host ''
Write-Host 'Close this window to stop the server and every agent it owns.' -ForegroundColor DarkGray
Write-Host ''

# Open the browser only once the port actually answers -- a browser pointed at
# a port that is not up yet just shows a connection error and does not retry.
$browserJob = $null
if (-not $NoOpen) {
    $browserJob = Start-Job -ScriptBlock {
        param($JobHost, $JobPort, $JobUrl, $JobWebJson, $JobTokenOverride)
        $ErrorActionPreference = 'Stop'
        for ($i = 0; $i -lt 60; $i++) {
            $client = $null
            try {
                $client = New-Object System.Net.Sockets.TcpClient
                $client.Connect($JobHost, $JobPort)
                $client.Close()
                # On first launch web::load_config creates the token only
                # after the server starts. Read it here, never before spawn.
                $jobToken = $JobTokenOverride
                if ($null -eq $jobToken) {
                    $jobWeb = Get-Content -LiteralPath $JobWebJson -Raw | ConvertFrom-Json
                    $jobToken = [string] $jobWeb.token
                }
                if ([string]::IsNullOrWhiteSpace($jobToken)) {
                    throw 'The server token is not ready yet.'
                }
                Start-Process ($JobUrl + '?token=' + [Uri]::EscapeDataString($jobToken))
                return
            } catch {
                Start-Sleep -Milliseconds 500
            } finally {
                if ($null -ne $client) { $client.Dispose() }
            }
        }
    } -ArgumentList $connectHost, $effectivePort, $baseUrl, $webJson, $tokenOverride
}

# Env overrides win over web.json and are never written back (web.rs applies
# them after the only save), so they stay scoped to this run.
$env:OCTIQ_WEB      = '1'
$env:OCTIQ_WEB_PORT = "$effectivePort"
$env:OCTIQ_WEB_BIND = $effectiveBind

try {
    # Foreground, on purpose. The server is a child of this console, so closing
    # the window delivers CTRL_CLOSE_EVENT and takes the server down with it --
    # which is exactly the start-it/stop-it behaviour this script is for.
    & $exe
} finally {
    if ($null -ne $browserJob) {
        Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue
    }
    Write-Host ''
    Write-Host 'OctiqFlow stopped.' -ForegroundColor DarkGray
}
