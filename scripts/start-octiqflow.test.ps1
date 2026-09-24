# Run with: pwsh -NoProfile -File scripts/start-octiqflow.test.ps1
# Execute the real launcher with in-memory files and process/job boundaries.
# No server, browser, user profile, or unrelated PowerShell job is touched.
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'start-octiqflow.ps1'

function Assert-Equal($Actual, $Expected, [string] $Because) {
    if ($Actual -cne $Expected) {
        throw "$Because -- expected '$Expected', got '$Actual'"
    }
}

function Invoke-LauncherCase {
    param([switch] $Fresh, [switch] $NoOpen, [string] $Bind = '127.0.0.1', [switch] $FailServer)

    $expectedHome = $env:HOME
    if ([string]::IsNullOrEmpty($expectedHome)) { $expectedHome = $env:USERPROFILE }
    $configPath = Join-Path (Join-Path $expectedHome '.octiqflow') 'config.json'
    $profileBase = Join-Path ([System.IO.Path]::GetTempPath()) 'octiq-launcher-test-profiles'
    $webPath = Join-Path (Join-Path $profileBase 'test-profile') 'web.json'
    $exePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri/target/release/octiq-server.exe'
    $caseState = @{
        ExpectedConfigPath = $configPath
        WebExists = -not $Fresh
        Reads = @()
        Opened = @()
        Removed = @()
        Connections = @()
        Job = $null
        Launched = $false
    }

    function Test-Path {
        param([string] $LiteralPath)
        if ($LiteralPath -eq $caseState.ExpectedConfigPath) { return $true }
        if ($LiteralPath -eq $webPath) { return $caseState.WebExists }
        return $LiteralPath -match '(octiq-server\.exe|index\.html)$'
    }
    function Get-Content {
        param([string] $LiteralPath, [switch] $Raw)
        $caseState.Reads += $LiteralPath
        if ($LiteralPath -eq $caseState.ExpectedConfigPath) {
            return (@{ base = $profileBase; active = 'test-profile' } | ConvertTo-Json)
        }
        if ($LiteralPath -eq $webPath -and $caseState.WebExists) {
            return (@{ port = 1429; bind = $Bind; token = 'generated-token' } | ConvertTo-Json)
        }
        throw "Unexpected profile read: $LiteralPath"
    }
    function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) }
    function Get-Process { param($Name, $ErrorAction) }
    function Write-Host { param($Object, $ForegroundColor) }
    function Start-Sleep {
        param($Milliseconds)
        $caseState.LastRetryError = $Error[0]
    }
    function Start-Process {
        param([string] $FilePath)
        $caseState.Opened += $FilePath
    }
    function New-Object {
        param([string] $TypeName)
        if ($TypeName -ne 'System.Net.Sockets.TcpClient') { throw "Unexpected type: $TypeName" }
        $client = [PSCustomObject]@{}
        $client | Add-Member ScriptMethod Connect {
            param($Address, $Port)
            $caseState.Connections += "${Address}:$Port"
        }
        $client | Add-Member ScriptMethod Close {}
        $client | Add-Member ScriptMethod Dispose {}
        return $client
    }
    function Start-Job {
        param([scriptblock] $ScriptBlock, [object[]] $ArgumentList)
        $caseState.Job = [PSCustomObject]@{ Id = 123; ScriptBlock = $ScriptBlock; ArgumentList = $ArgumentList }
        return $caseState.Job
    }
    function Get-Job {
        param($ErrorAction)
        [PSCustomObject]@{ Id = 456 } # An unrelated job belonging to the caller.
        if ($caseState.Job) { $caseState.Job }
    }
    function Remove-Job {
        [CmdletBinding()]
        param([Parameter(ValueFromPipeline)] $Job, [switch] $Force)
        process { $caseState.Removed += $Job.Id }
    }
    function Invoke-FakeServer {
        $caseState.Launched = $true
        if ($FailServer) { throw 'Simulated server failure' }
        # This is when web::load_config creates web.json on a fresh profile.
        $caseState.WebExists = $true
        if ($caseState.Job) {
            $jobScript = $caseState.Job.ScriptBlock
            $jobArgs = $caseState.Job.ArgumentList
            & $jobScript @jobArgs
        }
    }
    Set-Alias -Name $exePath -Value Invoke-FakeServer
    $arguments = @{ NoOpen = $NoOpen; Port = 1429; Bind = $Bind }
    try {
        & $launcher @arguments | Out-Null
    } catch {
        if (-not $FailServer -or $_ -notmatch 'Simulated server failure') { throw }
    }
    Assert-Equal $caseState.Launched $true 'The server must be launched'
    if ($caseState.LastRetryError) { throw "Browser readiness failed: $($caseState.LastRetryError)" }
    return $caseState
}

# USERPROFILE deliberately differs from an existing HOME. File access is
# mocked above, so neither home directory is read or written by these tests.
$savedEnvironment = @{}
foreach ($name in @('USERPROFILE', 'OCTIQ_WEB', 'OCTIQ_WEB_PORT', 'OCTIQ_WEB_BIND', 'OCTIQ_WEB_TOKEN')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
}
$failures = 0
try {
    $env:USERPROFILE = Join-Path ([System.IO.Path]::GetTempPath()) 'octiq-launcher-userprofile'
    Remove-Item Env:OCTIQ_WEB_TOKEN -ErrorAction SilentlyContinue
    $cases = [ordered]@{
        'Uses the backend home precedence and active profile' = {
            $result = Invoke-LauncherCase
            Assert-Equal ($result.Reads -contains $result.ExpectedConfigPath) $true 'Use the same home directory as Rust'
            Assert-Equal $result.Opened[0] 'http://127.0.0.1:1429/?token=generated-token' 'Open the selected profile'
        }
        'Opens a fresh profile after the server generates its token' = {
            $result = Invoke-LauncherCase -Fresh
            Assert-Equal $result.Opened.Count 1 'First startup must open a browser'
            Assert-Equal $result.Opened[0] 'http://127.0.0.1:1429/?token=generated-token' 'Use the generated token'
        }
        'Removes only its own browser job' = {
            $result = Invoke-LauncherCase
            Assert-Equal ($result.Removed -join ',') '123' 'Keep unrelated jobs'
        }
        'NoOpen creates and removes no jobs' = {
            $result = Invoke-LauncherCase -NoOpen
            Assert-Equal $result.Opened.Count 0 'NoOpen must suppress the browser'
            Assert-Equal $result.Removed.Count 0 'NoOpen must preserve every caller job'
        }
        'Server failure cleans up only its own job' = {
            $result = Invoke-LauncherCase -FailServer
            Assert-Equal ($result.Removed -join ',') '123' 'Failure must preserve unrelated jobs'
        }
        'Readiness uses the configured bind address' = {
            $result = Invoke-LauncherCase -Bind '127.0.0.2'
            Assert-Equal $result.Connections[0] '127.0.0.2:1429' 'Probe the host that the server binds'
            Assert-Equal $result.Opened[0] 'http://127.0.0.2:1429/?token=generated-token' 'Open that same host'
        }
        'IPv6 readiness and browser URL use the right address forms' = {
            $result = Invoke-LauncherCase -Bind '[::1]'
            Assert-Equal $result.Connections[0] '::1:1429' 'TcpClient needs an unbracketed address'
            Assert-Equal $result.Opened[0] 'http://[::1]:1429/?token=generated-token' 'URLs need IPv6 brackets'
        }
        'Honors and encodes the server token override' = {
            $env:OCTIQ_WEB_TOKEN = 'override&token'
            try {
                $result = Invoke-LauncherCase -Fresh
                Assert-Equal $result.Opened[0] 'http://127.0.0.1:1429/?token=override%26token' 'Use the effective server token'
            } finally {
                Remove-Item Env:OCTIQ_WEB_TOKEN -ErrorAction SilentlyContinue
            }
        }
    }
    foreach ($case in $cases.GetEnumerator()) {
        try {
            & $case.Value
            Write-Host "PASS: $($case.Key)"
        } catch {
            $failures++
            Write-Host "FAIL: $($case.Key): $_"
        }
    }
} finally {
    foreach ($name in $savedEnvironment.Keys) {
        if ($null -eq $savedEnvironment[$name]) {
            Remove-Item "Env:$name" -ErrorAction SilentlyContinue
        } else {
            [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name])
        }
    }
}
if ($failures) { throw "$failures launcher test(s) failed" }
