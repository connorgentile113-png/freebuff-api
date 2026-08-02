$ErrorActionPreference = "Stop"
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$InstallDir = Join-Path $env:LOCALAPPDATA "FreebuffAPI\app"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 20 or newer is required."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required."
}

$PrivateFreebuff = Join-Path $HOME ".config\manicode\freebuff.exe"
if (-not (Get-Command freebuff -ErrorAction SilentlyContinue) -and -not (Test-Path $PrivateFreebuff)) {
  npm install --global freebuff
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
