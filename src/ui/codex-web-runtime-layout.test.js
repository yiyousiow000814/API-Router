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

  it("adds a separate picker bar below the composer meta row", () => {
    const metaIndex = source.indexOf('<div class="mobileComposerMetaRow">');
    const surfaceIndex = source.indexOf('<div class="composerInputSurface">');
    const pickerIndex = source.indexOf('<div id="composerPickerBar" class="composerPickerBar">');
    expect(surfaceIndex).toBeGreaterThanOrEqual(0);
    expect(metaIndex).toBeGreaterThanOrEqual(0);
    expect(pickerIndex).toBeGreaterThan(metaIndex);
    expect(pickerIndex).toBeGreaterThan(surfaceIndex);
    expect(source).toContain('id="composerBranchPickerBtn"');
    expect(source).toContain('id="composerPermissionPickerBtn"');
    expect(source).toContain('id="composerPickerBar" class="composerPickerBar"');
    expect(source).toContain(".composerInputSurface");
    expect(source).toContain(".composerPickerBar");
    expect(source).toContain(".composerPickerMenu");
  });

  it("uses the same frosted composer surface chrome on desktop as on mobile", () => {
    const surfaceMatch = source.match(/\.composerInputSurface\s*\{([^}]+)\}/s);
    expect(surfaceMatch).toBeTruthy();
    expect(surfaceMatch?.[1] || "").toMatch(/background:\s*rgba\(248,\s*250,\s*255,\s*0\.96\)/i);
    expect(surfaceMatch?.[1] || "").toMatch(/box-shadow:\s*0 14px 40px rgba\(13,\s*18,\s*32,\s*0\.12\)/i);
  });

  it("keeps the desktop composer inset from the bottom edge instead of pinning it flush to the panel", () => {
    const composerMatch = source.match(/\.composer\s*\{([^}]+)\}/s);
    expect(composerMatch).toBeTruthy();
    expect(composerMatch?.[1] || "").toMatch(/gap:\s*8px/i);
    expect(composerMatch?.[1] || "").toMatch(/padding:\s*0 10px 10px/i);
  });

  it("renders the picker bar shell immediately instead of waiting for JS to unhide it", () => {
    expect(source).not.toContain('id="composerPickerBar" class="composerPickerBar" style="display:none;"');
    expect(source).toContain('<span class="composerPickerBtnLabel">Branch</span>');
    expect(source).toContain('<span class="composerPickerBtnLabel">Full access</span>');
  });

  it("keeps queued turn chrome hidden on first paint until a queued turn actually exists", () => {
    expect(source).toContain('id="queuedTurnCard" class="queuedTurnCard" style="display:none;"');
    expect(source).toContain('id="queuedTurnToggleBtn" class="queuedTurnCardBtn queuedTurnCardToggleBtn" type="button" aria-label="Collapse queued messages" title="Collapse queued messages" aria-expanded="true" style="display:none;"');
  });

  it("keeps the picker bar above the send action rail on desktop layouts", () => {
    const pickerBarMatch = source.match(/\.composerPickerBar\s*\{([^}]+)\}/s);
    const actionRailMatch = source.match(/\.composerActionRail\s*\{([^}]+)\}/s);
    expect(pickerBarMatch).toBeTruthy();
    expect(actionRailMatch).toBeTruthy();
    expect(pickerBarMatch?.[1] || "").toMatch(/position:\s*relative/i);
    expect(pickerBarMatch?.[1] || "").toMatch(/z-index:\s*var\(--z-composer-picker\)/i);
    expect(actionRailMatch?.[1] || "").toMatch(/z-index:\s*var\(--z-composer-overlay\)/i);
    expect(source).toContain("--z-composer-picker: 12;");
  });

  it("drops the composer picker bar behind the drawer while a sidebar is open", () => {
    expect(source).toMatch(/body\.drawer-left-open \.composerPickerBar,/);
    expect(source).toMatch(/body\.drawer-right-open \.composerPickerBar,/);
    expect(source).toMatch(/body\.drawer-left-open \.composerPickerBar,[\s\S]*?z-index:\s*0 !important/i);
  });

  it("opens picker menus upward from the bottom picker bar", () => {
    const menuMatch = source.match(/\.composerPickerMenu\s*\{([^}]+)\}/s);
    const scrollMatch = source.match(/\.composerPickerMenuScroll\s*\{([^}]+)\}/s);
    expect(menuMatch).toBeTruthy();
    expect(scrollMatch).toBeTruthy();
    const block = menuMatch?.[1] || "";
    const scrollBlock = scrollMatch?.[1] || "";
    expect(block).toMatch(/bottom:\s*calc\(100% \+ 8px\)/i);
    expect(block).not.toMatch(/top:\s*calc\(100% \+ 8px\)/i);
    expect(block).toMatch(/max-height:\s*min\(52vh,\s*360px\)/i);
    expect(block).toMatch(/overflow:\s*hidden/i);
    expect(scrollBlock).toMatch(/overflow-y:\s*auto/i);
    expect(source).toContain(".composerPickerMenuScroll");
  });

  it("animates picker menu open and option entry", () => {
    const menuMatch = source.match(/\.composerPickerMenu\s*\{([^}]+)\}/s);
    const openMatch = source.match(/\.composerPickerMenu\.open\s*\{([^}]+)\}/s);
    expect(menuMatch).toBeTruthy();
    expect(openMatch).toBeTruthy();
    expect(menuMatch?.[1] || "").toMatch(/transition:/i);
    expect(menuMatch?.[1] || "").toMatch(/transform:\s*translate3d\(0,\s*8px,\s*0\)\s*scale\(0\.96\)/i);
    expect(openMatch?.[1] || "").toMatch(/transform:\s*translate3d\(0,\s*0,\s*0\)\s*scale\(1\)/i);
    expect(source).toContain("@keyframes composer-picker-item-in");
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

  it("keeps reconnecting and error system cards on the light neutral palette", () => {
    const systemMatch = source.match(/\.msg\.system\s*\{([^}]+)\}/s);
    const pendingMatch = source.match(/\.msg\.system\.kind-pending\s*\{([^}]+)\}/s);
    const errorMatch = source.match(/\.msg\.system\.kind-error\s*\{([^}]+)\}/s);
    const errorHeadMatch = source.match(/\.msg\.system\.kind-error\s*\.msgHead\s*\{([^}]+)\}/s);

    expect(systemMatch).toBeTruthy();
    expect(pendingMatch).toBeTruthy();
    expect(errorMatch).toBeTruthy();
    expect(errorHeadMatch).toBeTruthy();
    expect(source).toContain("--system-surface: rgba(248, 250, 253, 0.98);");
    expect(source).toContain("--system-error-surface: rgba(255, 247, 248, 0.98);");
    expect(systemMatch?.[1] || "").toMatch(/background:\s*linear-gradient\(180deg,\s*var\(--system-surface\),\s*var\(--system-surface-2\)\)/i);
    expect(systemMatch?.[1] || "").toMatch(/color:\s*var\(--system-text\)/i);
    expect(pendingMatch?.[1] || "").toMatch(/border-color:\s*var\(--system-border\)/i);
    expect(pendingMatch?.[1] || "").toMatch(/background:\s*linear-gradient\(180deg,\s*var\(--system-surface\),\s*var\(--system-surface-2\)\)/i);
    expect(errorMatch?.[1] || "").toMatch(/background:\s*linear-gradient\(180deg,\s*var\(--system-error-surface\),\s*var\(--system-error-surface-2\)\)/i);
    expect(errorMatch?.[1] || "").toMatch(/color:\s*var\(--system-error-text\)/i);
    expect(errorHeadMatch?.[1] || "").toMatch(/color:\s*var\(--system-error-head\)/i);
  });

  it("animates the replay error demo trigger while it is running", () => {
    const buttonMatch = source.match(/#testErrorBtn\.is-replaying\s*\{([^}]+)\}/s);
    expect(buttonMatch).toBeTruthy();
    expect(buttonMatch?.[1] || "").toMatch(/animation:\s*error-demo-pulse/i);
    expect(source).toContain("@keyframes error-demo-pulse");
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
    expect(source).toContain("applyInitialMobileComposerLayout");
    expect(source).toContain('body.classList.add("floating-composer-layout")');
    expect(source).toContain("viewportWidth <= 1080");
    const shellMatch = source.match(/\.shell\s*\{([^}]+)\}/s);
    expect(shellMatch).toBeTruthy();
    expect(shellMatch?.[1] || "").toMatch(/height:\s*var\(--app-height,\s*100dvh\)/i);
    expect(shellMatch?.[1] || "").toMatch(/min-height:\s*var\(--app-height,\s*100vh\)/i);
  });

  it("floats the mobile composer above the bottom edge and keyboard offset", () => {
    expect(source).toContain("--composer-float-height: 148px;");
    expect(source).toContain("--mobile-bottom-clearance: max(26px, calc(env(safe-area-inset-bottom, 0px) + 14px));");
    expect(source).toContain("body.floating-composer-layout .chatPanel");
    expect(source).toContain("body.floating-composer-layout .composer");
    expect(source).toContain("body.floating-composer-layout .messages");
    expect(source).toMatch(/body\.floating-composer-layout \.chatPanel\s*\{[\s\S]*?bottom:\s*auto/);
    expect(source).toMatch(/body\.floating-composer-layout \.chatPanel\s*\{[\s\S]*?height:\s*calc\(var\(--visual-viewport-height,\s*var\(--app-height,\s*100vh\)\)\s*-\s*16px\)/);
    expect(source).toMatch(/body\.floating-composer-layout \.composer\s*\{[\s\S]*?bottom:\s*var\(--mobile-bottom-clearance,\s*calc\(10px \+ env\(safe-area-inset-bottom, 0px\)\)\)/);
    expect(source).toMatch(/body\.floating-composer-layout \.messages\s*\{[\s\S]*?padding-bottom:\s*calc\(var\(--composer-float-height, 148px\) \+ 20px \+ var\(--mobile-bottom-clearance,\s*env\(safe-area-inset-bottom, 0px\)\)\)/);
  });

  it("uses an edge-to-edge phone layout instead of an inset floating card", () => {
    expect(source).toContain("@media (max-width: 720px) {");
    expect(source).toContain("--mobile-bottom-clearance: max(34px, calc(env(safe-area-inset-bottom, 0px) + 18px));");
    expect(source).toMatch(/@media \(max-width: 720px\)\s*\{[\s\S]*?\.leftPanel \.panelFooter\s*\{[\s\S]*?padding-bottom:\s*max\(32px,\s*calc\(env\(safe-area-inset-bottom, 0px\) \+ 24px\)\)/i);
    expect(source).toMatch(/@media \(max-width: 720px\)\s*\{[\s\S]*?\.shell\s*\{[\s\S]*?padding:\s*0/i);
    expect(source).toMatch(/@media \(max-width: 720px\)\s*\{[\s\S]*?body\.floating-composer-layout \.chatPanel\s*\{[\s\S]*?top:\s*0/i);
    expect(source).toMatch(/@media \(max-width: 720px\)\s*\{[\s\S]*?body\.floating-composer-layout \.chatPanel\s*\{[\s\S]*?left:\s*0/i);
    expect(source).toMatch(/@media \(max-width: 720px\)\s*\{[\s\S]*?body\.floating-composer-layout \.chatPanel\s*\{[\s\S]*?right:\s*0/i);
    expect(source).toMatch(/@media \(max-width: 720px\)\s*\{[\s\S]*?body\.floating-composer-layout \.chatPanel\s*\{[\s\S]*?border-radius:\s*0/i);
    expect(source).toMatch(/@media \(max-width: 720px\)\s*\{[\s\S]*?body\.floating-composer-layout \.composer\s*\{[\s\S]*?padding-inline:\s*10px/i);
  });

  it("attaches the mobile sidebar drawer to the top-left edge instead of floating like a card", () => {
    expect(source).toMatch(/@media \(max-width: 1080px\)\s*\{[\s\S]*?\.leftPanel,\s*[\s\S]*?\.rightPanel\s*\{[\s\S]*?top:\s*0/i);
    expect(source).toMatch(/@media \(max-width: 1080px\)\s*\{[\s\S]*?\.leftPanel,\s*[\s\S]*?\.rightPanel\s*\{[\s\S]*?bottom:\s*0/i);
    expect(source).toMatch(/@media \(max-width: 1080px\)\s*\{[\s\S]*?\.leftPanel\s*\{[\s\S]*?left:\s*0/i);
    expect(source).toMatch(/@media \(max-width: 1080px\)\s*\{[\s\S]*?\.leftPanel\s*\{[\s\S]*?border-radius:\s*0/i);
    expect(source).toMatch(/@media \(max-width: 1080px\)\s*\{[\s\S]*?\.leftPanel,\s*[\s\S]*?\.rightPanel\s*\{[\s\S]*?transition:\s*transform 260ms cubic-bezier\(\.22, \.61, \.36, 1\)/i);
    expect(source).toMatch(/@media \(max-width: 1080px\)\s*\{[\s\S]*?\.leftPanel \.panelFooter\s*\{[\s\S]*?padding-bottom:\s*max\(24px,\s*calc\(env\(safe-area-inset-bottom, 0px\) \+ 18px\)\)/i);
  });

  it("hides the mobile chat scrollbar gutter for a cleaner floating chat surface", () => {
    expect(source).toMatch(/\.messages\s*\{[\s\S]*?scrollbar-gutter:\s*auto/i);
    expect(source).toMatch(/\.messages\s*\{[\s\S]*?scrollbar-width:\s*none/i);
    expect(source).toContain(".messages::-webkit-scrollbar");
  });
});
