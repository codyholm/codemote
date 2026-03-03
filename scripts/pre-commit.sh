#!/bin/sh
# Pre-commit hook: only run TypeScript toolchain when TS/JS/JSON files are staged.
# Swift-only, shell-only, or docs-only commits skip these checks automatically.
# CI runs the full suite regardless, so nothing slips through.

if git diff --cached --name-only --diff-filter=ACMR | grep -qE '\.(ts|tsx|js|mjs|json)$'; then
  pnpm format:exports && pnpm lint && pnpm typecheck
fi
