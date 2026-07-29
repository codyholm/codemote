#!/bin/sh

set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(dirname -- "$script_dir")

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required for Codemote's local quality tools."
  echo "Install Homebrew, then rerun: pnpm setup:quality"
  exit 1
fi

if ! xcrun --find swift-format >/dev/null 2>&1; then
  echo "Apple swift-format is unavailable. Install the current Xcode command-line tools, then rerun: pnpm setup:quality"
  exit 1
fi

brew bundle --file "$repository_root/Brewfile"

if ! command -v mint >/dev/null 2>&1; then
  echo "Mint was not installed by Homebrew. Resolve the Homebrew error, then rerun: pnpm setup:quality"
  exit 1
fi

cd "$repository_root"
mint bootstrap
