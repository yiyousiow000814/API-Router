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
    const dockMatch = source.match(/\.runtimeDock\s*\{([^}]+)\}/s);
    expect(dockMatch).toBeTruthy();
    expect(dockMatch?.[1] || "").toMatch(/margin-right:\s*4px/i);
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

  it("keeps message body inline typography on a consistent font size", () => {
    const bodyMatch = source.match(/\.msgBody\s*\{([^}]+)\}/s);
    expect(bodyMatch).toBeTruthy();
    expect(bodyMatch?.[1] || "").toMatch(/font-size:\s*14px/i);
    expect(bodyMatch?.[1] || "").toMatch(/Segoe UI/i);
    const segoeIndex = (bodyMatch?.[1] || "").indexOf('"Segoe UI"');
    const yaheiIndex = (bodyMatch?.[1] || "").indexOf('"Microsoft YaHei UI"');
    expect(segoeIndex).toBeGreaterThanOrEqual(0);
    expect(yaheiIndex).toBeGreaterThan(segoeIndex);
    const inlineCodeMatch = source.match(/^\s*\.msgInlineCode\s*\{([^}]+)\}/ms);
    expect(inlineCodeMatch).toBeTruthy();
    expect(inlineCodeMatch?.[1] || "").toMatch(/font-family:\s*inherit/i);
    expect(inlineCodeMatch?.[1] || "").toMatch(/font-size:\s*inherit/i);
    expect(inlineCodeMatch?.[1] || "").toMatch(/line-height:\s*inherit/i);
  });

  it("keeps path-style text on the same typography as surrounding prose", () => {
    const linkMatch = source.match(/^\s*\.msgLink\s*\{([^}]+)\}/ms);
    expect(linkMatch).toBeTruthy();
    expect(linkMatch?.[1] || "").toMatch(/font-family:\s*inherit/i);
    expect(linkMatch?.[1] || "").toMatch(/font-size:\s*inherit/i);
    expect(linkMatch?.[1] || "").toMatch(/line-height:\s*inherit/i);
    expect(linkMatch?.[1] || "").toMatch(/font-weight:\s*inherit/i);
    const pseudoLinkMatch = source.match(/^\s*\.msgPseudoLink\s*\{([^}]+)\}/ms);
    expect(pseudoLinkMatch).toBeTruthy();
    expect(pseudoLinkMatch?.[1] || "").toMatch(/font-family:\s*inherit/i);
    expect(pseudoLinkMatch?.[1] || "").toMatch(/font-size:\s*inherit/i);
    expect(pseudoLinkMatch?.[1] || "").toMatch(/line-height:\s*inherit/i);
    expect(pseudoLinkMatch?.[1] || "").toMatch(/font-weight:\s*inherit/i);
  });

  it("drives the mobile shell height from synced viewport CSS variables", () => {
    expect(source).toContain("--app-height: 100vh;");
    expect(source).toContain("--visual-viewport-height: 100vh;");
    expect(source).toContain("--keyboard-offset: 0px;");
    const shellMatch = source.match(/\.shell\s*\{([^}]+)\}/s);
    expect(shellMatch).toBeTruthy();
    expect(shellMatch?.[1] || "").toMatch(/height:\s*var\(--app-height,\s*100dvh\)/i);
    expect(shellMatch?.[1] || "").toMatch(/min-height:\s*var\(--app-height,\s*100vh\)/i);
  });

  it("floats the mobile composer above the bottom edge and keyboard offset", () => {
    expect(source).toContain("--composer-float-height: 148px;");
    expect(source).toContain("body.floating-composer-layout .chatPanel");
    expect(source).toContain("body.floating-composer-layout .composer");
    expect(source).toContain("body.floating-composer-layout .messages");
    expect(source).toMatch(/body\.floating-composer-layout \.chatPanel\s*\{[\s\S]*?bottom:\s*8px/);
    expect(source).toMatch(/body\.floating-composer-layout \.chatPanel\s*\{[\s\S]*?height:\s*auto/);
    expect(source).toMatch(/body\.floating-composer-layout \.composer\s*\{[\s\S]*?bottom:\s*calc\(10px \+ env\(safe-area-inset-bottom, 0px\) \+ var\(--keyboard-offset, 0px\)\)/);
    expect(source).toMatch(/body\.floating-composer-layout \.messages\s*\{[\s\S]*?padding-bottom:\s*calc\(var\(--composer-float-height, 148px\) \+ 20px \+ env\(safe-area-inset-bottom, 0px\) \+ var\(--keyboard-offset, 0px\)\)/);
  });

  it("hides the mobile chat scrollbar gutter for a cleaner floating chat surface", () => {
    expect(source).toMatch(/\.messages\s*\{[\s\S]*?scrollbar-gutter:\s*auto/i);
    expect(source).toMatch(/\.messages\s*\{[\s\S]*?scrollbar-width:\s*none/i);
    expect(source).toContain(".messages::-webkit-scrollbar");
  });
});
