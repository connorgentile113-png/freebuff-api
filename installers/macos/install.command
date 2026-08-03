#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
INSTALL_DIR="$HOME/Library/Application Support/FreebuffAPI/app"

# shellcheck source=../unix/ensure-node.sh
source "$PROJECT_DIR/installers/unix/ensure-node.sh"

node "$PROJECT_DIR/bin/freebuff-api-setup.js"
mkdir -p "$INSTALL_DIR"
PACKAGE_FILE="$(npm pack "$PROJECT_DIR" --pack-destination "$INSTALL_DIR" --silent)"
npm install --prefix "$INSTALL_DIR" --omit=dev "$INSTALL_DIR/$PACKAGE_FILE"
INSTALLED_PACKAGE="$INSTALL_DIR/node_modules/freebuff-local-api"
node "$INSTALLED_PACKAGE/bin/freebuff-api-service.js" install

echo "Freebuff API is ready at http://127.0.0.1:8787/v1"
