$ErrorActionPreference = "Stop"
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$InstalledService = Join-Path $env:LOCALAPPDATA "FreebuffAPI\app\node_modules\freebuff-local-api\bin\freebuff-api-service.js"
if (Test-Path $InstalledService) {
  node $InstalledService uninstall
} else {
  node (Join-Path $ProjectDir "bin\freebuff-api-service.js") uninstall
}
