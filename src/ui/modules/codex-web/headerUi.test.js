import { describe, expect, it } from "vitest";

import {
  classifyStatusBadge,
  compactModelLabel,
  compareModelRank,
  describeAttachBadge,
  describeWorkspaceConnection,
  parseModelRankParts,
  pickLatestModelId,
} from "./headerUi.js";

describe("headerUi", () => {
  it("compacts gpt prefixes", () => {
    expect(compactModelLabel("gpt-5.3-codex")).toBe("5.3-codex");
    expect(compactModelLabel("claude")).toBe("claude");
  });

  it("prefers latest codex model id", () => {
    expect(
      pickLatestModelId([
        { id: "gpt-5.2-codex" },
        { id: "gpt-5.3-codex" },
        { id: "gpt-5.3-2026-01-01" },
      ])
    ).toBe("gpt-5.3-codex");
  });

  it("orders codex variants ahead of plain models within the same version", () => {
    const ids = [
      "gpt-5.4",
      "gpt-5.4-codex-mini",
      "gpt-5.4-codex",
      "gpt-5.4-codex-max",
    ];
    expect(ids.slice().sort(compareModelRank)).toEqual([
      "gpt-5.4-codex-max",
      "gpt-5.4-codex",
      "gpt-5.4-codex-mini",
      "gpt-5.4",
    ]);
  });

  it("parses dated model ranks", () => {
    expect(parseModelRankParts("gpt-5.2-2025-12-11")).toMatchObject({
      major: 5,
      minor: 2,
      date: 20251211,
    });
  });

  it("treats live activity statuses as connected", () => {
    expect(classifyStatusBadge("Running git commit...")).toEqual({
      label: "Connected",
      warn: false,
    });
    expect(classifyStatusBadge("Receiving response...")).toEqual({
      label: "Connected",
      warn: false,
    });
  });

  it("keeps failure statuses as attention", () => {
    expect(classifyStatusBadge("Command failed: git commit", true)).toEqual({
      label: "Attention",
      warn: true,
    });
  });

  it("describes terminal attach success badge", () => {
    expect(describeAttachBadge({ activeThreadAttachTransport: "terminal-session" })).toEqual({
      visible: true,
      label: "Terminal linked",
      title: "A live terminal session is also linked to this chat.",
    });
    expect(describeAttachBadge({ activeThreadAttachTransport: "" })).toEqual({
      visible: false,
      label: "",
      title: "",
    });
  });

  it("describes workspace connection from canonical runtime state", () => {
    expect(
      describeWorkspaceConnection({
        workspaceRuntimeByTarget: {
          windows: { connected: true, loaded: true, loading: false },
        },
      }, "windows")
    ).toEqual({
      connected: true,
      title: "Connected",
    });
    expect(
      describeWorkspaceConnection({
        workspaceRuntimeByTarget: {
          windows: { connected: false, loaded: true, loading: false },
        },
      }, "windows")
    ).toEqual({
      connected: false,
      title: "Waiting for runtime",
    });
  });
});
