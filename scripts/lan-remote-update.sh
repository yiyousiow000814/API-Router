#!/usr/bin/env bash
set -euo pipefail

TARGET_REF="${1:-}"
if [[ -z "${TARGET_REF}" ]]; then
  echo "target ref is required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

sleep 1

if [[ -n "$(git status --porcelain=v1)" ]]; then
  echo "worktree is dirty; refusing remote self-update" >&2
  exit 1
fi

git fetch origin --prune --tags

if git rev-parse --verify "refs/heads/${TARGET_REF}" >/dev/null 2>&1; then
  git checkout "${TARGET_REF}"
  git pull --ff-only origin "${TARGET_REF}"
elif git rev-parse --verify "refs/remotes/origin/${TARGET_REF}" >/dev/null 2>&1; then
  git checkout -B "${TARGET_REF}" "refs/remotes/origin/${TARGET_REF}"
elif git rev-parse --verify "${TARGET_REF}" >/dev/null 2>&1; then
  git checkout --detach "${TARGET_REF}"
else
  echo "cannot resolve git ref: ${TARGET_REF}" >&2
  exit 1
fi

npm run build:root-exe:checked
