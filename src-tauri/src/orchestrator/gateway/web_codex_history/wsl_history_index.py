import hashlib
import json
import os
import shutil
import sys
import tempfile
import time

INDEX_VERSION = 2
CHUNK_SIZE = 60
FAST_TAIL_CHUNK_BYTES = 2 * 1024 * 1024

TURN_STARTED_BYTES = b'"payload":{"type":"turn_started"'
TURN_COMPLETE_BYTES = b'"payload":{"type":"turn_complete"'
TURN_ABORTED_BYTES = b'"payload":{"type":"turn_aborted"'
USER_MESSAGE_BYTES = b'"payload":{"type":"user_message"'
AGENT_MESSAGE_BYTES = b'"payload":{"type":"agent_message"'
TOKEN_COUNT_BYTES = b'"payload":{"type":"token_count"'
CONTEXT_COMPACTED_BYTES = b'"payload":{"type":"context_compacted"'
THREAD_ROLLED_BACK_BYTES = b'"payload":{"type":"thread_rolled_back"'
COMPACTED_BYTES = b'"type":"compacted"'

FAST_TAIL_RELEVANT_MARKERS = (
    TURN_STARTED_BYTES,
    TURN_COMPLETE_BYTES,
    TURN_ABORTED_BYTES,
    USER_MESSAGE_BYTES,
    AGENT_MESSAGE_BYTES,
    TOKEN_COUNT_BYTES,
    CONTEXT_COMPACTED_BYTES,
    THREAD_ROLLED_BACK_BYTES,
    COMPACTED_BYTES,
)

FAST_TAIL_BOUNDARY_MARKERS = (
    TURN_STARTED_BYTES,
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


class Builder:
    def __init__(self):
        self.turns = []
        self.current_turn = None
        self.next_turn_index = 0
        self.next_item_index = 0
        self.token_usage = None

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
        return self.current_turn

    def finish_current_turn(self):
        if self.current_turn is None:
            return
        turn = self.current_turn
        self.current_turn = None
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
        self.ensure_turn()["items"].append(
            {
                "type": "agentMessage",
                "id": self.next_item_id(),
                "text": message,
            }
        )

    def handle_context_compacted(self):
        self.ensure_turn()["items"].append(
            {
                "type": "contextCompaction",
                "id": self.next_item_id(),
            }
        )

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
            elif event_type == "turn_complete":
                self.handle_turn_complete(payload)
            elif event_type == "turn_aborted":
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
        elif record_type == "compacted":
            self.handle_compacted()

    def finish(self):
        self.finish_current_turn()
        return {"turns": self.turns, "tokenUsage": self.token_usage}


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
                is_relevant = False
                is_boundary = False
                if USER_MESSAGE_BYTES in line:
                    is_relevant = True
                    is_boundary = True
                elif TURN_STARTED_BYTES in line:
                    is_relevant = True
                    is_boundary = True
                elif (
                    AGENT_MESSAGE_BYTES in line
                    or TOKEN_COUNT_BYTES in line
                    or TURN_COMPLETE_BYTES in line
                    or TURN_ABORTED_BYTES in line
                    or CONTEXT_COMPACTED_BYTES in line
                    or THREAD_ROLLED_BACK_BYTES in line
                    or COMPACTED_BYTES in line
                ):
                    is_relevant = True
                if not is_relevant:
                    continue
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
    targets = [max(limit, 1), max(limit + 8, int(limit * 1.25))]
    for target in targets:
        relevant_lines, has_older = collect_recent_relevant_lines(rollout_path, target)
        parsed = parse_history_from_relevant_lines(relevant_lines)
        if len(parsed["turns"]) >= limit or not has_older:
            break
    turns = parsed["turns"]
    page_turns = [{"id": turn["id"], "items": turn["items"]} for turn in turns[-limit:]]
    approx_total = len(page_turns) + (limit if has_older else 0)
    return {
        "turns": page_turns,
        "tokenUsage": parsed.get("tokenUsage"),
        "hasMore": False,
        "beforeCursor": None,
        "totalTurns": approx_total,
        "incomplete": has_older,
    }


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
            "incomplete": False,
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
            "incomplete": False,
        }
    else:
        page_started = time.perf_counter()
        fast_page = load_latest_page_fast(args["rollout_path"], args["limit"])
        page_ms = int((time.perf_counter() - page_started) * 1000)
        page_turns = fast_page["turns"]
        page = {
            "hasMore": fast_page["hasMore"],
            "beforeCursor": fast_page["beforeCursor"],
            "limit": args["limit"],
            "totalTurns": fast_page["totalTurns"],
            "incomplete": fast_page["incomplete"],
        }
        page_source = "wsl-tail-fast"

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


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "page":
        handle_page_mode()
        return
    if mode == "build-index":
        handle_build_index_mode()
        return
    raise SystemExit("unknown mode")


if __name__ == "__main__":
    main()
