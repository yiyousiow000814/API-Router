import { describe, expect, it } from "vitest";

import { createComposerUiModule } from "./composerUi.js";

describe("composerUi", () => {
  it("reads prompt value through dependency", () => {
    const deps = {
      state: { activeThreadTokenUsage: null, activeMainTab: "chat" },
      byId(id) {
        return id === "mobilePromptInput" ? { value: "hello" } : null;
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    };
    const { getPromptValue } = createComposerUiModule(deps);
    expect(getPromptValue()).toBe("hello");
  });
});
