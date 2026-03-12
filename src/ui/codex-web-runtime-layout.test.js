import fs from "node:fs";

import { describe, expect, it } from "vitest";

describe("codex-web runtime layout", () => {
  const source = fs.readFileSync(new URL("../../codex-web.html", import.meta.url), "utf8");

  it("does not pin inline runtime chat panels with sticky positioning", () => {
    const blockMatch = source.match(/\.runtimeChatPanels\s*\{([^}]+)\}/s);
    expect(blockMatch).toBeTruthy();
    const block = blockMatch?.[1] || "";
    expect(block).not.toMatch(/position:\s*sticky/i);
    expect(block).not.toMatch(/bottom:\s*0/i);
  });

  it("keeps the bottom runtime activity bar on the shared blue animated status style", () => {
    expect(source).not.toContain(".runtimeActivity.tone-complete .runtimeActivityLead");
    expect(source).not.toContain(".runtimeActivity.tone-error .runtimeActivityLead");
    expect(source).toContain(".runtimeActivityDots");
  });
});
