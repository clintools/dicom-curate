#!/usr/bin/env bash
# Pre-push hook. CI runs this script too (.github/workflows/ci.yml), but the
# hook checks the working tree, not the pushed commits.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/hooks/lib.sh
source "$REPO_ROOT/scripts/hooks/lib.sh"

# A stray MERGE_HEAD or rebase dir in CI must not pass the checks unrun.
[[ -n "${CI:-}" ]] || skip_if_merge_or_rebase

# Collapsible per-check log groups in GitHub Actions.
section() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    [[ -n "${in_group:-}" ]] && echo "::endgroup::"
    echo "::group::$1"
    in_group=1
  else
    echo "🔹 $1..."
  fi
}

section "Typecheck"
pnpm tsc --noEmit

section "Lint"
pnpm lint

section "Unit tests"
pnpm test

section "Build"
pnpm build

section "E2E smoke tests"
pnpm test:e2e

section "Integration tests"
pnpm test:integration

# RUN_PUBLIC_CONFORMANCE=0 skips the public suite, which needs network on first run.
section "Conformance tests"
RUN_PUBLIC_CONFORMANCE="${RUN_PUBLIC_CONFORMANCE:-1}" pnpm test:conformance

[[ -n "${in_group:-}" ]] && echo "::endgroup::"
echo "✓ Pre-push validation completed"
