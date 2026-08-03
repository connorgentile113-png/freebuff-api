#!/usr/bin/env bash

native_build_tools_are_ready() {
  command -v python3 >/dev/null 2>&1 \
    && command -v make >/dev/null 2>&1 \
    && { command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1; }
}

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v doas >/dev/null 2>&1; then
    doas "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    return 126
  fi
}

if ! native_build_tools_are_ready && [[ -f /etc/alpine-release ]]; then
  echo "Alpine needs a native compiler for node-pty. Installing python3 and build-base…"
  if ! run_as_root apk add --no-cache python3 build-base; then
    echo "Could not install Alpine build tools automatically." >&2
    echo "Run 'doas apk add --no-cache python3 build-base' (or use sudo/root), then run this installer again." >&2
    return 1
  fi
fi

if ! native_build_tools_are_ready; then
  echo "A C++ compiler, make, and Python 3 are required to install node-pty on this Linux system." >&2
  return 1
fi
