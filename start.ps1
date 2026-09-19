# CoopJobs startup script for Windows development
[CmdletBinding()]
param(
    [switch]$Rebuild
)

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot

# Create and activate venv if missing
$venvPath = "$repoRoot\.venv"
$markerFile = "$venvPath\.installed"

if (-not (Test-Path $venvPath)) {
    Write-Host "Creating virtual environment..." -ForegroundColor Cyan
    python -m venv $venvPath
}

# Install dependencies only if requirements.txt is newer than marker
$reqFile = "$repoRoot\requirements.txt"
if ((Test-Path $reqFile) -and (-not (Test-Path $markerFile) -or (Get-Item $reqFile).LastWriteTime -gt (Get-Item $markerFile).LastWriteTime)) {
    Write-Host "Installing dependencies..." -ForegroundColor Cyan
    & "$venvPath\Scripts\python.exe" -m pip install -q -r $reqFile
    if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
    (Get-Date) | Out-File $markerFile -Encoding utf8
}

# Build web UI if missing or -Rebuild given
$webDistIndex = "$repoRoot\web\dist\index.html"
if ($Rebuild -or -not (Test-Path $webDistIndex)) {
    Write-Host "Building web UI..." -ForegroundColor Cyan
    Push-Location "$repoRoot\web"
    try {
        if (Test-Path "package-lock.json") {
            npm ci
        } else {
            npm install
        }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm build failed" }
    } finally {
        Pop-Location
    }
}

# Run the app
Write-Host "Starting app..." -ForegroundColor Cyan
& "$venvPath\Scripts\python.exe" -m app
if ($LASTEXITCODE -ne 0) { throw "App exited with error" }
