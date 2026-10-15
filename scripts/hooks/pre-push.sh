#!/usr/bin/env bash
# Pre-push hook — the CI checks. CI runs this script too
# (.github/workflows/ci.yml), so a push that passes here passes CI.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/hooks/lib.sh
source "$REPO_ROOT/scripts/hooks/lib.sh"

skip_if_merge_or_rebase

echo "🔹 Running typecheck..."
pnpm tsc --noEmit

echo "🔹 Running lint..."
pnpm lint

echo "🔹 Running unit tests..."
pnpm test

echo "🔹 Running build..."
pnpm build

echo "🔹 Running E2E smoke tests..."
pnpm test:e2e

echo "🔹 Running integration tests..."
pnpm test:integration

echo "🔹 Running conformance tests..."
RUN_PUBLIC_CONFORMANCE=1 pnpm test:conformance

echo "✓ Pre-push validation completed"
