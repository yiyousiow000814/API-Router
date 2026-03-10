import { describe, expect, it } from "vitest";

import {
  normalizeModelOption,
  resolveSelectedModelId,
  resolveSelectedReasoningEffort,
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
});
