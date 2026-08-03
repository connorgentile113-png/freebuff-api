$ErrorActionPreference = "Stop"
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$InstallDir = Join-Path $env:LOCALAPPDATA "FreebuffAPI\app"

function Test-NodeReady {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { return $false }
  $Major = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
  return $Major -ge 20
}

if (-not (Test-NodeReady)) {
  Write-Host "Node.js 20+ and npm were not found. Installing the current Node.js LTS..."
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Install Node.js LTS from https://nodejs.org, then run this installer again."
  }
  winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "Could not install Node.js LTS with winget." }
  $env:Path = "$env:ProgramFiles\nodejs;$env:LOCALAPPDATA\Microsoft\WinGet\Links;$env:Path"
}

if (-not (Test-NodeReady)) {
  throw "Node.js installed, but node/npm are not available yet. Open a new terminal and run this installer again."
}

node (Join-Path $ProjectDir "bin\freebuff-api-setup.js")
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$PackageFile = npm pack $ProjectDir --pack-destination $InstallDir --silent
if ($LASTEXITCODE -ne 0) { throw "Could not package Freebuff API." }
npm install --prefix $InstallDir --omit=dev (Join-Path $InstallDir $PackageFile.Trim())
if ($LASTEXITCODE -ne 0) { throw "Could not install Freebuff API." }
$InstalledPackage = Join-Path $InstallDir "node_modules\freebuff-local-api"
node (Join-Path $InstalledPackage "bin\freebuff-api-service.js") install

Write-Host "Freebuff API is ready at http://127.0.0.1:8787/v1"
