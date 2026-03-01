import { performance } from "node:perf_hooks";

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.API_ROUTER_BENCH_BASE_URL || "http://127.0.0.1:4000",
    token: process.env.API_ROUTER_GATEWAY_TOKEN || "",
    workspaces: ["windows", "wsl2"],
    threadLimit: 3,
    samples: 3,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--base-url" && next) {
      out.baseUrl = next.trim().replace(/\/+$/, "");
      i += 1;
      continue;
    }
    if (arg === "--token" && next) {
      out.token = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--workspace" && next) {
      const v = next.trim().toLowerCase();
      if (v === "windows" || v === "wsl2") out.workspaces = [v];
      i += 1;
      continue;
    }
    if (arg === "--threads" && next) {
      const v = Number.parseInt(next, 10);
      if (Number.isFinite(v) && v > 0) out.threadLimit = v;
      i += 1;
      continue;
    }
    if (arg === "--samples" && next) {
      const v = Number.parseInt(next, 10);
      if (Number.isFinite(v) && v > 0) out.samples = v;
      i += 1;
    }
  }
  return out;
}

function toArrayItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(values) {
  if (!values.length) return { count: 0, avg: 0, p95: 0, max: 0 };
  const sum = values.reduce((acc, n) => acc + n, 0);
  return {
    count: values.length,
    avg: Math.round(sum / values.length),
    p95: Math.round(percentile(values, 95)),
    max: Math.round(Math.max(...values)),
  };
}

function makeHeaders(auth, hasBody = false) {
  const headers = {};
  if (hasBody) headers["Content-Type"] = "application/json";
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (!auth.token && auth.cookie) headers.Cookie = auth.cookie;
  return headers;
}

async function requestJson(baseUrl, auth, path, options = {}) {
  const hasBody = options.body !== undefined;
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: makeHeaders(auth, hasBody),
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = payload?.error?.detail || payload?.error?.message || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return payload;
}

function parseGatewayCookie(setCookieValue) {
  const text = String(setCookieValue || "");
  if (!text) return "";
  const first = text.split(",").find((part) => part.includes("api_router_gateway_token=")) || "";
  const match = first.match(/api_router_gateway_token=([^;]+)/);
  if (!match) return "";
  return `api_router_gateway_token=${match[1]}`;
}

async function resolveAuth(baseUrl, token) {
  if (token) return { token, cookie: "" };
  const res = await fetch(`${baseUrl}/codex-web`, { method: "GET" });
  const cookie = parseGatewayCookie(res.headers.get("set-cookie"));
  return { token: "", cookie };
}

function buildResumePath(thread, workspace) {
  const id = encodeURIComponent(String(thread.id || thread.threadId || "").trim());
  const query = [`workspace=${encodeURIComponent(workspace)}`];
  if (workspace === "wsl2") {
    const rolloutPath = String(thread.path || "").trim();
    if (rolloutPath) query.push(`rolloutPath=${encodeURIComponent(rolloutPath)}`);
  }
  return `/codex/threads/${id}/resume?${query.join("&")}`;
}

function buildHistoryPath(thread, workspace) {
  const id = encodeURIComponent(String(thread.id || thread.threadId || "").trim());
  const query = [`workspace=${encodeURIComponent(workspace)}`];
  if (workspace === "wsl2") {
    const rolloutPath = String(thread.path || "").trim();
    if (rolloutPath) query.push(`rolloutPath=${encodeURIComponent(rolloutPath)}`);
  }
  return `/codex/threads/${id}/history?${query.join("&")}`;
}

async function measureThreadOpen(baseUrl, auth, workspace, thread) {
  let historyMs = 0;
  let historyOk = false;
  if (workspace !== "wsl2") {
    const historyPath = buildHistoryPath(thread, workspace);
    const historyStart = performance.now();
    try {
      const historyPayload = await requestJson(baseUrl, auth, historyPath);
      const historyThread = historyPayload?.thread || historyPayload?.result?.thread || null;
      historyOk = Array.isArray(historyThread?.turns);
    } catch (_) {
      historyOk = false;
    } finally {
      historyMs = performance.now() - historyStart;
    }
  }

  const resumePath = buildResumePath(thread, workspace);
  const resumeStart = performance.now();
  const resumePayload = await requestJson(baseUrl, auth, resumePath, { method: "POST", body: {} });
  const resumeMs = performance.now() - resumeStart;
  const resumeThread = resumePayload?.thread || resumePayload?.result?.thread || null;
  const hasTurnsOnResume = Array.isArray(resumeThread?.turns);
  if (hasTurnsOnResume) {
    return {
      resumeMs,
      readMs: 0,
      totalMs: resumeMs,
      visibleMs: historyOk ? historyMs : resumeMs,
      historyMs,
      historyOk,
      usedReadFallback: false,
    };
  }

  const threadId = String(thread.id || thread.threadId || "").trim();
  const readStart = performance.now();
  await requestJson(baseUrl, auth, "/codex/rpc", {
    method: "POST",
    body: {
      method: "thread/read",
      params: { threadId, includeTurns: true },
    },
  });
  const readMs = performance.now() - readStart;
  return {
    resumeMs,
    readMs,
    totalMs: resumeMs + readMs,
    visibleMs: historyOk ? historyMs : resumeMs + readMs,
    historyMs,
    historyOk,
    usedReadFallback: true,
  };
}

async function runWorkspaceBenchmark(config, auth, workspace) {
  const threadPayload = await requestJson(
    config.baseUrl,
    auth,
    `/codex/threads?workspace=${encodeURIComponent(workspace)}`
  );
  const threads = toArrayItems(threadPayload?.items).filter((item) => {
    const id = String(item?.id || item?.threadId || "").trim();
    return !!id;
  });
  const selected = threads.slice(0, config.threadLimit);
  if (!selected.length) {
    return {
      workspace,
      total: summarize([]),
      resume: summarize([]),
      read: summarize([]),
      failures: 0,
      samples: 0,
    };
  }

  const total = [];
  const visible = [];
  const history = [];
  const resume = [];
  const read = [];
  let historyHitCount = 0;
  let readFallbackCount = 0;
  let failures = 0;
  for (const thread of selected) {
    for (let i = 0; i < config.samples; i += 1) {
      try {
        const timing = await measureThreadOpen(config.baseUrl, auth, workspace, thread);
        total.push(timing.totalMs);
        visible.push(timing.visibleMs);
        history.push(timing.historyMs);
        resume.push(timing.resumeMs);
        read.push(timing.readMs);
        if (timing.historyOk) historyHitCount += 1;
        if (timing.usedReadFallback) readFallbackCount += 1;
      } catch (error) {
        failures += 1;
        const id = String(thread.id || thread.threadId || "").trim();
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[${workspace}] sample failed (${id}): ${msg}`);
      }
    }
  }

  return {
    workspace,
    total: summarize(total),
    visible: summarize(visible),
    history: summarize(history),
    resume: summarize(resume),
    read: summarize(read),
    historyHitCount,
    readFallbackCount,
    failures,
    samples: selected.length * config.samples,
  };
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const auth = await resolveAuth(config.baseUrl, config.token);
  console.log(
    `Benchmark start: base=${config.baseUrl} workspaces=${config.workspaces.join(",")} threads=${config.threadLimit} samples=${config.samples}`
  );
  const results = [];
  for (const workspace of config.workspaces) {
    results.push(await runWorkspaceBenchmark(config, auth, workspace));
  }

  console.log("");
  for (const result of results) {
    const name = result.workspace.toUpperCase();
    console.log(`${name}:`);
    console.log(
      `  visible avg=${result.visible.avg}ms p95=${result.visible.p95}ms max=${result.visible.max}ms`
    );
    console.log(
      `  history avg=${result.history.avg}ms p95=${result.history.p95}ms max=${result.history.max}ms`
    );
    console.log(
      `  total  avg=${result.total.avg}ms p95=${result.total.p95}ms max=${result.total.max}ms count=${result.total.count}/${result.samples}`
    );
    console.log(
      `  resume avg=${result.resume.avg}ms p95=${result.resume.p95}ms max=${result.resume.max}ms`
    );
    console.log(
      `  read   avg=${result.read.avg}ms p95=${result.read.p95}ms max=${result.read.max}ms`
    );
    console.log(`  history-hit=${result.historyHitCount}/${result.total.count}`);
    console.log(`  read-fallback-used=${result.readFallbackCount}/${result.total.count}`);
    if (result.failures > 0) {
      console.log(`  failures=${result.failures}`);
    }
    console.log("");
  }
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`Benchmark failed: ${msg}`);
  process.exitCode = 1;
});
