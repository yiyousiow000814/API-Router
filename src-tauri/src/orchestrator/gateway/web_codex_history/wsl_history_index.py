import hashlib
import json
import os
import shutil
import sys
import tempfile
import time

INDEX_VERSION = 5
CHUNK_SIZE = 60
FAST_TAIL_CHUNK_BYTES = 2 * 1024 * 1024

TURN_STARTED_BYTES = b'"payload":{"type":"turn_started"'
TURN_COMPLETE_BYTES = b'"payload":{"type":"turn_complete"'
TURN_ABORTED_BYTES = b'"payload":{"type":"turn_aborted"'
TASK_STARTED_BYTES = b'"payload":{"type":"task_started"'
TASK_COMPLETE_BYTES = b'"payload":{"type":"task_complete"'
TASK_ABORTED_BYTES = b'"payload":{"type":"task_aborted"'
USER_MESSAGE_BYTES = b'"payload":{"type":"user_message"'
AGENT_MESSAGE_BYTES = b'"payload":{"type":"agent_message"'
TOKEN_COUNT_BYTES = b'"payload":{"type":"token_count"'
CONTEXT_COMPACTED_BYTES = b'"payload":{"type":"context_compacted"'
THREAD_ROLLED_BACK_BYTES = b'"payload":{"type":"thread_rolled_back"'
ITEM_COMPLETED_BYTES = b'"payload":{"type":"item_completed"'
RESPONSE_ITEM_BYTES = b'"type":"response_item"'
COMPACTED_BYTES = b'"type":"compacted"'

FAST_TAIL_RELEVANT_MARKERS = (
    TURN_STARTED_BYTES,
    TURN_COMPLETE_BYTES,
    TURN_ABORTED_BYTES,
    TASK_STARTED_BYTES,
    TASK_COMPLETE_BYTES,
    TASK_ABORTED_BYTES,
    USER_MESSAGE_BYTES,
    AGENT_MESSAGE_BYTES,
    TOKEN_COUNT_BYTES,
    CONTEXT_COMPACTED_BYTES,
    THREAD_ROLLED_BACK_BYTES,
    ITEM_COMPLETED_BYTES,
    RESPONSE_ITEM_BYTES,
    COMPACTED_BYTES,
)

FAST_TAIL_BOUNDARY_MARKERS = (
    TURN_STARTED_BYTES,
    TASK_STARTED_BYTES,
    USER_MESSAGE_BYTES,
)


def normalize_token_usage_stats(value):
    if not isinstance(value, dict):
        return None
    total_tokens = value.get("total_tokens")
    input_tokens = value.get("input_tokens")
    cached_input_tokens = value.get("cached_input_tokens")
    output_tokens = value.get("output_tokens")
    reasoning_output_tokens = value.get("reasoning_output_tokens")
    if (
        total_tokens is None
        and input_tokens is None
        and cached_input_tokens is None
        and output_tokens is None
        and reasoning_output_tokens is None
    ):
        return None
    return {
        "totalTokens": total_tokens,
        "inputTokens": input_tokens,
        "cachedInputTokens": cached_input_tokens,
        "outputTokens": output_tokens,
        "reasoningOutputTokens": reasoning_output_tokens,
    }


def normalize_token_usage_info(info):
    if not isinstance(info, dict):
        return None
    total = normalize_token_usage_stats(info.get("total_token_usage"))
    last = normalize_token_usage_stats(info.get("last_token_usage"))
    model_context_window = info.get("model_context_window")
    if total is None and last is None and model_context_window is None:
        return None
    return {
        "total": total,
        "last": last,
        "modelContextWindow": model_context_window,
    }


def line_contains_any(line, markers):
    return any(marker in line for marker in markers)


def normalize_history_item_type(value):
    return "".join(ch.lower() for ch in str(value or "") if ch.isalnum())


def is_shell_like_tool_name(name):
    normalized = normalize_history_item_type(name)
    return (
        normalized == "shell"
        or normalized == "execcommand"
        or normalized.endswith("shellcommand")
        or normalized.endswith("localshell")
        or normalized.endswith("containerexec")
        or normalized.endswith("unifiedexec")
    )


def assistant_phase(payload):
    if not isinstance(payload, dict):
        return None
    phase = str(payload.get("phase") or "").strip()
    return phase or None


def parse_embedded_json_value(value):
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except Exception:
            return text
    return value


def extract_tool_text(value):
    if isinstance(value, str):
        text = value.strip()
        return text or None
    if isinstance(value, dict):
        for key in ("output", "text"):
            text = extract_tool_text(value.get(key))
            if text:
                return text
        return None
    if isinstance(value, list):
        parts = [part for part in (extract_tool_text(item) for item in value) if part]
        return "\n".join(parts) if parts else None
    return None


def extract_tool_text_value(value):
    text = extract_tool_text(value)
    if text:
        return text
    if value is None:
        return None
    return value


def read_command_from_tool_arguments(arguments):
    parsed = parse_embedded_json_value(arguments)
    if not isinstance(parsed, dict):
        return parsed if isinstance(parsed, str) else None
    command = parsed.get("command")
    if command is None:
        command = parsed.get("cmd")
    if command is None:
        command = parsed.get("args")
    if isinstance(command, str):
        text = command.strip()
        return text or None
    if isinstance(command, list):
        parts = [str(part).strip() for part in command if str(part).strip()]
        return " ".join(parts) if parts else None
    if command is None:
        return None
    try:
        return json.dumps(command, ensure_ascii=False)
    except Exception:
        return str(command)


def extract_response_message_text(content):
    if not isinstance(content, list):
        return None
    lines = []
    for part in content:
        if not isinstance(part, dict):
            continue
        part_type = normalize_history_item_type(part.get("type"))
        if part_type not in ("outputtext", "inputtext", "text"):
            continue
        text = extract_tool_text(part.get("text"))
        if text:
            lines.append(text)
    return "\n".join(lines) if lines else None


def canonicalize_history_tool_item(item):
    if not isinstance(item, dict):
        return None
    item_type = normalize_history_item_type(item.get("type"))
    item_id = item.get("id")
    if item_type == "plan":
        text = str(item.get("text") or "").strip()
        if not text:
            return None
        return {"type": "plan", "id": item_id, "text": text}
    if item_type == "commandexecution":
        return {
            "type": "commandExecution",
            "id": item_id,
            "command": item.get("command"),
            "status": item.get("status"),
            "output": extract_tool_text_value(item.get("output")),
            "exitCode": item.get("exitCode", item.get("exit_code")),
        }
    if item_type in ("mcptoolcall", "toolcall"):
        tool = item.get("tool", item.get("name"))
        if is_shell_like_tool_name(tool):
            command = item.get("command")
            if not isinstance(command, str) or not command.strip():
                command = read_command_from_tool_arguments(item.get("arguments"))
            if not isinstance(command, str) or not command.strip():
                command = read_command_from_tool_arguments(item.get("input"))
            return {
                "type": "commandExecution",
                "id": item_id,
                "command": command,
                "status": item.get("status"),
                "output": item.get("result", extract_tool_text_value(item.get("output"))),
                "exitCode": item.get("exitCode", item.get("exit_code")),
            }
        return {
            "type": "toolCall",
            "id": item_id,
            "tool": tool,
            "server": item.get("server"),
            "arguments": item.get("arguments"),
            "input": item.get("input"),
            "status": item.get("status"),
            "result": item.get("result", extract_tool_text_value(item.get("output"))),
            "error": item.get("error"),
        }
    if item_type == "websearch":
        action = item.get("action") if isinstance(item.get("action"), dict) else {}
        return {
            "type": "webSearch",
            "id": item_id,
            "status": item.get("status"),
            "query": item.get("query", action.get("query")),
            "action": action,
        }
    if item_type == "filechange":
        changes = item.get("changes") if isinstance(item.get("changes"), list) else []
        return {
            "type": "fileChange",
            "id": item_id,
            "status": item.get("status"),
            "changes": changes,
        }
    if item_type == "enteredreviewmode":
        return {"type": "enteredReviewMode", "id": item_id}
    if item_type == "exitedreviewmode":
        return {"type": "exitedReviewMode", "id": item_id}
    if item_type == "contextcompaction":
        return {"type": "contextCompaction", "id": item_id}
    return None


class Builder:
    def __init__(self):
        self.turns = []
        self.current_turn = None
        self.next_turn_index = 0
        self.next_item_index = 0
        self.token_usage = None
        self.pending_tool_calls = {}

    def next_turn_id(self):
        self.next_turn_index += 1
        return f"history-turn-{self.next_turn_index}"

    def next_item_id(self):
        self.next_item_index += 1
        return f"history-item-{self.next_item_index}"

    def new_turn(self, turn_id=None, opened_explicitly=False):
        return {
            "id": (turn_id or "").strip() or self.next_turn_id(),
            "items": [],
            "opened_explicitly": opened_explicitly,
            "saw_compaction": False,
        }

    def ensure_turn(self):
        if self.current_turn is None:
            self.current_turn = self.new_turn()
            self.pending_tool_calls = {}
        return self.current_turn

    def finish_current_turn(self):
        if self.current_turn is None:
            return
        turn = self.current_turn
        self.current_turn = None
        self.pending_tool_calls = {}
        if not turn["items"] and not turn["saw_compaction"]:
            return
        self.turns.append(turn)

    def build_user_content(self, payload):
        out = []
        message = str(payload.get("message") or "").strip()
        if message:
            out.append({"type": "input_text", "text": message})
        for image in payload.get("images") or []:
            url = str(image or "").strip()
            if url:
                out.append({"type": "input_image", "image_url": url})
        for image in payload.get("local_images") or []:
            path = str(image or "").strip()
            if path:
                out.append({"type": "local_image", "path": path})
        return out

    def handle_turn_started(self, payload):
        self.finish_current_turn()
        turn_id = str(payload.get("turn_id") or "").strip() or None
        self.current_turn = self.new_turn(turn_id, True)

    def handle_turn_complete(self, _payload):
        self.finish_current_turn()

    def handle_turn_aborted(self):
        self.finish_current_turn()

    def handle_token_count(self, payload):
        token_usage = normalize_token_usage_info(payload.get("info"))
        if token_usage is not None:
            self.token_usage = token_usage

    def handle_user_message(self, payload):
        should_finish = self.current_turn is not None and not (
            self.current_turn["opened_explicitly"]
            or (self.current_turn["saw_compaction"] and not self.current_turn["items"])
        )
        if should_finish:
            self.finish_current_turn()
        content = self.build_user_content(payload)
        if not content:
            return
        self.ensure_turn()["items"].append(
            {
                "type": "userMessage",
                "id": self.next_item_id(),
                "content": content,
            }
        )

    def handle_agent_message(self, payload):
        message = str(payload.get("message") or "").strip()
        if not message:
            return
        self.push_assistant_text_item("agentMessage", message, assistant_phase(payload))

    def handle_context_compacted(self):
        self.ensure_turn()["items"].append(
            {
                "type": "contextCompaction",
                "id": self.next_item_id(),
            }
        )

    def push_turn_item(self, item):
        turn = self.ensure_turn()
        turn["items"].append(item)
        return len(turn["items"]) - 1

    def turn_item(self, index):
        if self.current_turn is None:
            return None
        items = self.current_turn.get("items") or []
        if index < 0 or index >= len(items):
            return None
        item = items[index]
        return item if isinstance(item, dict) else None

    def handle_item_completed(self, payload):
        item = payload.get("item")
        canonical = canonicalize_history_tool_item(item)
        if canonical is not None:
            self.push_turn_item(canonical)

    def handle_function_call(self, payload):
        name = str(payload.get("name") or "").strip()
        call_id = str(payload.get("call_id") or "").strip()
        item_id = self.next_item_id()
        if is_shell_like_tool_name(name):
            item = {
                "type": "commandExecution",
                "id": item_id,
                "callId": call_id or None,
                "command": read_command_from_tool_arguments(payload.get("arguments")),
                "status": payload.get("status"),
            }
            kind = "commandExecution"
        else:
            item = {
                "type": "toolCall",
                "id": item_id,
                "callId": call_id or None,
                "tool": name or None,
                "arguments": payload.get("arguments"),
                "status": payload.get("status"),
            }
            kind = "toolCall"
        index = self.push_turn_item(item)
        if call_id:
            self.pending_tool_calls[call_id] = {"index": index, "kind": kind}

    def handle_function_call_output(self, payload):
        call_id = str(payload.get("call_id") or "").strip()
        if not call_id:
            return
        pending = self.pending_tool_calls.get(call_id)
        if not isinstance(pending, dict):
            return
        parsed = parse_embedded_json_value(payload.get("output"))
        item = self.turn_item(int(pending.get("index") or -1))
        if not item:
            return
        if pending.get("kind") == "commandExecution":
            output = extract_tool_text(parsed)
            metadata = parsed.get("metadata") if isinstance(parsed, dict) else None
            exit_code = metadata.get("exit_code") if isinstance(metadata, dict) else None
            item["status"] = "completed"
            if output:
                item["output"] = output
            if exit_code is not None:
                item["exitCode"] = exit_code
            return
        item["status"] = "completed"
        result = extract_tool_text_value(parsed)
        if result is not None:
            item["result"] = result

    def handle_custom_tool_call(self, payload):
        call_id = str(payload.get("call_id") or "").strip()
        tool = str(payload.get("name") or "").strip()
        index = self.push_turn_item(
            {
                "type": "toolCall",
                "id": self.next_item_id(),
                "callId": call_id or None,
                "tool": tool or None,
                "status": payload.get("status"),
            }
        )
        if call_id:
            self.pending_tool_calls[call_id] = {"index": index, "kind": "toolCall"}

    def handle_custom_tool_call_output(self, payload):
        self.handle_function_call_output(payload)

    def handle_web_search_call(self, payload):
        action = payload.get("action") if isinstance(payload.get("action"), dict) else {}
        query = str(action.get("query") or "").strip() or None
        self.push_turn_item(
            {
                "type": "webSearch",
                "id": self.next_item_id(),
                "status": payload.get("status"),
                "query": query,
                "action": action,
            }
        )

    def handle_response_message(self, payload):
        role = str(payload.get("role") or "").strip().lower()
        if role != "assistant":
            return
        text = extract_response_message_text(payload.get("content"))
        if not text:
            return
        self.push_assistant_text_item("assistantMessage", text, assistant_phase(payload))

    def push_assistant_text_item(self, item_type, text, phase=None):
        message = str(text or "").strip()
        if not message:
            return
        items = (self.current_turn or {}).get("items") or []
        last = items[-1] if items else None
        if isinstance(last, dict):
            last_type = str(last.get("type") or "").strip()
            last_text = str(last.get("text") or "").strip()
            last_phase = str(last.get("phase") or "").strip() or None
            next_phase = str(phase or "").strip() or None
            if last_type in ("agentMessage", "assistantMessage") and last_text == message and last_phase == next_phase:
                return
        item = {
            "type": item_type,
            "id": self.next_item_id(),
            "text": message,
        }
        if phase:
            item["phase"] = phase
        self.push_turn_item(item)

    def handle_compacted(self):
        self.ensure_turn()["saw_compaction"] = True

    def handle_thread_rollback(self, payload):
        self.finish_current_turn()
        try:
            num_turns = int(payload.get("num_turns") or 0)
        except Exception:
            num_turns = 0
        if num_turns >= len(self.turns):
            self.turns = []
        elif num_turns > 0:
            del self.turns[max(0, len(self.turns) - num_turns) :]

    def handle_record(self, value):
        record_type = str(value.get("type") or "").strip()
        if record_type == "event_msg":
            payload = value.get("payload") or {}
            if not isinstance(payload, dict):
                return
            event_type = str(payload.get("type") or "").strip()
            if event_type == "turn_started":
                self.handle_turn_started(payload)
            elif event_type == "task_started":
                self.handle_turn_started(payload)
            elif event_type == "turn_complete":
                self.handle_turn_complete(payload)
            elif event_type == "task_complete":
                self.handle_turn_complete(payload)
            elif event_type == "turn_aborted":
                self.handle_turn_aborted()
            elif event_type == "task_aborted":
                self.handle_turn_aborted()
            elif event_type == "user_message":
                self.handle_user_message(payload)
            elif event_type == "agent_message":
                self.handle_agent_message(payload)
            elif event_type == "token_count":
                self.handle_token_count(payload)
            elif event_type == "context_compacted":
                self.handle_context_compacted()
            elif event_type == "thread_rolled_back":
                self.handle_thread_rollback(payload)
            elif event_type == "item_completed":
                self.handle_item_completed(payload)
        elif record_type == "response_item":
            payload = value.get("payload") or {}
            if not isinstance(payload, dict):
                return
            event_type = str(payload.get("type") or "").strip()
            if event_type == "function_call":
                self.handle_function_call(payload)
            elif event_type == "function_call_output":
                self.handle_function_call_output(payload)
            elif event_type == "custom_tool_call":
                self.handle_custom_tool_call(payload)
            elif event_type == "custom_tool_call_output":
                self.handle_custom_tool_call_output(payload)
            elif event_type == "web_search_call":
                self.handle_web_search_call(payload)
            elif event_type == "message":
                self.handle_response_message(payload)
        elif record_type == "compacted":
            self.handle_compacted()

    def finish(self):
        incomplete = self.current_turn is not None
        self.finish_current_turn()
        return {"turns": self.turns, "tokenUsage": self.token_usage, "incomplete": incomplete}


def parse_page_args():
    if len(sys.argv) != 9:
        raise SystemExit("invalid page args")
    return {
        "thread_id": sys.argv[2],
        "rollout_path": sys.argv[3],
        "before": sys.argv[4],
        "limit": max(1, min(int(sys.argv[5]), 240)),
        "workspace": sys.argv[6],
        "rollout_path_raw": sys.argv[7],
        "cache_root": sys.argv[8],
    }


def parse_build_args():
    if len(sys.argv) != 4:
        raise SystemExit("invalid build-index args")
    return {
        "rollout_path": sys.argv[2],
        "cache_root": sys.argv[3],
    }


def source_state(path):
    st = os.stat(path)
    return {
        "rolloutPath": os.path.abspath(path),
        "size": int(st.st_size),
        "mtimeNs": int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1_000_000_000))),
    }


def cache_dir_for_rollout(cache_root, rollout_path):
    digest = hashlib.sha1(os.path.abspath(rollout_path).encode("utf-8")).hexdigest()
    return os.path.join(cache_root, digest)


def manifest_path(cache_dir):
    return os.path.join(cache_dir, "manifest.json")


def chunk_path(cache_dir, chunk_index):
    return os.path.join(cache_dir, f"chunk-{chunk_index:06d}.json")


def load_manifest(cache_dir, source):
    try:
        with open(manifest_path(cache_dir), "r", encoding="utf-8") as fh:
            manifest = json.load(fh)
    except Exception:
        return None
    if manifest.get("version") != INDEX_VERSION:
        return None
    if os.path.abspath(str(manifest.get("rolloutPath") or "")) != source["rolloutPath"]:
        return None
    if int(manifest.get("size") or -1) != source["size"]:
        return None
    if int(manifest.get("mtimeNs") or -1) != source["mtimeNs"]:
        return None
    if int(manifest.get("chunkSize") or 0) != CHUNK_SIZE:
        return None
    return manifest


def parse_rollout_turns(rollout_path):
    builder = Builder()
    with open(rollout_path, "r", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except Exception:
                continue
            if isinstance(value, dict):
                builder.handle_record(value)
    return builder.finish()


def write_index(cache_dir, source, parsed):
    os.makedirs(os.path.dirname(cache_dir), exist_ok=True)
    tmp_dir = tempfile.mkdtemp(prefix="history-index-", dir=os.path.dirname(cache_dir))
    try:
        chunk_count = 0
        turns = parsed["turns"]
        for start in range(0, len(turns), CHUNK_SIZE):
            chunk_turns = [
                {"id": turn["id"], "items": turn["items"]}
                for turn in turns[start : start + CHUNK_SIZE]
            ]
            with open(chunk_path(tmp_dir, chunk_count), "w", encoding="utf-8") as fh:
                json.dump(chunk_turns, fh, ensure_ascii=False, separators=(",", ":"))
            chunk_count += 1
        manifest = {
            "version": INDEX_VERSION,
            "rolloutPath": source["rolloutPath"],
            "size": source["size"],
            "mtimeNs": source["mtimeNs"],
            "chunkSize": CHUNK_SIZE,
            "chunkCount": chunk_count,
            "totalTurns": len(turns),
            "turnIds": [str(turn.get("id") or "").strip() for turn in turns],
            "tokenUsage": parsed.get("tokenUsage"),
            "incomplete": bool(parsed.get("incomplete")),
        }
        with open(manifest_path(tmp_dir), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, ensure_ascii=False, separators=(",", ":"))
        if os.path.isdir(cache_dir):
            shutil.rmtree(cache_dir)
        os.replace(tmp_dir, cache_dir)
        tmp_dir = None
        return manifest
    finally:
        if tmp_dir and os.path.isdir(tmp_dir):
            shutil.rmtree(tmp_dir, ignore_errors=True)


def load_turns_from_chunks(cache_dir, start, end):
    if end <= start:
        return []
    out = []
    first_chunk = start // CHUNK_SIZE
    last_chunk = (end - 1) // CHUNK_SIZE
    for chunk_index in range(first_chunk, last_chunk + 1):
        with open(chunk_path(cache_dir, chunk_index), "r", encoding="utf-8") as fh:
            chunk_turns = json.load(fh)
        chunk_start = chunk_index * CHUNK_SIZE
        local_start = max(0, start - chunk_start)
        local_end = min(len(chunk_turns), end - chunk_start)
        out.extend(chunk_turns[local_start:local_end])
    return out


def page_end_for_cursor(turn_ids, before):
    needle = before.strip()
    if not needle:
        return len(turn_ids)
    for idx, turn_id in enumerate(turn_ids):
        turn_text = str(turn_id or "").strip()
        if turn_text == needle or turn_text == f"history-turn-{needle}":
            return idx
    return len(turn_ids)


def build_page_from_turns(turns, start, end):
    page_turns = [{"id": turn["id"], "items": turn["items"]} for turn in turns[start:end]]
    before_cursor = turns[start]["id"] if start > 0 else None
    return page_turns, before_cursor


def build_index(cache_root, rollout_path):
    source = source_state(rollout_path)
    cache_dir = cache_dir_for_rollout(cache_root, rollout_path)
    manifest = load_manifest(cache_dir, source)
    if manifest is not None:
        return manifest, 0, "wsl-index-hit"
    build_started = time.perf_counter()
    parsed = parse_rollout_turns(rollout_path)
    manifest = write_index(cache_dir, source, parsed)
    build_ms = int((time.perf_counter() - build_started) * 1000)
    return manifest, build_ms, "wsl-index-built"


def collect_recent_relevant_lines(rollout_path, target_boundaries):
    collected = []
    has_older = False
    with open(rollout_path, "rb") as fh:
        file_size = os.path.getsize(rollout_path)
        pos = file_size
        carry = b""
        boundary_hits = 0
        while pos > 0 and boundary_hits < target_boundaries:
            step = min(FAST_TAIL_CHUNK_BYTES, pos)
            pos -= step
            fh.seek(pos)
            buf = fh.read(step)
            data = buf + carry
            parts = data.split(b"\n")
            if pos > 0:
                carry = parts[0]
                parts = parts[1:]
            else:
                carry = b""
            for raw_line in reversed(parts):
                line = raw_line.strip()
                if not line:
                    continue
                is_relevant = line_contains_any(line, FAST_TAIL_RELEVANT_MARKERS)
                if not is_relevant:
                    continue
                is_boundary = line_contains_any(line, FAST_TAIL_BOUNDARY_MARKERS)
                collected.append(line)
                if is_boundary:
                    boundary_hits += 1
                    if boundary_hits >= target_boundaries:
                        break
        has_older = pos > 0
    return collected, has_older


def parse_history_from_relevant_lines(lines):
    builder = Builder()
    for raw_line in reversed(lines):
        try:
            value = json.loads(raw_line)
        except Exception:
            continue
        if isinstance(value, dict):
            builder.handle_record(value)
    return builder.finish()


def load_latest_page_fast(rollout_path, limit):
    parsed = {"turns": [], "tokenUsage": None}
    has_older = False
    targets = [max(limit * 2, limit + 16, 1), max(limit * 3, limit + 48, 1)]
    for target in targets:
        relevant_lines, has_older = collect_recent_relevant_lines(rollout_path, target)
        parsed = parse_history_from_relevant_lines(relevant_lines)
        if len(parsed["turns"]) >= limit or not has_older:
            break
    turns = parsed["turns"]
    page_turns = [{"id": turn["id"], "items": turn["items"]} for turn in turns[-limit:]]
    has_more = bool(page_turns) and (has_older or len(turns) > limit)
    approx_total = max(len(turns), len(page_turns) + (limit if has_older else 0))
    before_cursor = page_turns[0]["id"] if has_more and page_turns else None
    return {
        "turns": page_turns,
        "tokenUsage": parsed.get("tokenUsage"),
        "hasMore": has_more,
        "beforeCursor": before_cursor,
        "totalTurns": approx_total,
        "incomplete": bool(parsed.get("incomplete")),
    }


def latest_fast_page_needs_index(fast_page, limit):
    turns = fast_page.get("turns") if isinstance(fast_page, dict) else None
    turn_count = len(turns) if isinstance(turns, list) else 0
    normalized_limit = max(1, int(limit or 0))
    if turn_count >= normalized_limit:
        return False
    total_turns = int(fast_page.get("totalTurns") or turn_count) if isinstance(fast_page, dict) else turn_count
    return total_turns > turn_count


def load_latest_page_with_fallback(cache_root, rollout_path, limit):
    fast_page = load_latest_page_fast(rollout_path, limit)
    if not latest_fast_page_needs_index(fast_page, limit):
        return fast_page, 0, "wsl-tail-fast", 0

    manifest, build_ms, source = build_index(cache_root, rollout_path)
    cache_dir = cache_dir_for_rollout(cache_root, rollout_path)
    turn_ids = manifest.get("turnIds") or []
    page_end = len(turn_ids)
    start = max(0, page_end - limit)
    page_started = time.perf_counter()
    page_turns = load_turns_from_chunks(cache_dir, start, page_end)
    page_ms = int((time.perf_counter() - page_started) * 1000)
    return {
        "turns": page_turns,
        "tokenUsage": manifest.get("tokenUsage"),
        "hasMore": start > 0,
        "beforeCursor": turn_ids[start] if start > 0 else None,
        "totalTurns": int(manifest.get("totalTurns") or len(turn_ids)),
        "incomplete": bool(manifest.get("incomplete")) and page_end == len(turn_ids),
    }, build_ms, source, page_ms


def handle_page_mode():
    args = parse_page_args()
    started = time.perf_counter()
    source = source_state(args["rollout_path"])
    cache_dir = cache_dir_for_rollout(args["cache_root"], args["rollout_path"])
    manifest = load_manifest(cache_dir, source)
    build_ms = 0
    page_ms = 0
    page_source = "wsl-index-hit"

    if manifest is not None:
        turn_ids = manifest.get("turnIds") or []
        page_end = page_end_for_cursor(turn_ids, args["before"])
        start = max(0, page_end - args["limit"])
        page_started = time.perf_counter()
        page_turns = load_turns_from_chunks(cache_dir, start, page_end)
        before_cursor = turn_ids[start] if start > 0 else None
        page_ms = int((time.perf_counter() - page_started) * 1000)
        page = {
            "hasMore": start > 0,
            "beforeCursor": before_cursor,
            "limit": args["limit"],
            "totalTurns": int(manifest.get("totalTurns") or len(turn_ids)),
            "incomplete": bool(manifest.get("incomplete")) and page_end == len(turn_ids),
        }
    elif args["before"].strip():
        manifest, build_ms, page_source = build_index(args["cache_root"], args["rollout_path"])
        turn_ids = manifest.get("turnIds") or []
        page_end = page_end_for_cursor(turn_ids, args["before"])
        start = max(0, page_end - args["limit"])
        page_started = time.perf_counter()
        page_turns = load_turns_from_chunks(cache_dir, start, page_end)
        before_cursor = turn_ids[start] if start > 0 else None
        page_ms = int((time.perf_counter() - page_started) * 1000)
        page = {
            "hasMore": start > 0,
            "beforeCursor": before_cursor,
            "limit": args["limit"],
            "totalTurns": int(manifest.get("totalTurns") or len(turn_ids)),
            "incomplete": bool(manifest.get("incomplete")) and page_end == len(turn_ids),
        }
    else:
        page_started = time.perf_counter()
        fast_page, build_ms, page_source, latest_page_ms = load_latest_page_with_fallback(
            args["cache_root"], args["rollout_path"], args["limit"]
        )
        page_ms = int((time.perf_counter() - page_started) * 1000)
        if page_source == "wsl-tail-fast":
            page_ms = latest_page_ms or page_ms
        page_turns = fast_page["turns"]
        page = {
            "hasMore": fast_page["hasMore"],
            "beforeCursor": fast_page["beforeCursor"],
            "limit": args["limit"],
            "totalTurns": fast_page["totalTurns"],
            "incomplete": fast_page["incomplete"],
        }

    payload = {
        "thread": {
            "id": args["thread_id"],
            "workspace": args["workspace"] or None,
            "rolloutPath": args["rollout_path_raw"],
            "turns": page_turns,
            "tokenUsage": manifest.get("tokenUsage") if manifest else fast_page.get("tokenUsage"),
        },
        "page": page,
        "meta": {
            "source": page_source,
            "buildMs": build_ms,
            "pageMs": page_ms,
            "totalMs": int((time.perf_counter() - started) * 1000),
        },
    }
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def handle_build_index_mode():
    args = parse_build_args()
    started = time.perf_counter()
    _, build_ms, source = build_index(args["cache_root"], args["rollout_path"])
    payload = {
        "meta": {
            "source": source,
            "buildMs": build_ms,
            "totalMs": int((time.perf_counter() - started) * 1000),
        }
    }
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def handle_self_test_mode():
    shell_call = canonicalize_history_tool_item(
        {
            "type": "toolCall",
            "tool": "shell_command",
            "arguments": '{"command":"pwd"}',
            "status": "running",
        }
    )
    if not isinstance(shell_call, dict) or shell_call.get("type") != "commandExecution" or shell_call.get("command") != "pwd":
        raise SystemExit("self-test failed: shell-like toolCall was not canonicalized to commandExecution")

    exec_call = canonicalize_history_tool_item(
        {
            "type": "toolCall",
            "tool": "exec_command",
            "arguments": '{"cmd":"bash -lc \\"ls -la\\""}',
            "status": "completed",
        }
    )
    if not isinstance(exec_call, dict) or exec_call.get("type") != "commandExecution" or exec_call.get("command") != 'bash -lc "ls -la"':
        raise SystemExit("self-test failed: exec_command toolCall was not canonicalized to commandExecution")

    generic_call = canonicalize_history_tool_item(
        {
            "type": "toolCall",
            "tool": "spawn_agent",
            "arguments": {"task": "inspect"},
            "status": "running",
        }
    )
    if not isinstance(generic_call, dict) or generic_call.get("type") != "toolCall" or generic_call.get("arguments") != {"task": "inspect"}:
        raise SystemExit("self-test failed: generic toolCall arguments were not preserved")

    builder = Builder()
    builder.handle_turn_started({"turn_id": "turn-1"})
    builder.handle_function_call(
        {
            "name": "local_shell",
            "call_id": "call-1",
            "arguments": '{"command":"npm test"}',
            "status": "running",
        }
    )
    builder.handle_function_call_output(
        {
            "call_id": "call-1",
            "output": '{"output":"ok","metadata":{"exit_code":0}}',
        }
    )
    parsed = builder.finish()
    turns = parsed.get("turns") if isinstance(parsed, dict) else None
    items = turns[0].get("items") if isinstance(turns, list) and turns else None
    first_item = items[0] if isinstance(items, list) and items else None
    if not isinstance(first_item, dict) or first_item.get("type") != "commandExecution" or first_item.get("command") != "npm test":
        raise SystemExit("self-test failed: Builder.handle_function_call did not emit commandExecution for shell-like tools")
    running = Builder()
    running.handle_turn_started({"turn_id": "turn-running"})
    running.handle_agent_message({"message": "thinking", "phase": "commentary"})
    running_parsed = running.finish()
    if running_parsed.get("incomplete") is not True:
        raise SystemExit("self-test failed: running rollout should remain incomplete before turn_complete")
    alias_builder = Builder()
    alias_builder.handle_record({"type": "event_msg", "payload": {"type": "task_started", "turn_id": "task-1"}})
    alias_builder.handle_record(
        {
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "hello", "images": [], "local_images": []},
        }
    )
    alias_builder.handle_record({"type": "event_msg", "payload": {"type": "task_complete"}})
    alias_parsed = alias_builder.finish()
    alias_turns = alias_parsed.get("turns") if isinstance(alias_parsed, dict) else None
    if not isinstance(alias_turns, list) or not alias_turns or alias_turns[0].get("id") != "task-1":
        raise SystemExit("self-test failed: task_* aliases should map to turn boundaries")
    rollout_lines = [
        {"type": "session_meta", "payload": {"id": "thread-fast-tail"}},
        {"type": "event_msg", "payload": {"type": "turn_started", "turn_id": "turn-1"}},
        {
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "inspect", "images": [], "local_images": [], "text_elements": []},
        },
        {"type": "event_msg", "payload": {"type": "agent_message", "message": "working notes", "phase": "commentary"}},
        {
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "shell_command",
                "arguments": "{\"command\":\"rg hello\"}",
                "call_id": "call-shell-1",
                "status": "running",
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call-shell-1",
                "output": "{\"output\":\"ok\",\"metadata\":{\"exit_code\":0}}",
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "web_search_call",
                "status": "completed",
                "action": {"type": "search", "query": "openai codex wsl tools"},
            },
        },
        {
            "type": "event_msg",
            "payload": {"type": "item_completed", "item": {"type": "Plan", "text": "Step 1\\nStep 2"}},
        },
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "phase": "final_answer",
                "content": [{"type": "output_text", "text": "done"}],
            },
        },
        {"type": "event_msg", "payload": {"type": "turn_complete"}},
    ]
    rollout_path = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as fh:
            rollout_path = fh.name
            for record in rollout_lines:
                fh.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
                fh.write("\n")
        fast_page = load_latest_page_fast(rollout_path, 10)
        fast_turns = fast_page.get("turns") if isinstance(fast_page, dict) else None
        fast_items = fast_turns[0].get("items") if isinstance(fast_turns, list) and fast_turns else None
        fast_types = [item.get("type") for item in fast_items if isinstance(item, dict)] if isinstance(fast_items, list) else []
        expected_types = [
            "userMessage",
            "agentMessage",
            "commandExecution",
            "webSearch",
            "plan",
            "assistantMessage",
        ]
        if fast_types != expected_types:
            raise SystemExit(
                "self-test failed: fast latest-page loader dropped tool history items: "
                + json.dumps(fast_types, ensure_ascii=False)
            )
        dense_rollout_path = None
        try:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as fh:
                dense_rollout_path = fh.name
                fh.write(
                    json.dumps(
                        {"type": "session_meta", "payload": {"id": "thread-fast-dense"}},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                )
                fh.write("\n")
                for index in range(8):
                    fh.write(
                        json.dumps(
                            {
                                "type": "event_msg",
                                "payload": {"type": "turn_started", "turn_id": f"turn-{index + 1}"},
                            },
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                    )
                    fh.write("\n")
                    fh.write(
                        json.dumps(
                            {
                                "type": "event_msg",
                                "payload": {
                                    "type": "user_message",
                                    "message": f"prompt-{index + 1}",
                                    "images": [],
                                    "local_images": [],
                                    "text_elements": [],
                                },
                            },
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                    )
                    fh.write("\n")
                    fh.write(
                        json.dumps(
                            {"type": "event_msg", "payload": {"type": "turn_complete"}},
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                    )
                    fh.write("\n")
            dense_fast_page = load_latest_page_fast(dense_rollout_path, 6)
            dense_turns = dense_fast_page.get("turns") if isinstance(dense_fast_page, dict) else None
            if not isinstance(dense_turns, list) or len(dense_turns) != 6:
                raise SystemExit(
                    "self-test failed: dense fast latest-page loader should fill requested limit: "
                    + json.dumps(len(dense_turns) if isinstance(dense_turns, list) else None, ensure_ascii=False)
                )
            if dense_turns[0].get("id") != "turn-3" or dense_turns[-1].get("id") != "turn-8":
                raise SystemExit(
                    "self-test failed: dense fast latest-page loader returned wrong turn window: "
                    + json.dumps([dense_turns[0].get("id"), dense_turns[-1].get("id")], ensure_ascii=False)
                )
            if dense_fast_page.get("hasMore") is not True or dense_fast_page.get("beforeCursor") != "turn-3":
                raise SystemExit(
                    "self-test failed: dense fast latest-page loader should preserve paging metadata: "
                    + json.dumps(
                        {
                            "hasMore": dense_fast_page.get("hasMore"),
                            "beforeCursor": dense_fast_page.get("beforeCursor"),
                        },
                        ensure_ascii=False,
                    )
                )
        finally:
            if dense_rollout_path and os.path.exists(dense_rollout_path):
                os.unlink(dense_rollout_path)
    finally:
        if rollout_path and os.path.exists(rollout_path):
            os.unlink(rollout_path)
    print(json.dumps({"ok": True, "version": INDEX_VERSION}, ensure_ascii=False, separators=(",", ":")))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "page":
        handle_page_mode()
        return
    if mode == "build-index":
        handle_build_index_mode()
        return
    if mode == "self-test":
        handle_self_test_mode()
        return
    raise SystemExit("unknown mode")


if __name__ == "__main__":
    main()
