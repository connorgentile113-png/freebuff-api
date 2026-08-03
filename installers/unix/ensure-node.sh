#!/usr/bin/env bash

node_is_ready() {
  command -v node >/dev/null 2>&1 \
    && command -v npm >/dev/null 2>&1 \
    && [[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 20' 2>/dev/null)" == "true" ]]
}

if ! node_is_ready; then
  echo "Node.js 20+ and npm were not found. Installing the current Node.js LTS for this user…"
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to install Node.js automatically. Install curl, then run this installer again." >&2
    return 1
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  curl --fail --silent --show-error --location \
    https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | PROFILE=/dev/null bash

  set +u
  # shellcheck source=/dev/null
  source "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm alias default 'lts/*'
  set -u
fi

if ! node_is_ready; then
  echo "Node.js 20+ and npm could not be installed automatically." >&2
  return 1
fi
