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

remote_update_status_path() {
  if [[ -n "${API_ROUTER_REMOTE_UPDATE_STATUS_PATH:-}" ]]; then
    printf '%s' "${API_ROUTER_REMOTE_UPDATE_STATUS_PATH}"
    return 0
  fi
  if [[ -z "${API_ROUTER_USER_DATA_DIR:-}" ]]; then
    return 1
  fi
  printf '%s' "${API_ROUTER_USER_DATA_DIR}/diagnostics/lan-remote-update-status.json"
}

remote_update_log_path() {
  if [[ -n "${API_ROUTER_REMOTE_UPDATE_LOG_PATH:-}" ]]; then
    printf '%s' "${API_ROUTER_REMOTE_UPDATE_LOG_PATH}"
    return 0
  fi
  if [[ -z "${API_ROUTER_USER_DATA_DIR:-}" ]]; then
    return 1
  fi
  printf '%s' "${API_ROUTER_USER_DATA_DIR}/diagnostics/lan-remote-update.log"
}

write_remote_update_log() {
  local message="$1"
  local log_path
  log_path="$(remote_update_log_path)" || return 0
  mkdir -p "$(dirname "${log_path}")"
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "${message}" >>"${log_path}"
}

step_detail() {
  local label="$1"
  local detail="${2:-}"
  if [[ -n "${detail}" ]]; then
    printf '%s: %s' "${label}" "${detail}"
    return 0
  fi
  printf '%s' "${label}"
}

write_remote_update_status() {
  local state="$1"
  local target_ref="$2"
  local detail="${3:-}"
  local started_at="${4:-null}"
  local finished_at="${5:-null}"
  local status_path
  status_path="$(remote_update_status_path)" || return 0
  mkdir -p "$(dirname "${status_path}")"
  local now
  now="$(python - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
  local accepted_at="${now}"
  if [[ -f "${status_path}" ]]; then
    local existing
    existing="$(python - "${status_path}" <<'PY'
import json, sys
try:
    with open(sys.argv[1], 'r', encoding='utf-8') as fh:
        payload = json.load(fh)
    print(payload.get('accepted_at_unix_ms') or '')
except Exception:
    print('')
PY
)"
    if [[ -n "${existing}" ]]; then
      accepted_at="${existing}"
    fi
  fi
  python - "${status_path}" "${state}" "${target_ref}" "${API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_ID:-}" "${API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_NAME:-}" "${SCRIPT_DIR}/lan-remote-update.sh" "${detail}" "${accepted_at}" "${started_at}" "${finished_at}" "${now}" <<'PY'
import json, sys
path, state, target_ref, requester_node_id, requester_node_name, worker_script, detail, accepted_at, started_at, finished_at, now = sys.argv[1:]
def normalize(value):
    value = (value or '').strip()
    return value or None
def normalize_int(value):
    value = (value or '').strip()
    if not value or value == 'null':
        return None
    return int(value)
payload = {
    "state": state,
    "target_ref": target_ref,
    "requester_node_id": normalize(requester_node_id),
    "requester_node_name": normalize(requester_node_name),
    "worker_script": worker_script,
    "worker_pid": int(__import__("os").getpid()),
    "detail": normalize(detail),
    "accepted_at_unix_ms": int(accepted_at),
    "started_at_unix_ms": normalize_int(started_at),
    "finished_at_unix_ms": normalize_int(finished_at),
    "updated_at_unix_ms": int(now),
}
with open(path, 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, indent=2)
PY
}

sleep 1

STARTED_AT="$(python - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
CURRENT_STEP="Preparing worker"
write_remote_update_log "Starting remote self-update for target ref ${TARGET_REF}"
write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "Starting remote self-update worker.")" "${STARTED_AT}" "null"

trap 'write_remote_update_log "${CURRENT_STEP:-Preparing worker} failed: Remote self-update failed."; write_remote_update_status "failed" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP:-Preparing worker}" "Remote self-update failed.")" "${STARTED_AT}" "$(python - <<'"'"'PY'"'"'
import time
print(int(time.time() * 1000))
PY
)"; exit 1' ERR

CURRENT_STEP="Checking git worktree"
write_remote_update_log "${CURRENT_STEP}"
write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}")" "${STARTED_AT}" "null"
if [[ -n "$(git status --porcelain=v1)" ]]; then
  echo "worktree is dirty; refusing remote self-update" >&2
  exit 1
fi

CURRENT_STEP="Fetching from origin"
write_remote_update_log "${CURRENT_STEP}"
write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}")" "${STARTED_AT}" "null"
git fetch origin --prune --tags

CURRENT_STEP="Resolving target ref"
write_remote_update_log "${CURRENT_STEP}: ${TARGET_REF}"
write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "Target ${TARGET_REF}")" "${STARTED_AT}" "null"
if git rev-parse --verify "refs/heads/${TARGET_REF}" >/dev/null 2>&1; then
  CURRENT_STEP="Checking out local branch"
  write_remote_update_log "${CURRENT_STEP}: ${TARGET_REF}"
  write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "${TARGET_REF}")" "${STARTED_AT}" "null"
  git checkout "${TARGET_REF}"
  CURRENT_STEP="Pulling latest branch"
  write_remote_update_log "${CURRENT_STEP}: ${TARGET_REF}"
  write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "${TARGET_REF}")" "${STARTED_AT}" "null"
  git pull --ff-only origin "${TARGET_REF}"
elif git rev-parse --verify "refs/remotes/origin/${TARGET_REF}" >/dev/null 2>&1; then
  CURRENT_STEP="Checking out remote branch"
  write_remote_update_log "${CURRENT_STEP}: ${TARGET_REF}"
  write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "${TARGET_REF}")" "${STARTED_AT}" "null"
  git checkout -B "${TARGET_REF}" "refs/remotes/origin/${TARGET_REF}"
elif git rev-parse --verify "${TARGET_REF}" >/dev/null 2>&1; then
  CURRENT_STEP="Checking out commit"
  write_remote_update_log "${CURRENT_STEP}: ${TARGET_REF}"
  write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "${TARGET_REF}")" "${STARTED_AT}" "null"
  git checkout --detach "${TARGET_REF}"
else
  echo "cannot resolve git ref: ${TARGET_REF}" >&2
  exit 1
fi

CURRENT_STEP="Building checked EXE"
write_remote_update_log "${CURRENT_STEP}: npm run build:root-exe:checked"
write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "Running npm run build:root-exe:checked")" "${STARTED_AT}" "null"
npm run build:root-exe:checked
FINISHED_AT="$(python - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
CURRENT_STEP="Completed"
write_remote_update_log "Remote self-update completed successfully."
write_remote_update_status "succeeded" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "Remote self-update completed successfully.")" "${STARTED_AT}" "${FINISHED_AT}"
