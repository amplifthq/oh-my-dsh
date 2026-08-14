#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "oh-my-dsh requires Node.js 22.19 or newer." >&2
  exit 1
fi

node_version="$(node -p 'process.versions.node')"
node_major="${node_version%%.*}"
node_rest="${node_version#*.}"
node_minor="${node_rest%%.*}"
if ! { [ "$node_major" -eq 22 ] && [ "$node_minor" -ge 19 ]; } \
  && [ "$node_major" -lt 24 ]; then
  echo "oh-my-dsh requires Node.js ^22.19.0 or >=24.0.0 (found $node_version)." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "oh-my-dsh requires npm." >&2
  exit 1
fi

echo "Installing oh-my-dsh..."
npm install --global oh-my-dsh
omd setup
echo "Installed. Run 'omd' to open the Web UI."
