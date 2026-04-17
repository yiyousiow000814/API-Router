import fs from "node:fs";

import { describe, expect, it } from "vitest";

describe("codex-web-dev wiring", () => {
  const source = fs.readFileSync(new URL("./codex-web-dev.js", import.meta.url), "utf8");

  it("does not use Tauri-only bare module imports in browser entry", () => {
    expect(source).not.toContain("@tauri-apps/api/core");
    expect(source).toContain('fetch("/codex/transport/events"');
    expect(source).not.toContain('invoke("record_web_transport_event"');
  });

  it("passes bootstrap-critical UI hooks into composition", () => {
    expect(source).toMatch(
      /from "\.\/modules\/codex-web\/wsClient\.js";[\s\S]*?createCodexWebComposition/s
    );
    expect(source).toMatch(
      /import\s*\{[\s\S]*\bnextReqId\b[\s\S]*\}\s*from "\.\/modules\/codex-web\/wsClient\.js";/s
    );
    expect(source).toContain(
      "updateMobileComposerState: (...args) => updateMobileComposerState(...args),"
    );
    expect(source).toContain(
      "refreshActiveThreadGitMeta: (...args) => refreshActiveThreadGitMeta(...args),"
    );
    expect(source).toContain(
      "syncSettingsControlsFromMain: (...args) => syncSettingsControlsFromMain(...args),"
    );
    expect(source).toContain(
      "updateWelcomeSelections: (...args) => updateWelcomeSelections(...args),"
    );
    expect(source).toContain(
      "windowRef: window,"
    );
    expect(source).toContain(
      "shouldSuppressSyntheticClick,"
    );
    expect(source).toContain(
      "detectThreadWorkspaceTarget,"
    );
    expect(source).toContain(
      "nextFrame,"
    );
    expect(source).toContain(
      "nextReqId,"
    );
    expect(source).toContain(
      "renderMessageAttachments,"
    );
    expect(source).toContain(
      "wireMessageLinks,"
    );
    expect(source).toContain(
      "localStorageRef: localStorage,"
    );
    expect(source).toContain(
      "documentRef: document,"
    );
    expect(source).toContain(
      "requestAnimationFrameRef: requestAnimationFrame,"
    );
    expect(source).toContain(
      "MutationObserverRef: MutationObserver,"
    );
  });
});
