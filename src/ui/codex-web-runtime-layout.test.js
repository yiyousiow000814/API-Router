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

  it("places the runtime activity inside the composer meta row as a compact inline hint", () => {
    expect(source).toContain('<div class="mobileComposerMetaRow">');
    expect(source).toContain('<div id="runtimeDock" class="runtimeDock" style="display:none;">');
    expect(source).toContain(".runtimeActivityDots");
  });

  it("renders thinking cards at full chat width instead of a narrow bubble width", () => {
    const blockMatch = source.match(/\.msg\.system\.kind-thinking\s*\{([^}]+)\}/s);
    expect(blockMatch).toBeTruthy();
    const block = blockMatch?.[1] || "";
    expect(block).toMatch(/width:\s*100%/i);
    expect(block).toMatch(/max-width:\s*100%/i);
  });

  it("uses a lighter transient thinking style for live commentary", () => {
    expect(source).toContain('.msg.system.kind-thinking[data-msg-transient="1"]');
    expect(source).toContain("box-shadow: none;");
    expect(source).toContain(".runtimeThinkingCard");
  });

  it("animates runtime stack section visibility instead of hard hiding sections", () => {
    expect(source).toContain(".runtimeStackSection");
    expect(source).toContain(".runtimeStackSection.is-hidden");
    const sectionMatch = source.match(/\.runtimeStackSection\s*\{([^}]+)\}/s);
    expect(sectionMatch).toBeTruthy();
    expect(sectionMatch?.[1] || "").toMatch(/transition:/i);
  });

  it("gives commentary archives extra top spacing and animated expand collapse", () => {
    const mountMatch = source.match(/\.commentaryArchiveMount\s*\{([^}]+)\}/s);
    expect(mountMatch).toBeTruthy();
    expect(mountMatch?.[1] || "").toMatch(/margin:\s*16px 0 8px/i);
    const bodyMatch = source.match(/\.commentaryArchiveBody\s*\{([^}]+)\}/s);
    expect(bodyMatch).toBeTruthy();
    expect(bodyMatch?.[1] || "").toMatch(/transition:/i);
    const collapsedMatch = source.match(/\.commentaryArchiveBody\.collapsed\s*\{([^}]+)\}/s);
    expect(collapsedMatch).toBeTruthy();
    expect(collapsedMatch?.[1] || "").not.toMatch(/display:\s*none/i);
  });

  it("keeps the runtime activity bar text on a single clipped row", () => {
    const textMatch = source.match(/\.runtimeActivityText\s*\{([^}]+)\}/s);
    expect(textMatch).toBeTruthy();
    expect(textMatch?.[1] || "").toMatch(/white-space:\s*nowrap/i);
    expect(textMatch?.[1] || "").toMatch(/text-overflow:\s*ellipsis/i);
    expect(source).toContain(".runtimeActivityText > *");
  });
});
