import { describe, expect, it } from "vitest";

import { resolveCodexWebTransportMode } from "./transportMode.js";

describe("transportMode", () => {
  it("defaults Vite dev preview to safe mode", () => {
    expect(
      resolveCodexWebTransportMode({
        importMetaEnv: { DEV: true },
        windowRef: { location: { search: "" } },
      })
    ).toBe("safe");
  });

  it("allows an explicit mock flag for full local simulation", () => {
    expect(
      resolveCodexWebTransportMode({
        importMetaEnv: { DEV: true },
        windowRef: { location: { search: "?mock=1" } },
      })
    ).toBe("mock");
  });

  it("keeps Tauri or explicit live flag on live transport", () => {
    expect(
      resolveCodexWebTransportMode({
        importMetaEnv: { DEV: true },
        windowRef: { location: { search: "?live=1" } },
      })
    ).toBe("live");

    expect(
      resolveCodexWebTransportMode({
        importMetaEnv: { DEV: true },
        windowRef: { location: { search: "" }, __TAURI__: { core: { invoke() {} } } },
      })
    ).toBe("live");
  });
});
