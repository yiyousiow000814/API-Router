import { describe, expect, it } from "vitest";

import {
  createModelPickerModule,
  normalizeModelOption,
  resolveSelectedModelId,
  resolveSelectedReasoningEffort,
  sortNormalizedModelOptions,
} from "./modelPicker.js";

describe("modelPicker", () => {
  it("normalizes model payloads and efforts", () => {
    const item = normalizeModelOption(
      {
        model: "gpt-5",
        displayName: "GPT-5",
        recommended: true,
        supportedReasoningEfforts: [
          { effort: "low" },
          { reasoningEffort: "medium", description: "Balanced" },
        ],
      },
      (value) => value
    );
    expect(item).toEqual({
      id: "gpt-5",
      label: "GPT-5",
      isDefault: true,
      supportedReasoningEfforts: [
        { effort: "low", description: "" },
        { effort: "medium", description: "Balanced" },
      ],
      defaultReasoningEffort: "",
    });
  });

  it("prefers an existing selected model and otherwise falls back", () => {
    const options = [
      { id: "gpt-5", isDefault: false },
      { id: "gpt-5.1", isDefault: true },
    ];
    expect(resolveSelectedModelId(options, "gpt-5", () => "")).toBe("gpt-5");
    expect(resolveSelectedModelId(options, "missing", () => "gpt-5.1")).toBe("gpt-5.1");
  });

  it("resolves reasoning effort with persisted and medium fallback", () => {
    const model = {
      supportedReasoningEfforts: [{ effort: "low" }, { effort: "medium" }],
      defaultReasoningEffort: "low",
    };
    expect(resolveSelectedReasoningEffort(model, "low")).toBe("low");
    expect(resolveSelectedReasoningEffort(model, "high")).toBe("medium");
  });

  it("sorts normalized model options by version and codex tier", () => {
    expect(
      sortNormalizedModelOptions([
        { id: "gpt-5.4" },
        { id: "gpt-5.3-codex" },
        { id: "gpt-5.4-codex-mini" },
        { id: "gpt-5.4-codex" },
      ]).map((item) => item.id)
    ).toEqual([
      "gpt-5.4-codex",
      "gpt-5.4-codex-mini",
      "gpt-5.4",
      "gpt-5.3-codex",
    ]);
  });

  it("coalesces concurrent model refreshes into one API request", async () => {
    let resolveModels;
    const response = new Promise((resolve) => {
      resolveModels = resolve;
    });
    const apiCalls = [];
    const state = {
      modelOptions: [],
      modelOptionsLoading: false,
      modelOptionsLoadingSeq: 0,
      modelOptionsLoadingStartedAt: 0,
    };
    const module = createModelPickerModule({
      state,
      byId: () => null,
      api(path) {
        apiCalls.push(path);
        return response;
      },
      waitMs: () => Promise.resolve(),
      ensureArrayItems: (value) =>
        Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : value ? [value] : [],
      escapeHtml: (value) => String(value || ""),
      escapeAttr: (value) => String(value || ""),
      compactModelLabel: (value) => String(value || ""),
      updateHeaderUi: () => {},
      persistModelsCache: () => {},
      pickLatestModelId: () => "",
      SELECTED_MODEL_KEY: "model",
      REASONING_EFFORT_KEY: "effort",
      MODEL_USER_SELECTED_KEY: "model-user",
      EFFORT_USER_SELECTED_KEY: "effort-user",
      MODEL_LOADING_MIN_MS: 0,
      localStorageRef: { getItem() { return ""; }, setItem() {} },
      documentRef: { getElementById() { return null; }, createElement() { return {}; }, body: { appendChild() {} } },
      windowRef: {},
      requestAnimationFrameRef: (callback) => callback(),
      performanceRef: { now: () => 0 },
    });

    const first = module.refreshModels();
    const second = module.refreshModels();
    await Promise.resolve();
    expect(apiCalls).toEqual(["/codex/models"]);

    resolveModels({
      items: [{ id: "gpt-5.4-codex", supportedReasoningEfforts: [{ effort: "medium" }] }],
    });
    await Promise.all([first, second]);
    expect(state.modelOptions.map((item) => item.id)).toEqual(["gpt-5.4-codex"]);
  });
});
