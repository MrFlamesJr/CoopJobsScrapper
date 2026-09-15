$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

Write-Host "Starting Docker Desktop..."
try {
    docker desktop start | Out-Null
} catch {
    $dockerDesktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerDesktop) {
        Start-Process $dockerDesktop
        throw "Docker Desktop is starting. Run .\start.ps1 again in a few seconds."
    }
    throw "Docker Desktop is not installed. Install it before running this script."
}

Write-Host "Starting MySQL, the scraper browser, the API server, and the web app..."

Write-Host "Web app: http://localhost:5300"
Write-Host "Scraper browser: http://localhost:7900"
docker compose up --build --remove-orphans mysql selenium server web
