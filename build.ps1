# CoopJobs Windows executable builder
# Builds dist\CoopJobs.exe using PyInstaller

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot

Write-Host "Building CoopJobs.exe..." -ForegroundColor Cyan

# Ensure dev deps installed
$venvPath = "$repoRoot\.venv"
if (-not (Test-Path $venvPath)) {
    Write-Host "Error: .venv not found. Run .\start.ps1 first." -ForegroundColor Red
    exit 1
}

Write-Host "Installing dev dependencies..." -ForegroundColor Cyan
& "$venvPath\Scripts\python.exe" -m pip install -q -r "$repoRoot\requirements-dev.txt"
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

# Build web UI
Write-Host "Building web UI..." -ForegroundColor Cyan
Push-Location "$repoRoot\web"
try {
    if (Test-Path "package-lock.json") {
        npm ci
    } else {
        npm install
    }
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm build failed" }
} finally {
    Pop-Location
}

# Build executable
Write-Host "Running PyInstaller..." -ForegroundColor Cyan
Push-Location $repoRoot
try {
    & "$venvPath\Scripts\pyinstaller.exe" --noconfirm --onefile `
        --name CoopJobs `
        --add-data "app\schema.sql;app" `
        --add-data "web\dist;web\dist" `
        --collect-all selenium `
        run_app.py
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
} finally {
    Pop-Location
}

Write-Host "Build complete! Executable: $repoRoot\dist\CoopJobs.exe" -ForegroundColor Green
