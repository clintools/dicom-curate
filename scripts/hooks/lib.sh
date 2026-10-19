#!/usr/bin/env bash
# Shared helpers for Husky git hooks.

set -euo pipefail

# Skip hooks during merge/rebase to avoid blocking git operations.
skip_if_merge_or_rebase() {
  local git_dir
  git_dir="$(git rev-parse --git-dir 2>/dev/null || echo "")"
  if [[ -z "$git_dir" ]]; then
    return 0
  fi
  if [[ -f "${git_dir}/MERGE_HEAD" ]] || [[ -d "${git_dir}/rebase-merge" ]] || [[ -d "${git_dir}/rebase-apply" ]]; then
    echo "⏭️  Skipping hook during merge/rebase"
    exit 0
  fi
}
