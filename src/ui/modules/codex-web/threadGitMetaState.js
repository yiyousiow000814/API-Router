import { normalizeBranchOptions } from "./branchOptions.js";

export function activeComposerWorkspace(state) {
  return String(state?.activeThreadWorkspace || state?.workspaceTarget || "windows").trim().toLowerCase() === "wsl2"
    ? "wsl2"
    : "windows";
}

export function normalizeGitMetaWorkspace(value, fallbackState) {
  const workspace = String(value || activeComposerWorkspace(fallbackState)).trim().toLowerCase();
  return workspace === "wsl2" ? "wsl2" : "windows";
}

export function buildActiveThreadGitMetaKey({ threadId = "", workspace = "", cwd = "" }) {
  const normalizedWorkspace = normalizeGitMetaWorkspace(workspace);
  const normalizedThreadId = String(threadId || "").trim();
  const normalizedCwd = String(cwd || "").trim();
  if (normalizedThreadId) return `thread:${normalizedWorkspace}:${normalizedThreadId}`;
  if (normalizedCwd) return `cwd:${normalizedWorkspace}:${normalizedCwd}`;
  return "";
}

export function applyActiveThreadGitMetaState(state, payload) {
  const threadId = String(payload?.threadId || state?.activeThreadId || "").trim();
  const workspace = normalizeGitMetaWorkspace(payload?.workspace, state);
  const cwd = String(payload?.cwd || "").trim();
  state.activeThreadCurrentBranch = String(payload?.currentBranch || "").trim();
  state.activeThreadBranchOptions = normalizeBranchOptions(payload?.branches);
  if (payload?.isWorktree != null) {
    state.activeThreadIsWorktree = payload.isWorktree === true;
  }
  state.activeThreadGitMetaLoading = false;
  state.activeThreadGitMetaLoaded = true;
  state.activeThreadGitMetaCwd = cwd;
  state.activeThreadGitMetaSource = threadId ? "thread" : "cwd";
  state.activeThreadGitMetaKey = buildActiveThreadGitMetaKey({ threadId, workspace, cwd });
  return payload;
}

