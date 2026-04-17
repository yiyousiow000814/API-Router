import {
  normalizeBranchOption,
  normalizeBranchOptions,
  readBranchOptionName,
  readBranchOptionPrNumber,
} from "./branchOptions.js";

function normalizeUncommittedFileCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

export function buildBranchPickerState(state) {
  const branchOptions = normalizeBranchOptions(state?.activeThreadBranchOptions);
  const currentBranch = String(state?.activeThreadCurrentBranch || "").trim();
  const uncommittedFileCount = normalizeUncommittedFileCount(
    state?.activeThreadUncommittedFileCount
  );
  const gitMetaLoading = state?.activeThreadGitMetaLoading === true;
  const gitMetaLoaded = state?.activeThreadGitMetaLoaded === true;
  const metaReady = !gitMetaLoading && gitMetaLoaded;
  const visibleBranches = branchOptions.length
    ? branchOptions
    : currentBranch
      ? [normalizeBranchOption({ name: currentBranch })]
      : [];
  const canPickBranch = metaReady && visibleBranches.length > 0;
  return {
    branchOptions,
    currentBranch,
    uncommittedFileCount,
    gitMetaLoading,
    gitMetaLoaded,
    metaReady,
    branchSwitchLocked: uncommittedFileCount > 0,
    canPickBranch,
    branchLabel: gitMetaLoading ? "Loading..." : currentBranch || "Branch",
    visibleBranches,
  };
}

export function buildBranchPickerItemState(pickerState, branchOption) {
  const branchName = readBranchOptionName(branchOption);
  const active = branchName === pickerState.currentBranch;
  const disabled =
    !pickerState.canPickBranch ||
    pickerState.gitMetaLoading ||
    (pickerState.branchSwitchLocked && !active);
  return {
    branchName,
    prNumber: readBranchOptionPrNumber(branchOption),
    active,
    disabled,
  };
}

export function resolveBranchPickerSelection(state, branch) {
  const pickerState = buildBranchPickerState(state);
  const branchName = String(branch || "").trim();
  if (!branchName) return { action: "ignore" };
  if (!pickerState.canPickBranch) return { action: "close" };
  const item = pickerState.visibleBranches
    .map((branchOption) => buildBranchPickerItemState(pickerState, branchOption))
    .find((branchOption) => branchOption.branchName === branchName);
  if (!item) return { action: "close" };
  if (item.active) return { action: "close" };
  if (item.disabled) {
    return {
      action: "blocked",
      reason: "uncommitted",
      uncommittedFileCount: pickerState.uncommittedFileCount,
    };
  }
  return { action: "switch", branch: branchName };
}
