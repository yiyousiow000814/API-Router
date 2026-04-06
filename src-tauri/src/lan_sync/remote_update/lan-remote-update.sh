#!/usr/bin/env bash
set -euo pipefail

TARGET_REF="${1:-}"
if [[ -z "${TARGET_REF}" ]]; then
  echo "target ref is required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
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

format_command_output_summary() {
  local output="${1:-}"
  if [[ -z "${output}" ]]; then
    return 0
  fi
  printf '%s' "${output}" | tr '\r\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//' | tail -c 800
}

write_command_output_log() {
  local output="${1:-}"
  if [[ -z "${output}" ]]; then
    return 0
  fi
  while IFS= read -r line; do
    [[ -n "${line}" ]] && write_remote_update_log "${line}"
  done <<<"${output}"
}

write_remote_update_status() {
  local state="$1"
  local target_ref="$2"
  local detail="${3:-}"
  local phase="${4:-}"
  local label="${5:-}"
  local source_name="${6:-worker}"
  local started_at="${7:-null}"
  local finished_at="${8:-null}"
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
  local request_id="${API_ROUTER_REMOTE_UPDATE_REQUEST_ID:-}"
  local timeline_json='[]'
  if [[ -f "${status_path}" ]]; then
    local existing
    existing="$(python - "${status_path}" <<'PY'
import json, sys
try:
    with open(sys.argv[1], 'r', encoding='utf-8') as fh:
        payload = json.load(fh)
    print(json.dumps({
        'accepted_at_unix_ms': payload.get('accepted_at_unix_ms'),
        'request_id': payload.get('request_id'),
        'timeline': payload.get('timeline') or [],
    }))
except Exception:
    print('{}')
PY
)"
    local parsed_existing
    parsed_existing="$(python - "${existing}" <<'PY'
import json, sys
payload = json.loads(sys.argv[1] or '{}')
accepted_at = payload.get('accepted_at_unix_ms')
request_id = payload.get('request_id')
timeline = payload.get('timeline') or []
print(accepted_at or '')
print(request_id or '')
print(json.dumps(timeline))
PY
)"
    accepted_at="$(printf '%s' "${parsed_existing}" | sed -n '1p')"
    request_id="${request_id:-$(printf '%s' "${parsed_existing}" | sed -n '2p')}"
    timeline_json="$(printf '%s' "${parsed_existing}" | sed -n '3p')"
    if [[ -z "${accepted_at}" ]]; then
      accepted_at="${now}"
    fi
  fi
  python - "${status_path}" "${state}" "${target_ref}" "${request_id}" "${API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_ID:-}" "${API_ROUTER_REMOTE_UPDATE_REQUESTER_NODE_NAME:-}" "${SCRIPT_DIR}/lan-remote-update.sh" "$$" "${detail}" "${phase}" "${label}" "${source_name}" "${accepted_at}" "${started_at}" "${finished_at}" "${now}" "${timeline_json}" <<'PY'
import json, sys
(
    path,
    state,
    target_ref,
    request_id,
    requester_node_id,
    requester_node_name,
    worker_script,
    worker_pid,
    detail,
    phase,
    label,
    source_name,
    accepted_at,
    started_at,
    finished_at,
    now,
    timeline_json,
) = sys.argv[1:]
def normalize(value):
    value = (value or '').strip()
    return value or None
def normalize_int(value):
    value = (value or '').strip()
    if not value or value == 'null':
        return None
    return int(value)
timeline = json.loads(timeline_json or '[]')
timeline_detail = normalize(detail)
timeline_phase = normalize(phase) or state
timeline_label = normalize(label) or state
timeline_source = normalize(source_name) or 'worker'
last_timeline = timeline[-1] if timeline else None
is_duplicate = bool(
    last_timeline
    and str(last_timeline.get('phase') or '') == str(timeline_phase or '')
    and str(last_timeline.get('label') or '') == str(timeline_label or '')
    and str(last_timeline.get('source') or '') == str(timeline_source or '')
    and str(last_timeline.get('state') or '') == str(state or '')
    and str(last_timeline.get('detail') or '') == str(timeline_detail or '')
)
if not is_duplicate:
    timeline.append({
        "unix_ms": int(now),
        "phase": timeline_phase,
        "label": timeline_label,
        "detail": timeline_detail,
        "source": timeline_source,
        "state": state,
    })
if len(timeline) > 24:
    timeline = timeline[-24:]
payload = {
    "state": state,
    "target_ref": target_ref,
    "request_id": normalize(request_id),
    "requester_node_id": normalize(requester_node_id),
    "requester_node_name": normalize(requester_node_name),
    "worker_script": worker_script,
    "worker_pid": normalize_int(worker_pid),
    "detail": normalize(detail),
    "accepted_at_unix_ms": int(accepted_at),
    "started_at_unix_ms": normalize_int(started_at),
    "finished_at_unix_ms": normalize_int(finished_at),
    "updated_at_unix_ms": int(now),
    "timeline": timeline,
}
with open(path, 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, indent=2)
PY
}

fail_remote_update() {
  local detail="$1"
  local phase="${2:-failed}"
  local label="${3:-${CURRENT_STEP:-Preparing worker} failed}"
  if [[ "${REMOTE_UPDATE_FAILURE_RECORDED:-0}" == "1" ]]; then
    exit 1
  fi
  REMOTE_UPDATE_FAILURE_RECORDED=1
  local finished_at
  finished_at="$(python - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
  write_remote_update_log "${CURRENT_STEP:-Preparing worker} failed: ${detail}"
  write_remote_update_status "failed" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP:-Preparing worker}" "${detail}")" "${phase}" "${label}" "worker" "${STARTED_AT}" "${finished_at}"
  exit 1
}

run_remote_update_command() {
  local failure_message="$1"
  shift
  local output
  set +e
  output="$("$@" 2>&1)"
  local exit_code=$?
  set -e
  write_command_output_log "${output}"
  if [[ ${exit_code} -ne 0 ]]; then
    local summary
    summary="$(format_command_output_summary "${output}")"
    if [[ -n "${summary}" ]]; then
      LAST_REMOTE_UPDATE_ERROR="${failure_message}. Output: ${summary}"
    else
      LAST_REMOTE_UPDATE_ERROR="${failure_message}"
    fi
    fail_remote_update "${LAST_REMOTE_UPDATE_ERROR}" "failed" "${CURRENT_STEP:-Preparing worker} failed"
  fi
}

sleep 1

STARTED_AT="$(python - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
CURRENT_STEP="Preparing worker"
write_remote_update_log "Starting remote self-update for target ref ${TARGET_REF}"
write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "Starting remote self-update worker.")" "worker_started" "Worker started" "worker" "${STARTED_AT}" "null"

trap 'fail_remote_update "${LAST_REMOTE_UPDATE_ERROR:-Remote self-update failed.}" "failed" "${CURRENT_STEP:-Preparing worker} failed"' ERR

CURRENT_STEP="Checking git worktree"
write_remote_update_log "${CURRENT_STEP}"
write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}")" "git_status" "Checking git worktree" "worker" "${STARTED_AT}" "null"
set +e
GIT_STATUS_OUTPUT="$(git status --porcelain=v1 2>&1)"
GIT_STATUS_EXIT=$?
set -e
write_command_output_log "${GIT_STATUS_OUTPUT}"
if [[ ${GIT_STATUS_EXIT} -ne 0 ]]; then
  LAST_REMOTE_UPDATE_ERROR="git status failed"
  GIT_STATUS_SUMMARY="$(format_command_output_summary "${GIT_STATUS_OUTPUT}")"
  if [[ -n "${GIT_STATUS_SUMMARY}" ]]; then
    LAST_REMOTE_UPDATE_ERROR="${LAST_REMOTE_UPDATE_ERROR}. Output: ${GIT_STATUS_SUMMARY}"
  fi
  fail_remote_update "${LAST_REMOTE_UPDATE_ERROR}" "git_status" "Checking git worktree failed"
fi
if [[ -n "${GIT_STATUS_OUTPUT}" ]]; then
  GIT_STATUS_SUMMARY="$(format_command_output_summary "${GIT_STATUS_OUTPUT}")"
  LAST_REMOTE_UPDATE_ERROR="worktree is dirty; refusing remote self-update"
  if [[ -n "${GIT_STATUS_SUMMARY}" ]]; then
    LAST_REMOTE_UPDATE_ERROR="${LAST_REMOTE_UPDATE_ERROR}. Pending changes: ${GIT_STATUS_SUMMARY}"
  fi
  echo "${LAST_REMOTE_UPDATE_ERROR}" >&2
  fail_remote_update "${LAST_REMOTE_UPDATE_ERROR}" "git_status" "Checking git worktree failed"
fi

CURRENT_STEP="Fetching from origin"
write_remote_update_log "${CURRENT_STEP}"
write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}")" "git_fetch" "Fetching from origin" "worker" "${STARTED_AT}" "null"
run_remote_update_command "git fetch failed" git fetch origin --prune --tags

CURRENT_STEP="Resolving target ref"
write_remote_update_log "${CURRENT_STEP}: ${TARGET_REF}"
write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "Target ${TARGET_REF}")" "resolve_target" "Resolving target ref" "worker" "${STARTED_AT}" "null"
if git rev-parse --verify "refs/heads/${TARGET_REF}" >/dev/null 2>&1; then
  CURRENT_STEP="Checking out local branch"
  write_remote_update_log "${CURRENT_STEP}: ${TARGET_REF}"
  write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "${TARGET_REF}")" "checkout_local_branch" "Checking out local branch" "worker" "${STARTED_AT}" "null"
  run_remote_update_command "git checkout failed: ${TARGET_REF}" git checkout "${TARGET_REF}"
  CURRENT_STEP="Pulling latest branch"
  write_remote_update_log "${CURRENT_STEP}: ${TARGET_REF}"
  write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "${TARGET_REF}")" "pull_branch" "Pulling latest branch" "worker" "${STARTED_AT}" "null"
  run_remote_update_command "git pull failed: ${TARGET_REF}" git pull --ff-only origin "${TARGET_REF}"
elif git rev-parse --verify "refs/remotes/origin/${TARGET_REF}" >/dev/null 2>&1; then
  CURRENT_STEP="Checking out remote branch"
  write_remote_update_log "${CURRENT_STEP}: ${TARGET_REF}"
  write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "${TARGET_REF}")" "checkout_remote_branch" "Checking out remote branch" "worker" "${STARTED_AT}" "null"
  run_remote_update_command "git checkout -B failed: ${TARGET_REF}" git checkout -B "${TARGET_REF}" "refs/remotes/origin/${TARGET_REF}"
elif git rev-parse --verify "${TARGET_REF}" >/dev/null 2>&1; then
  CURRENT_STEP="Checking out commit"
  write_remote_update_log "${CURRENT_STEP}: ${TARGET_REF}"
  write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "${TARGET_REF}")" "checkout_commit" "Checking out commit" "worker" "${STARTED_AT}" "null"
  run_remote_update_command "git checkout --detach failed: ${TARGET_REF}" git checkout --detach "${TARGET_REF}"
else
  LAST_REMOTE_UPDATE_ERROR="cannot resolve git ref: ${TARGET_REF}"
  echo "${LAST_REMOTE_UPDATE_ERROR}" >&2
  fail_remote_update "${LAST_REMOTE_UPDATE_ERROR}" "resolve_target" "Resolving target ref failed"
fi

CURRENT_STEP="Building checked EXE"
write_remote_update_log "${CURRENT_STEP}: npm run build:root-exe:checked"
write_remote_update_status "running" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "Running npm run build:root-exe:checked")" "build_checked_exe" "Building checked EXE" "worker" "${STARTED_AT}" "null"
run_remote_update_command "npm run build:root-exe:checked failed" npm run build:root-exe:checked
FINISHED_AT="$(python - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
CURRENT_STEP="Completed"
write_remote_update_log "Remote self-update completed successfully."
write_remote_update_status "succeeded" "${TARGET_REF}" "$(step_detail "${CURRENT_STEP}" "Remote self-update completed successfully.")" "completed" "Remote update completed" "worker" "${STARTED_AT}" "${FINISHED_AT}"
