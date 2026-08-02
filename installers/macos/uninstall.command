#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
INSTALL_DIR="$HOME/Library/Application Support/FreebuffAPI/app"
INSTALLED_SERVICE="$INSTALL_DIR/node_modules/freebuff-local-api/bin/freebuff-api-service.js"
if [[ -f "$INSTALLED_SERVICE" ]]; then
  node "$INSTALLED_SERVICE" uninstall
else
  node "$PROJECT_DIR/bin/freebuff-api-service.js" uninstall
fi
